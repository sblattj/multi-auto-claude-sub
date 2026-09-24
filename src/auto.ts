/**
 * Unattended "stay on the best account": `macsub best --auto` (before a new
 * Claude Code session starts) and `macsub on-limit` (a StopFailure hook when a
 * session is rate-limited). Never opens a browser, never prompts, and bounds
 * the part that can hang on the network.
 *
 * Only reads are ever abandoned on timeout. Token refreshes and the swap itself
 * always run to completion: a refresh cut short after the server rotated the
 * token would leave a dead refresh token in the vault, and the keychain write
 * is delete-then-add.
 */
import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActiveState, Vault } from "./types.js";
import type { FetchImpl } from "./oauth/client.js";
import { OAuthClient } from "./oauth/client.js";
import type { TokenRefresher } from "./oauth/health.js";
import { refreshAccount } from "./pipeline.js";
import { pathsFor } from "./paths.js";
import { swap as realSwap } from "./swap/swap.js";
import { acquireDirLock, LockTimeoutError } from "./swap/locks.js";
import { collectUsage, readUsageCache, type AccountUsage } from "./usage/collect.js";
import { pickBest, rankAccounts, type Ranked } from "./usage/rank.js";
import { describeRank } from "./usage/format.js";
import { describeError } from "./util/net.js";

export type AutoTrigger = "auto" | "limit";

export interface AutoOptions {
  trigger: AutoTrigger;
  /** keep the current account without any request when every account's cached
   *  usage is at most this old and still ranks it best */
  maxAgeMs?: number;
  /** cap on reading usage (default 4s); on timeout nothing changes */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchImpl;
  client?: TokenRefresher;
  now?: () => number;
  /** tests */
  swapImpl?: typeof realSwap;
  detectSessions?: () => Promise<string[]>;
}

export type AutoAction = "kept" | "swapped" | "skipped";

export interface AutoResult {
  action: AutoAction;
  from: string | null;
  to?: string;
  reason: string;
  /** skipped because another auto-swap holds the lock (not worth a notification) */
  busy?: boolean;
}

export const DEFAULT_AUTO_TIMEOUT_MS = 4_000;
const LOCK_STALE_MS = 120_000;
const LOG_MAX_BYTES = 256 * 1024;

const TIMED_OUT = Symbol("timed out");

function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

export async function autoBest(vault: Vault, active: ActiveState, opts: AutoOptions): Promise<AutoResult> {
  const env = opts.env ?? process.env;
  const home = pathsFor(env).macsubHome;
  let result: AutoResult;
  try {
    result = await decideAndSwap(vault, active, opts, env, home);
  } catch (err) {
    result = { action: "skipped", from: null, reason: `error: ${describeError(err)}` };
  }
  await appendAutoLog(home, opts.trigger, result, (opts.now ?? Date.now)());
  return result;
}

async function decideAndSwap(
  vault: Vault,
  active: ActiveState,
  opts: AutoOptions,
  env: NodeJS.ProcessEnv,
  home: string,
): Promise<AutoResult> {
  const now = opts.now ?? Date.now;
  const from = await vault.activeAccount();
  const recs = await vault.list();
  if (recs.length < 2) return { action: "skipped", from, reason: "fewer than two vaulted accounts" };

  let lock;
  try {
    lock = await acquireDirLock(join(home, "auto.lock"), { staleMs: LOCK_STALE_MS, waitMs: 0 });
  } catch (err) {
    if (err instanceof LockTimeoutError) {
      return { action: "skipped", from, reason: "another auto-swap is running", busy: true };
    }
    throw err;
  }
  try {
    // cheap path: fresh cache that still ranks the current account first
    if (opts.maxAgeMs !== undefined && from !== null) {
      const cache = await readUsageCache(pathsFor(env).usageCacheFile);
      const fresh = recs.every((r) => {
        const s = cache[r.name];
        return s !== undefined && now() - s.fetchedAt <= opts.maxAgeMs!;
      });
      if (fresh) {
        const ranked = rankAccounts(recs.map((r) => ({ name: r.name, usage: cache[r.name]! })), now());
        if (pickBest(ranked, from)?.name === from) {
          return { action: "kept", from, reason: `${from} is still best (usage checked within ${Math.round(opts.maxAgeMs / 60_000)}m)` };
        }
      }
    }

    // live read, no token refreshes (abandoning it on timeout is harmless)
    const timeoutMs = opts.timeoutMs ?? DEFAULT_AUTO_TIMEOUT_MS;
    const usages = await within(
      collectUsage(vault, active, {
        refresh: false,
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        now,
      }),
      timeoutMs,
    );
    if (usages === TIMED_OUT) {
      return { action: "skipped", from, reason: `usage check timed out after ${timeoutMs / 1000}s` };
    }
    const t = now();
    const ranked = rankAccounts(usages, t);
    const best = pickBest(ranked, from);
    if (!best) return { action: "skipped", from, reason: `no usage data (${errorsOf(usages)})` };
    if (best.name === from) return { action: "kept", from, reason: `${from} is best (${describeRank(best, t)})` };

    // the target must hold a working token before it is installed: L1 only
    const r = await refreshAccount(vault, active, best.name, opts.client ?? new OAuthClient(opts.fetchImpl), {
      ...(opts.env ? { env: opts.env } : {}),
    });
    if (r.level !== "fresh" && r.level !== "refreshed") {
      return {
        action: "skipped",
        from,
        reason: `${best.name} is best but its token needs a login${r.detail ? ` (${r.detail})` : ""}; run: macsub login ${best.name}`,
      };
    }

    const res = await (opts.swapImpl ?? realSwap)(vault, active, best.name, {
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.detectSessions ? { detectSessions: opts.detectSessions } : {}),
    });
    if (res.outcome.startsWith("failed")) {
      return { action: "skipped", from, reason: `swap to ${best.name} failed: ${res.outcome}${res.detail ? ` (${res.detail})` : ""}` };
    }
    return { action: "swapped", from, to: best.name, reason: describeWhy(best, ranked, t) };
  } finally {
    await lock.release();
  }
}

function describeWhy(best: Ranked, ranked: Ranked[], now: number): string {
  const others = ranked.filter((r) => r.name !== best.name).map((r) => `${r.name}: ${describeRank(r, now)}`);
  return `${describeRank(best, now)}${others.length ? `; ${others.join("; ")}` : ""}`;
}

function errorsOf(usages: AccountUsage[]): string {
  return usages.map((u) => `${u.name}: ${u.error ?? "no data"}`).join("; ");
}

/** ~/.macsub/auto.log: one line per decision; trimmed to its newer half past 256 KB. */
async function appendAutoLog(home: string, trigger: AutoTrigger, r: AutoResult, now: number): Promise<void> {
  const file = join(home, "auto.log");
  const line = `${new Date(now).toISOString()} ${trigger} ${r.action} ${r.from ?? "-"}${r.to ? `->${r.to}` : ""} ${r.reason}\n`;
  try {
    await appendFile(file, line, { mode: 0o600 });
    if ((await stat(file)).size > LOG_MAX_BYTES) {
      const text = await readFile(file, "utf8");
      const keep = text.slice(text.length - LOG_MAX_BYTES / 2);
      await writeFile(file, keep.slice(keep.indexOf("\n") + 1), { mode: 0o600 });
    }
  } catch {
    // logging must never break a launch or a hook
  }
}
