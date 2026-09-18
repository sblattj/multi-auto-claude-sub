/** Live "logged in as" state that Claude Code itself reads/writes (SPEC §1).
 *
 * macOS: keychain generic password (service "Claude Code-credentials") is
 * authoritative, written delete-all-then-add; ~/.claude/.credentials.json is a
 * 0600 mirror. Other platforms: the file is authoritative. The oauthAccount
 * identity key of .claude.json is always merged read-modify-write, never
 * wholesale-replaced. */

import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ActiveState, CredentialBlob, OauthAccount } from "../types.js";
import { pathsFor } from "../paths.js";
import { writeFileAtomic } from "./store.js";
import { withConfigLock } from "../swap/locks.js";

const execFileP = promisify(execFile);

export const DEFAULT_KEYCHAIN_SERVICE = "Claude Code-credentials";

export interface ActiveStateOptions {
  env?: NodeJS.ProcessEnv;
  /** keychain service name; tests MUST use "macsub-test-credentials" */
  keychainService?: string;
  /** override config dir (default: $CLAUDE_CONFIG_DIR or ~/.claude) */
  configDir?: string;
  /** override .claude.json path (default: resolved incl. legacy probe) */
  claudeJsonPath?: string;
  /** force the platform branch (tests exercise the file path on macOS) */
  platform?: NodeJS.Platform;
}

export function createActiveState(opts: ActiveStateOptions = {}): ActiveState {
  const env = opts.env ?? process.env;
  const p = pathsFor(env);
  const service = opts.keychainService ?? DEFAULT_KEYCHAIN_SERVICE;
  const credentialsFile = opts.configDir ? join(opts.configDir, ".credentials.json") : p.credentialsFile;
  const claudeJsonPath = opts.claudeJsonPath ?? p.claudeJson;
  return new PlatformActiveState(
    opts.platform ?? process.platform,
    service,
    credentialsFile,
    claudeJsonPath,
    env,
  );
}

class PlatformActiveState implements ActiveState {
  constructor(
    private readonly plat: NodeJS.Platform,
    private readonly service: string,
    private readonly credentialsFile: string,
    private readonly claudeJsonPath: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  platform(): NodeJS.Platform {
    return this.plat;
  }

  async readCredential(): Promise<CredentialBlob | null> {
    if (this.plat === "darwin") {
      let stdout: string;
      try {
        stdout = (await execFileP("security", ["find-generic-password", "-s", this.service, "-w"])).stdout;
      } catch (e) {
        if (isNotFound(e)) return null;
        throw new Error(`keychain read failed for service "${this.service}" (${errSummary(e)})`);
      }
      return parseCredentialBlob(stdout.trim());
    }
    let raw: string;
    try {
      raw = await readFile(this.credentialsFile, "utf8");
    } catch (e) {
      if (isEnoent(e)) return null;
      throw e;
    }
    return parseCredentialBlob(raw);
  }

  async writeCredential(blob: CredentialBlob): Promise<void> {
    const json = JSON.stringify(blob);
    if (this.plat === "darwin") {
      await this.keychainDeleteAll();
      try {
        await execFileP("security", [
          "add-generic-password",
          "-U",
          "-s",
          this.service,
          "-a",
          userInfo().username,
          "-w",
          json,
        ]);
      } catch (e) {
        throw new Error(`keychain write failed for service "${this.service}" (${errSummary(e)})`);
      }
    }
    // mirror (darwin) / authoritative (linux, windows)
    const dir = dirname(this.credentialsFile);
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o700).catch(() => undefined);
    await writeFileAtomic(this.credentialsFile, json, 0o600);
  }

  /** `claude auth logout` leaves duplicate items; delete in a loop until the
   *  find/delete errors with not-found. */
  private async keychainDeleteAll(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      try {
        await execFileP("security", ["delete-generic-password", "-s", this.service]);
      } catch (e) {
        if (isNotFound(e)) return;
        throw new Error(`keychain delete failed for service "${this.service}" (${errSummary(e)})`);
      }
    }
    throw new Error(`keychain delete loop did not terminate for service "${this.service}"`);
  }

  async readOauthAccount(): Promise<OauthAccount | null> {
    const obj = await this.readClaudeJson();
    const acc = (obj as { oauthAccount?: unknown }).oauthAccount;
    return typeof acc === "object" && acc !== null ? (acc as OauthAccount) : null;
  }

  async mergeOauthAccount(acc: OauthAccount): Promise<void> {
    await withConfigLock(
      async () => {
        let raw: string | null = null;
        try {
          raw = await readFile(this.claudeJsonPath, "utf8");
        } catch (e) {
          if (!isEnoent(e)) throw e;
        }
        const obj: Record<string, unknown> = raw !== null ? (JSON.parse(raw) as Record<string, unknown>) : {};
        obj.oauthAccount = acc;
        let mode = 0o600;
        if (raw !== null) {
          try {
            mode = (await stat(this.claudeJsonPath)).mode & 0o777;
          } catch {
            // keep 0600 default
          }
        }
        const dir = dirname(this.claudeJsonPath);
        await mkdir(dir, { recursive: true });
        await writeFileAtomic(this.claudeJsonPath, JSON.stringify(obj, null, 2) + "\n", mode);
      },
      { env: this.env, claudeJsonPath: this.claudeJsonPath },
    );
  }

  private async readClaudeJson(): Promise<Record<string, unknown>> {
    let raw: string;
    try {
      raw = await readFile(this.claudeJsonPath, "utf8");
    } catch (e) {
      if (isEnoent(e)) return {};
      throw e;
    }
    return JSON.parse(raw) as Record<string, unknown>;
  }
}

function parseCredentialBlob(raw: string): CredentialBlob {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error("credential blob is not valid JSON");
  }
  const oauth = (obj as { claudeAiOauth?: { accessToken?: unknown } }).claudeAiOauth;
  if (typeof oauth?.accessToken === "string") return obj as CredentialBlob;
  throw new Error("credential blob missing claudeAiOauth.accessToken");
}

/** security exits 44 with "could not be found" when the item is absent. */
function isNotFound(e: unknown): boolean {
  const err = e as { code?: number | string; stderr?: string };
  return err?.code === 44 || /could not be found/i.test(err?.stderr ?? "");
}

function isEnoent(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Exit code only — stderr/stdout may embed secrets and must never surface. */
function errSummary(e: unknown): string {
  const err = e as { code?: number | string };
  return err?.code !== undefined ? `exit ${err.code}` : "unknown error";
}
