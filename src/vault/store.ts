/** Vault: AccountRecord files under <macsubHome>/accounts/<slug>.json (0600,
 * dir 0700) plus config.json {"activeAccount": ...}. Atomic writes via
 * tmp+rename. */

import { chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { AccountRecord, Vault } from "../types.js";
import { pathsFor } from "../paths.js";

/** Atomic write: tmp file (mode `mode`) in the same dir, then rename over the
 *  target. chmod ensures the mode even if the tmp name is reused. */
export async function writeFileAtomic(path: string, data: string, mode: number = 0o600): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`);
  await writeFile(tmp, data, { mode });
  await chmod(tmp, mode);
  await rename(tmp, path);
}

export interface VaultOptions {
  env?: NodeJS.ProcessEnv;
  /** explicit vault home (tests use a tmp dir); default pathsFor(env).macsubHome */
  home?: string;
}

export function createVault(opts: VaultOptions = {}): Vault {
  return new FileVault(opts.home ?? pathsFor(opts.env ?? process.env).macsubHome);
}

function slugify(name: string): string {
  const s = name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^\.+/, "");
  return s.length > 0 ? s : "account";
}

class FileVault implements Vault {
  constructor(private readonly home: string) {}

  private get accountsDir(): string {
    return join(this.home, "accounts");
  }

  private async ensureHome(): Promise<void> {
    await mkdir(this.home, { recursive: true });
    await chmod(this.home, 0o700);
  }

  private async ensureAccounts(): Promise<void> {
    await this.ensureHome();
    await mkdir(this.accountsDir, { recursive: true });
    await chmod(this.accountsDir, 0o700);
  }

  async list(): Promise<AccountRecord[]> {
    let files: string[];
    try {
      files = await readdir(this.accountsDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw e;
    }
    const recs: AccountRecord[] = [];
    for (const f of files) {
      if (!f.endsWith(".json") || f.includes(".tmp")) continue;
      try {
        recs.push(JSON.parse(await readFile(join(this.accountsDir, f), "utf8")) as AccountRecord);
      } catch {
        // skip unparseable files rather than fail the whole listing
      }
    }
    recs.sort((a, b) => a.name.localeCompare(b.name));
    return recs;
  }

  async get(name: string): Promise<AccountRecord | null> {
    const recs = await this.list();
    return recs.find((r) => r.name === name) ?? null;
  }

  async save(rec: AccountRecord): Promise<void> {
    await this.ensureAccounts();
    await writeFileAtomic(
      join(this.accountsDir, `${slugify(rec.name)}.json`),
      JSON.stringify(rec, null, 2) + "\n",
      0o600,
    );
  }

  async remove(name: string): Promise<void> {
    const rec = await this.get(name);
    if (!rec) throw new Error(`no vaulted account named "${name}"`);
    await unlink(join(this.accountsDir, `${slugify(name)}.json`));
  }

  async activeAccount(): Promise<string | null> {
    let raw: string;
    try {
      raw = await readFile(join(this.home, "config.json"), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw e;
    }
    const obj = JSON.parse(raw) as { activeAccount?: string | null };
    return obj.activeAccount ?? null;
  }

  async setActive(name: string | null): Promise<void> {
    await updateVaultConfig({ activeAccount: name }, this.home);
  }
}

export type SwapMode = "toggle" | "best";

export interface VaultConfig {
  activeAccount?: string | null;
  /** what a bare `macsub swap` does (default toggle) */
  swapMode?: SwapMode;
  [k: string]: unknown;
}

export async function readVaultConfig(home: string = pathsFor().macsubHome): Promise<VaultConfig> {
  try {
    const obj: unknown = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
    return typeof obj === "object" && obj !== null && !Array.isArray(obj) ? (obj as VaultConfig) : {};
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    throw e;
  }
}

/** read-modify-write: keys not in `patch` are kept */
export async function updateVaultConfig(patch: VaultConfig, home: string = pathsFor().macsubHome): Promise<void> {
  await mkdir(home, { recursive: true });
  await chmod(home, 0o700);
  const cur = await readVaultConfig(home);
  await writeFileAtomic(join(home, "config.json"), JSON.stringify({ ...cur, ...patch }, null, 2) + "\n", 0o600);
}
