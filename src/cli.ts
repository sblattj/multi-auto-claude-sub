#!/usr/bin/env node
/** macsub — multi-auto-claude-sub CLI. Node ≥22, zero runtime deps. */
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AccountRecord, ActiveState, Vault } from "./types.js";
import { pathsFor } from "./paths.js";
import { createVault, readVaultConfig, updateVaultConfig, type SwapMode } from "./vault/store.js";
import { createActiveState } from "./vault/credentials.js";
import { swap } from "./swap/swap.js";
import { detectLiveSessions } from "./swap/sessions.js";
import { assess } from "./oauth/health.js";
import { OAuthClient } from "./oauth/client.js";
import { ensureHealthy, refreshAccount } from "./pipeline.js";
import { discoverBase } from "./cdp/connection.js";
import { log } from "./util/log.js";
import { describeError, systemCaStatus, trustSystemCAs, TLS_TRUST_HINT } from "./util/net.js";
import { TOKEN_URL } from "./oauth/client.js";
import { USAGE_URL } from "./usage/usage.js";
import { collectUsage, readUsageCache, type AccountUsage } from "./usage/collect.js";
import { pickBest, rankAccounts, type Ranked } from "./usage/rank.js";
import { explainPick, fmtAge, fmtDetails, fmtReset, fmtWindow } from "./usage/format.js";
import { autoBest, DEFAULT_AUTO_TIMEOUT_MS, type AutoResult } from "./auto.js";
import { needsRefresh, renderStatusline, spawnBackgroundRefresh } from "./usage/statusline.js";
import { parseDuration } from "./util/duration.js";

const execFileP = promisify(execFile);

const HELP = `macsub — switch between multiple Claude Code subscription accounts, with auto-login on swap

Usage:
  macsub add <name> [--session-key <sk-ant-…>]   vault the CURRENT Claude Code login under <name>
  macsub ls                                      list vaulted accounts: token expiry + usage
  macsub usage [--json]                          5-hour and weekly usage for every account, and
                                                 which one is best to use right now
  macsub current                                 show the active account + live login email
  macsub swap [name]     (alias: use)            switch accounts; with no name: the mode's pick
  macsub swap --best     (alias: best)           switch to the best account by usage (see below)
  macsub swap --toggle                           with exactly two accounts, switch to the other one
  macsub mode [toggle|best]                      show or set what a bare \`macsub swap\` does
                                                 (default toggle)
  macsub best --auto [--max-age 5m] [--timeout 4s]
                                                 unattended best swap for a \`claude\` launcher:
                                                 silent unless it swaps, never opens a browser
  macsub on-limit                                Claude Code StopFailure hook (rate_limit):
                                                 swap to the best account and notify
  macsub statusline                              status-line segment from cached usage (no network)
  macsub rm <name>                               remove an account from the vault
  macsub rename <old> <new>                      rename a vaulted account
  macsub refresh [name]                          refresh tokens (L1) for account (default: active)
  macsub login <name> [--store-password]         force re-login: saved web session, then browser agent
  macsub doctor                                  check config paths, keychain, locks, Chrome debug port

Exit codes: 0 ok · 2 warnings only · 1 failure

Best account: weekly allowance is use-it-or-lose-it, so the pick is the account whose
unused allowance expires fastest (weekly % left ÷ hours until it resets). Accounts at a
limit are skipped and a nearly spent 5-hour window counts against an account.
E.g. A 90% used, resets in 7d vs B 10% used, resets in 1d → B.

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

const ACCOUNT_HEADER = ["account", "email", "tokens", "access", "refresh", "web"];

function accountRow(rec: AccountRecord, activeName: string | null): string[] {
  const a = assess(rec.credential);
  const oauth = rec.credential.claudeAiOauth;
  const web = rec.webSession ? (rec.webSession.stale ? "stale" : "saved") : "-";
  return [
    rec.name === activeName ? `${rec.name} *` : rec.name,
    rec.oauthAccount.emailAddress,
    a.level,
    fmtExpiry(oauth.expiresAt),
    fmtExpiry(oauth.refreshTokenExpiresAt),
    web,
  ];
}

/** "62%" / "90% (6d 23h)", "*" marking a cached reading */
function usageCells(u: AccountUsage | undefined, now: number): string[] {
  if (!u?.usage) return ["-", "-"];
  const mark = u.cached ? "*" : "";
  const pct = (p: number | undefined) => (p === undefined ? "-" : `${Math.round(p)}%${mark}`);
  const week = u.usage.weekly;
  return [pct(u.usage.session?.pct), week ? `${pct(week.pct)} (${fmtReset(week, now)})` : "-"];
}

/** Why a reading is cached or missing, one line per affected account. */
function cachedFootnote(usages: AccountUsage[], now: number): string[] {
  return usages.flatMap((u) => {
    if (u.cached && u.usage) return [`* ${u.name}: cached ${fmtAge(now - u.usage.fetchedAt)} (${u.error ?? "live read failed"})`];
    if (!u.usage && u.error) return [`${u.name}: usage unavailable (${u.error})`];
    return [];
  });
}

function printUsageTable(usages: AccountUsage[], activeName: string | null, best: Ranked | undefined, now: number): void {
  const rows = usages.map((u) => {
    const s = u.usage?.session;
    const w = u.usage?.weekly;
    const asOf = !u.usage ? "-" : u.cached ? `${fmtAge(now - u.usage.fetchedAt)}*` : "live";
    return [
      u.name === activeName ? `${u.name} *` : u.name,
      u.email,
      fmtWindow(s),
      fmtReset(s, now),
      fmtWindow(w),
      fmtReset(w, now),
      asOf,
      best?.name === u.name ? "← best" : "",
    ];
  });
  printTable(rows, ["account", "email", "5h session", "resets", "weekly", "resets", "as of", ""]);
  for (const u of usages) {
    const details = u.usage ? fmtDetails(u.usage) : "";
    if (details) log.info(`${u.name}: ${details}`);
  }
  for (const f of cachedFootnote(usages, now)) log.info(f);
}

interface BestPick {
  usages: AccountUsage[];
  ranked: Ranked[];
  best: Ranked | undefined;
}

async function findBest(vault: Vault, active: ActiveState): Promise<BestPick> {
  const usages = await collectUsage(vault, active, { refresh: true });
  const ranked = rankAccounts(usages);
  return { usages, ranked, best: pickBest(ranked, await vault.activeAccount()) };
}

function printTable(rows: string[][], header: string[]): void {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  console.log(line(header));
  console.log(widths.map((w, i) => (header[i] ? "-" : " ").repeat(w)).join("  ").trimEnd());
  for (const r of rows) console.log(line(r));
}

function describeCaStatus(): string {
  const ca = systemCaStatus();
  switch (ca?.mode) {
    case "added":
      return `trusting ${ca.count} extra root(s) from the OS certificate store (TLS-inspecting proxy?)`;
    case "none-needed":
      return "Node's bundled roots (the OS store adds nothing)";
    case "disabled":
      return "OS certificate store disabled by MACSUB_SYSTEM_CA=0";
    case "failed":
      return `couldn't load the OS certificate store: ${ca.detail}`;
    default:
      return `this Node (${process.version}) can't load the OS certificate store; if requests fail with a certificate error: ${TLS_TRUST_HINT}`;
  }
}

