#!/usr/bin/env node
/** macsub — multi-auto-claude-sub CLI. Node ≥22, zero runtime deps. */
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import type { AccountRecord, ActiveState, Vault } from "./types.js";
import { pathsFor } from "./paths.js";
import { createVault } from "./vault/store.js";
import { createActiveState } from "./vault/credentials.js";
import { swap } from "./swap/swap.js";
import { detectLiveSessions } from "./swap/sessions.js";
import { assess } from "./oauth/health.js";
import { OAuthClient } from "./oauth/client.js";
import { refreshWithCas } from "./oauth/health.js";
import { ensureHealthy } from "./pipeline.js";
import { discoverBase } from "./cdp/connection.js";
import { log } from "./util/log.js";

const execFileP = promisify(execFile);

const HELP = `macsub — switch between multiple Claude Code subscription accounts, with auto-login on swap

Usage:
  macsub add <name> [--session-key <sk-ant-…>]   vault the CURRENT Claude Code login under <name>
  macsub ls                                      list vaulted accounts with token expiry
  macsub current                                 show the active account + live login email
  macsub swap <name>   (alias: use)              swap accounts, then auto-heal tokens if stale
  macsub rm <name>                               remove an account from the vault
  macsub refresh [name]                          refresh tokens (L1) for account (default: active)
  macsub login <name> [--store-password]         force re-login: saved web session, then browser agent
  macsub doctor                                  check config paths, keychain, locks, Chrome debug port

Exit codes: 0 ok · 2 warnings only · 1 failure

Auto-login ladder: valid token → refresh token → saved claude.ai web session (headless)
→ CDP browser agent in a background tab (needs Chrome with --remote-debugging-port; see
macsub doctor). Password autofill only when stored via: macsub login <name> --store-password`;

function usage(msg?: string): never {
  if (msg) log.err(msg);
  console.log(HELP);
  process.exit(1);
}

function fmtExpiry(ms: number | undefined): string {
  if (typeof ms !== "number") return "?";
  const days = Math.floor((ms - Date.now()) / 86_400_000);
  if (days > 0) return `${days}d`;
  const h = Math.floor((ms - Date.now()) / 3_600_000);
  return h > 0 ? `${h}h` : "expired";
}

function accountRow(rec: AccountRecord, activeName: string | null): string[] {
  const a = assess(rec.credential);
  const oauth = rec.credential.claudeAiOauth;
  const web = rec.webSession ? (rec.webSession.stale ? "stale" : "saved") : "—";
  return [
    rec.name === activeName ? `${rec.name} *` : rec.name,
    rec.oauthAccount.emailAddress,
    a.level,
    fmtExpiry(oauth.expiresAt),
    fmtExpiry(oauth.refreshTokenExpiresAt),
    web,
  ];
}

function printTable(rows: string[][], header: string[]): void {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  console.log(line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(r));
}

