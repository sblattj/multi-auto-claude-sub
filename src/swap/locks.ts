/** mkdir-based directory locks compatible with Claude Code's proper-lockfile
 * usage (a competing CC process creates the same directory). A lock whose dir
 * mtime is older than the stale window is broken (rm -rf) and retaken. */

import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { pathsFor } from "../paths.js";

export class LockTimeoutError extends Error {
  constructor(public readonly lockPath: string) {
    super(`timed out waiting for lock: ${lockPath}`);
    this.name = "LockTimeoutError";
  }
}

export interface DirLockHandle {
  readonly path: string;
  readonly token: string;
  release(): Promise<void>;
}

export interface DirLockOptions {
  /** dir older than this is stale and gets broken (default 60s) */
  staleMs?: number;
  /** mtime refresh interval while held (default 5s) */
  touchMs?: number;
  /** how long to wait for a busy (fresh, held-by-other) lock before throwing
   *  LockTimeoutError (default 30s) */
  waitMs?: number;
  /** poll interval while waiting (default 100ms) */
  pollMs?: number;
}

const OWNER_FILE = ".macsub-owner";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Acquire a mkdir-based lock dir at `path`. The returned release() removes the
 *  dir only if this handle still owns it (owner-token check), so a stale-broken
 *  and retaken lock is never deleted by its previous owner. */
export async function acquireDirLock(path: string, opts: DirLockOptions = {}): Promise<DirLockHandle> {
  const staleMs = opts.staleMs ?? 60_000;
  const touchMs = opts.touchMs ?? 5_000;
  const waitMs = opts.waitMs ?? 30_000;
  const pollMs = opts.pollMs ?? 100;
  const deadline = Date.now() + waitMs;
  const token = `pid-${process.pid}-${randomUUID()}`;
  let timer: NodeJS.Timeout | null = null;
  for (;;) {
    try {
      await mkdir(dirname(path), { recursive: true });
      await mkdir(path);
      try {
        await writeFile(join(path, OWNER_FILE), token, { mode: 0o600 });
      } catch {
        // best effort: ownership check degrades gracefully
      }
      const t: NodeJS.Timeout = setInterval(() => {
        void utimes(path, new Date(), new Date()).catch(() => {
          if (timer) {
            clearInterval(timer);
            timer = null;
          }
        });
      }, touchMs);
      t.unref?.();
      timer = t;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
      let stale = false;
      try {
        const s = await stat(path);
        stale = Date.now() - s.mtimeMs > staleMs;
      } catch {
        stale = true; // dir vanished mid-check → retry immediately
      }
      if (stale) {
        try {
          await rm(path, { recursive: true, force: true });
        } catch {
          // racing another breaker; loop will re-evaluate
        }
        continue;
      }
      if (Date.now() >= deadline) throw new LockTimeoutError(path);
      await sleep(pollMs);
    }
  }
  let released = false;
  return {
    path,
    token,
    release: async () => {
      if (released) return;
      released = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      try {
        const owner = await readFile(join(path, OWNER_FILE), "utf8");
        if (owner.trim() !== token) return; // broken + retaken; not ours
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return; // already gone
        // unreadable owner file: fall through, attempt removal
      }
      try {
        await rm(path, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

export interface ClaudeLocksOptions {
  env?: NodeJS.ProcessEnv;
  waitMs?: number;
}

/** SPEC §3 locks 1+2 — <configHome>/.oauth_refresh.lock then ~/.claude.lock —
 *  both stale 60s / touched every 5s. Runs fn, releases in reverse. Lock 3
 *  (.claude.json.lock) is separate: withConfigLock, around config writes. */
export async function withClaudeLocks<T>(fn: () => Promise<T>, opts: ClaudeLocksOptions = {}): Promise<T> {
  const p = pathsFor(opts.env ?? process.env);
  const lockOpts: DirLockOptions = { staleMs: 60_000, touchMs: 5_000 };
  if (opts.waitMs !== undefined) lockOpts.waitMs = opts.waitMs;
  const l1 = await acquireDirLock(p.oauthRefreshLock, lockOpts);
  let l2: DirLockHandle | null = null;
  try {
    l2 = await acquireDirLock(p.claudeLock, lockOpts);
    return await fn();
  } finally {
    if (l2) await l2.release();
    await l1.release();
  }
}

export interface ConfigLockOptions {
  env?: NodeJS.ProcessEnv;
  /** lock next to this .claude.json (default: resolved live path) */
  claudeJsonPath?: string;
  waitMs?: number;
}

/** SPEC §3 lock 3 — <dir-of-.claude.json>/.claude.json.lock, stale after 10s —
 *  held only around config-file writes. */
export async function withConfigLock<T>(fn: () => Promise<T>, opts: ConfigLockOptions = {}): Promise<T> {
  const claudeJson = opts.claudeJsonPath ?? pathsFor(opts.env ?? process.env).claudeJson;
  const lockOpts: DirLockOptions = { staleMs: 10_000, touchMs: 5_000 };
  if (opts.waitMs !== undefined) lockOpts.waitMs = opts.waitMs;
  const lock = await acquireDirLock(join(dirname(claudeJson), ".claude.json.lock"), lockOpts);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