/** After a swap: where both accounts stand, plus a nudge when toggling
 *  landed on the worse one. Never fails the swap. */
async function printSwapUsage(vault: Vault, active: ActiveState, name: string, pick: BestPick | undefined): Promise<void> {
  try {
    // after a toggle, don't refresh the outgoing account: sessions still running
    // on it hold its refresh token
    const usages = pick?.usages ?? (await collectUsage(vault, active, { refresh: false }));
    const now = Date.now();
    for (const u of usages) {
      const s = u.usage?.session;
      const w = u.usage?.weekly;
      const mark = u.cached ? "*" : "";
      const text = u.usage
        ? `5h ${s ? `${Math.round(s.pct)}%${mark} (resets ${fmtReset(s, now)})` : "-"} · weekly ${w ? `${Math.round(w.pct)}%${mark} (resets ${fmtReset(w, now)})` : "-"}`
        : "usage unavailable";
      log.info(`${u.name === name ? "→" : " "} ${u.name}: ${text}`);
    }
    for (const f of cachedFootnote(usages, now)) log.info(f);
    if (!pick) {
      const best = pickBest(rankAccounts(usages, now), name);
      if (best && best.name !== name) log.info(`tip: ${best.name} looks better right now; macsub swap --best`);
    }
  } catch {
    /* usage is informational */
  }
}