async function readStoredPassword(name: string): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  try {
    const { stdout } = await execFileP("security", ["find-generic-password", "-s", "macsub-password", "-a", name, "-w"]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function promptPassword(name: string): Promise<string | undefined> {
  const rl = createInterface({
    input: process.stdin,
    output: new Writable({ write: (_c: unknown, _e: unknown, cb: (err?: Error | null) => void) => cb() }),
    terminal: true,
  });
  try {
    const pw = await rl.question(`password for ${name} (input hidden, stored in macOS Keychain): `);
    return pw.trim() || undefined;
  } finally {
    rl.close();
  }
}

async function requireAccount(vault: Vault, name: string): Promise<AccountRecord> {
  const rec = await vault.get(name);
  if (rec === null) {
    const names = (await vault.list()).map((r) => r.name).join(", ") || "(vault is empty)";
    usage(`unknown account "${name}". Vaulted: ${names}`);
  }
  return rec;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(HELP);
    return 0;
  }

  const vault: Vault = createVault();
  const active: ActiveState = createActiveState();

  switch (cmd) {
    case "add": {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { "session-key": { type: "string" } },
        allowPositionals: true,
      });
      const name = positionals[0];
      if (!name) usage("macsub add <name>");
      const cred = await active.readCredential();
      if (cred === null) usage("no Claude Code login found — run `claude login` first, then `macsub add <name>`");
      const identity = await active.readOauthAccount();
      const rec: AccountRecord = {
        name,
        credential: cred,
        oauthAccount:
          identity ?? { emailAddress: "(unknown)", accountUuid: "", organizationUuid: "" },
        savedAt: Date.now(),
        ...(values["session-key"]
          ? { webSession: { sessionKey: String(values["session-key"]), savedAt: Date.now() } }
          : {}),
      };
      await vault.save(rec);
      await vault.setActive(name);
      log.info(`vaulted "${name}" (${rec.oauthAccount.emailAddress})`);
      if (!rec.webSession) {
        log.info(`tip: save the claude.ai session cookie to enable headless re-login:\n` +
          `    macsub rm ${name} && claude login (as this account) … or edit ~/.macsub/accounts/${name}.json —\n` +
          `    see README "Web session capture"`);
      }
      return 0;
    }

    case "ls": {
      const recs = await vault.list();
      if (recs.length === 0) {
        log.info("vault is empty — `macsub add <name>` after logging in with Claude Code");
        return 0;
      }
      const activeName = await vault.activeAccount();
      printTable(
        recs.map((r) => accountRow(r, activeName)),
        ["account", "email", "tokens", "access", "refresh", "web"],
      );
      return 0;
    }

    case "current": {
      const activeName = await vault.activeAccount();
      const identity = await active.readOauthAccount();
      if (identity) log.info(`live login: ${identity.emailAddress}`);
      else log.info("live login: none found");
      log.info(`vault active account: ${activeName ?? "(none)"}`);
      return identity || activeName ? 0 : 1;
    }

    case "swap":
    case "use": {
      const name = rest[0];
      if (!name) usage(`macsub ${cmd} <name>`);
      await requireAccount(vault, name);
      const result = await swap(vault, active, name, { detectSessions: detectLiveSessions });
      for (const w of result.warnings) log.warn(w);
      if (result.outcome === "failed-unknown-account") usage(`unknown account "${name}"`);
      if (result.outcome.startsWith("failed")) {
        log.err(`swap failed: ${result.outcome}${result.detail ? ` — ${result.detail}` : ""}`);
        return 1;
      }
      log.info(`swapped ${result.from ?? "(none)"} → ${result.to}`);
      log.step("checking token health…");
      const health = await ensureHealthy(vault, active, name, { onNotify: (m) => log.warn(m) });
      if (health.level === "fresh") log.info("tokens valid");
      else if (health.level === "refreshed") log.info("tokens refreshed and installed");
      else {
        log.warn(`auto-login did not complete (${health.level})${health.detail ? `: ${health.detail}` : ""}`);
        return result.warnings.length > 0 ? 2 : 1;
      }
      return result.warnings.length > 0 ? 2 : 0;
    }

    case "rm": {
      const name = rest[0];
      if (!name) usage("macsub rm <name>");
      await requireAccount(vault, name);
      await vault.remove(name);
      log.info(`removed "${name}"`);
      return 0;
    }

    case "refresh": {
      const name = rest[0] ?? (await vault.activeAccount());
      if (!name) usage("no active account — `macsub refresh <name>`");
      await requireAccount(vault, name);
      const result = await refreshWithCas(vault, name, new OAuthClient());
      if (result.level === "fresh") log.info("tokens already valid");
      else if (result.level === "refreshed") {
        log.info("refreshed");
        if (result.credential && (await vault.activeAccount()) === name) {
          const rec = await requireAccount(vault, name);
          const { installFreshCredential } = await import("./swap/swap.js");
          await installFreshCredential(active, { ...rec, credential: result.credential });
          log.info("installed into live state");
        }
      } else {
        log.err(`refresh failed (${result.level})${result.detail ? `: ${result.detail}` : ""} — try: macsub login ${name}`);
        return 1;
      }
      return 0;
    }

    case "login": {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { "store-password": { type: "boolean" } },
        allowPositionals: true,
      });
      const name = positionals[0];
      if (!name) usage("macsub login <name>");
      const rec = await requireAccount(vault, name);
      let password = await readStoredPassword(name);
      if (values["store-password"]) {
        if (process.platform !== "darwin") usage("--store-password is macOS-only (Keychain)");
        const pw = await promptPassword(name);
        if (pw) {
          await execFileP("security", ["add-generic-password", "-U", "-s", "macsub-password", "-a", name, "-w", pw]);
          password = pw;
          log.info("password stored in Keychain");
        }
      }
      const result = await ensureHealthy(vault, active, name, {
        force: true,
        ...(password !== undefined ? { password } : {}),
        onNotify: (m) => log.warn(m),
      });
      if (result.level === "refreshed") {
        log.info(`re-logged-in ${rec.oauthAccount.emailAddress} and installed`);
        return 0;
      }
      log.err(`login failed (${result.level})${result.detail ? `: ${result.detail}` : ""}`);
      return 1;
    }

    case "doctor": {
      const p = pathsFor();
      log.info(`platform: ${process.platform}`);
      log.info(`vault:      ${p.macsubHome}`);
      log.info(`config dir: ${p.configDir}`);
      log.info(`credentials:${p.credentialsFile}`);
      log.info(`claude.json:${p.claudeJson}`);
      const cred = await active.readCredential();
      if (cred) {
        const a = assess(cred);
        log.info(`live credentials: present (${a.level}, access ${fmtExpiry(cred.claudeAiOauth.expiresAt)}, refresh ${fmtExpiry(cred.claudeAiOauth.refreshTokenExpiresAt)})`);
      } else {
        log.warn("live credentials: NOT found");
      }
      for (const [label, lk] of [["oauth refresh lock", p.oauthRefreshLock], ["claude.lock", p.claudeLock], ["config lock", p.claudeJsonLock]] as const) {
        log.info(`${label}: ${existsSync(lk) ? "PRESENT (claude running?)" : "free"}`);
      }
      const base = await discoverBase();
      if (base) log.info(`Chrome debug endpoint: ${base} (browser agent ready)`);
      else log.warn("Chrome debug endpoint: none found — start Chrome with --remote-debugging-port for the login agent ($CDP_BASE overrides)");
      const recs = await vault.list();
      if (recs.length > 0) {
        const activeName = await vault.activeAccount();
        printTable(recs.map((r) => accountRow(r, activeName)), ["account", "email", "tokens", "access", "refresh", "web"]);
      }
      return 0;
    }

    default:
      usage(`unknown command "${cmd}"`);
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log.err(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