/** Hook payload on stdin (Claude Code pipes JSON); undefined for a TTY, bad JSON or a slow pipe. */
async function readStdinJson(timeoutMs: number): Promise<Record<string, unknown> | undefined> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  const read = new Promise<void>((resolve) => {
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve());
    process.stdin.on("error", () => resolve());
  });
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([read, new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))]);
  clearTimeout(timer);
  process.stdin.pause();
  try {
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function limitNotice(r: AutoResult): [string, string] {
  switch (r.action) {
    case "swapped":
      return [`macsub: switched to ${r.to}`, `Rate limit hit on ${r.from ?? "the old account"}. ${r.to}: ${r.reason}. Resume with: claude --continue`];
    case "kept":
      return [`macsub: staying on ${r.from}`, `Rate limit hit, but ${r.reason}.`];
    default:
      return ["macsub: no switch", `Rate limit hit; ${r.reason}.`];
  }
}

/** macOS notification (text passed as argv, never interpolated into AppleScript); stderr elsewhere. */
async function notify(title: string, body: string): Promise<void> {
  if (process.platform === "darwin") {
    try {
      await execFileP("osascript", [
        "-e",
        "on run argv",
        "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e",
        "end run",
        title,
        body,
      ]);
      return;
    } catch {
      /* fall through */
    }
  }
  process.stderr.write(`${title}: ${body}\n`);
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

  // before any request: TLS-inspecting proxies need the OS certificate store.
  // The status line never makes one, and it renders often.
  if (cmd !== "statusline") trustSystemCAs();
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
      if (cred === null) usage("no Claude Code login found — run `claude auth login` first, then `macsub add <name>`");
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
          `    macsub rm ${name} && claude auth login (as this account) … or edit ~/.macsub/accounts/${name}.json —\n` +
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
      const now = Date.now();
      // live usage where the access token is still valid, cached otherwise;
      // ls never refreshes tokens
      const usages = await collectUsage(vault, active, { refresh: false }).catch((): AccountUsage[] => []);
      const byName = new Map(usages.map((u) => [u.name, u]));
      printTable(
        recs.map((r) => [...accountRow(r, activeName), ...usageCells(byName.get(r.name), now)]),
        [...ACCOUNT_HEADER, "5h", "weekly"],
      );
      for (const f of cachedFootnote(usages, now)) log.info(f);
      return 0;
    }

    case "usage": {
      const { values } = parseArgs({
        args: rest,
        options: { json: { type: "boolean" }, "refresh-cache": { type: "boolean" } },
      });
      if (values["refresh-cache"]) {
        // the status line's detached refresher: no token refreshes, no output
        await collectUsage(vault, active, { refresh: false }).catch(() => []);
        return 0;
      }
      const usages = await collectUsage(vault, active, { refresh: true });
      const now = Date.now();
      const activeName = await vault.activeAccount();
      const ranked = rankAccounts(usages, now);
      const best = pickBest(ranked, activeName);
      const degraded = usages.some((u) => !u.usage || u.cached);
      if (values.json) {
        const accounts = usages.map((u) => ({ ...u, active: u.name === activeName, rank: ranked.find((r) => r.name === u.name) }));
        console.log(JSON.stringify({ best: best?.name ?? null, accounts }, null, 2));
        return degraded ? 2 : 0;
      }
      if (usages.length === 0) {
        log.info("vault is empty: `macsub add <name>` after logging in with Claude Code");
        return 0;
      }
      printUsageTable(usages, activeName, best, now);
      const [head, ...rest2] = explainPick(best, ranked, now);
      log.step(head!);
      for (const l of rest2) log.info(l);
      if (best && best.name !== activeName) log.info("switch with: macsub swap --best");
      return degraded ? 2 : 0;
    }

    case "on-limit": {
      const payload = await readStdinJson(1_000);
      const error = typeof payload?.error === "string" ? payload.error : undefined;
      if (error !== undefined && error !== "rate_limit") return 0;
      const r = await autoBest(vault, active, { trigger: "limit", timeoutMs: 8_000 });
      if (!r.busy) await notify(...limitNotice(r));
      return 0;
    }

    case "statusline": {
      try {
        const p = pathsFor();
        const [recs, activeName, cache] = await Promise.all([vault.list(), vault.activeAccount(), readUsageCache(p.usageCacheFile)]);
        const names = recs.map((r) => r.name);
        const now = Date.now();
        process.stdout.write(renderStatusline({ names, activeName, cache, now, color: !process.env.NO_COLOR }));
        if (names.length > 0 && needsRefresh(names, cache, now)) {
          await spawnBackgroundRefresh(join(p.macsubHome, ".usage-refresh"), now);
        }
      } catch {
        /* a status line prints nothing rather than an error */
      }
      return 0;
    }

    case "mode": {
      const m = rest[0];
      if (!m) {
        log.info(`bare \`macsub swap\` mode: ${(await readVaultConfig()).swapMode ?? "toggle"}`);
        return 0;
      }
      if (m !== "toggle" && m !== "best") usage("macsub mode [toggle|best]");
      await updateVaultConfig({ swapMode: m satisfies SwapMode });
      log.info(
        m === "best"
          ? "bare `macsub swap` now switches to the best account by usage"
          : "bare `macsub swap` now toggles between two accounts",
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
    case "use":
    case "best": {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          best: { type: "boolean" },
          toggle: { type: "boolean" },
          auto: { type: "boolean" },
          "max-age": { type: "string" },
          timeout: { type: "string" },
        },
        allowPositionals: true,
      });
      let name = positionals[0];
      let wantBest = cmd === "best" || values.best === true || values.auto === true;
      if (wantBest && values.toggle) usage("--best/--auto and --toggle don't mix");
      if (name && (wantBest || values.toggle)) usage("name an account or pass --best/--toggle, not both");
      if (values.auto) {
        const r = await autoBest(vault, active, {
          trigger: "auto",
          maxAgeMs: parseDuration(values["max-age"] ?? "5m"),
          timeoutMs: values.timeout !== undefined ? parseDuration(values.timeout) : DEFAULT_AUTO_TIMEOUT_MS,
        });
        if (r.action === "swapped") {
          process.stderr.write(`macsub: switched ${r.from ?? "(none)"} → ${r.to}: ${r.reason}. Sessions already running keep their account.\n`);
        }
        return 0; // a launcher must never fail because of this
      }
      if (!name && !wantBest && !values.toggle) wantBest = (await readVaultConfig()).swapMode === "best";
      let pick: BestPick | undefined;
      if (wantBest) {
        log.step("reading usage for every account…");
        pick = await findBest(vault, active);
        const now = Date.now();
        for (const l of explainPick(pick.best, pick.ranked, now)) log.info(l);
        for (const f of cachedFootnote(pick.usages, now)) log.info(f);
        if (!pick.best) {
          log.err("can't pick without usage data; see: macsub usage");
          return 1;
        }
        if (pick.best.name === (await vault.activeAccount())) {
          log.info(`already on ${pick.best.name}, nothing to swap`);
          return 0;
        }
        name = pick.best.name;
      } else if (!name) {
        const { resolveToggle } = await import("./swap/toggle.js");
        name = (await resolveToggle(vault, active)).to;
      }
      await requireAccount(vault, name);
      // Refresh the target while it is only in the vault: once installed, running
      // Claude Code sessions see an expired token and race to refresh it.
      // Best effort: the post-swap ladder retries and reports any failure.
      try {
        const pre = await refreshAccount(vault, active, name, new OAuthClient());
        if (pre.level === "refreshed") log.info(`refreshed ${name} tokens before install`);
      } catch {
        /* fall through to the swap */
      }
      const result = await swap(vault, active, name, { detectSessions: detectLiveSessions });
      const pidWarnings = result.warnings.filter((w) => w.includes("(pid "));
      const otherWarnings = result.warnings.filter((w) => !w.includes("(pid "));
      if (pidWarnings.length === 1) log.warn(pidWarnings[0]!);
      else if (pidWarnings.length > 1) {
        const pids = pidWarnings.flatMap((w) => [...w.matchAll(/\(pid (\d+)\)/g)].map((m) => m[1]!));
        log.warn(
          `${pidWarnings.length} live Claude Code sessions may hold the outgoing account in memory (pids ${pids.join(", ")}) — they are never killed; restart them to pick up the swap`,
        );
      }
      for (const w of otherWarnings) log.warn(w);
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
      await printSwapUsage(vault, active, name, pick);
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

    case "rename": {
      const [from, to] = rest;
      if (!from || !to) usage("macsub rename <old> <new>");
      const { renameAccount } = await import("./vault/rename.js");
      await renameAccount(vault, from, to);
      log.info(`renamed ${from} → ${to}`);
      return 0;
    }

    case "refresh": {
      const name = rest[0] ?? (await vault.activeAccount());
      if (!name) usage("no active account — `macsub refresh <name>`");
      await requireAccount(vault, name);
      const result = await refreshAccount(vault, active, name, new OAuthClient());
      if (result.level === "fresh") log.info(result.detail ?? "tokens already valid");
      else if (result.level === "refreshed") {
        log.info("refreshed");
        if ((await vault.activeAccount()) === name) log.info("installed into live state");
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
      log.info(`TLS trust: ${describeCaStatus()}`);
      for (const url of [TOKEN_URL, USAGE_URL]) {
        const host = new URL(url).host;
        try {
          const r = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(8_000) });
          log.info(`network: ${host} reachable (HTTP ${r.status})`);
        } catch (err) {
          log.warn(`network: ${host} unreachable: ${describeError(err)}`);
        }
      }
      const base = await discoverBase();
      if (base) log.info(`Chrome debug endpoint: ${base} (browser agent ready)`);
      else log.warn("Chrome debug endpoint: none found — start Chrome with --remote-debugging-port for the login agent ($CDP_BASE overrides)");
      const recs = await vault.list();
      if (recs.length > 0) {
        const activeName = await vault.activeAccount();
        printTable(recs.map((r) => accountRow(r, activeName)), ACCOUNT_HEADER);
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
    log.err(describeError(err));
    process.exit(1);
  },
);
