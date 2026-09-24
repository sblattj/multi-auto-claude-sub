/**
 * Claude Code status line segment: every account's 5h/weekly usage from the
 * cache, e.g. "5h/7d alpha* 2/0% · beta 11/32%", plus "→ beta" when another
 * account is the better pick. Rendering never touches the network or the
 * keychain; a stale cache is refreshed by a detached background process.
 */
import { spawn } from "node:child_process";
import { stat, utimes, writeFile } from "node:fs/promises";
import type { UsageSnapshot } from "./usage.js";
import { pickBest, rankAccounts } from "./rank.js";
import { fmtDuration } from "./format.js";

/** refresh the cache in the background once it is older than this */
export const STATUSLINE_REFRESH_MS = 10 * 60_000;
/** dim the numbers and show their age past this */
const STALE_MS = 30 * 60_000;

export interface StatuslineInput {
  names: string[];
  activeName: string | null;
  cache: Record<string, UsageSnapshot>;
  now: number;
  color: boolean;
}

const ANSI = {
  reset: "\x1b[0m",
  label: "\x1b[38;5;242m",
  ok: "\x1b[38;5;114m",
  warn: "\x1b[38;5;179m",
  crit: "\x1b[1;38;5;203m",
  dim: "\x1b[38;5;240m",
};

/** A window whose reset passed counts as 0 (the cache predates the reset). */
function pctNow(w: { pct: number; resetsAt: number | null } | undefined, now: number): number | undefined {
  if (!w) return undefined;
  return w.resetsAt !== null && w.resetsAt <= now ? 0 : w.pct;
}

export function renderStatusline(inp: StatuslineInput): string {
  const paint = (code: string, s: string) => (inp.color ? `${code}${s}${ANSI.reset}` : s);
  if (inp.names.length === 0) return "";
  const parts: string[] = [];
  let oldest = inp.now;
  for (const name of inp.names) {
    const u = inp.cache[name];
    const label = name === inp.activeName ? `${name}*` : name;
    if (!u) {
      parts.push(`${label} ?`);
      continue;
    }
    oldest = Math.min(oldest, u.fetchedAt);
    const s = pctNow(u.session, inp.now);
    const w = pctNow(u.weekly, inp.now);
    const text = `${s === undefined ? "?" : Math.round(s)}/${w === undefined ? "?" : Math.round(w)}%`;
    const worst = Math.max(s ?? 0, w ?? 0);
    const code = inp.now - u.fetchedAt > STALE_MS ? ANSI.dim : worst >= 85 ? ANSI.crit : worst >= 60 ? ANSI.warn : ANSI.ok;
    parts.push(`${label} ${paint(code, text)}`);
  }
  let out = `${paint(ANSI.label, "5h/7d")} ${parts.join(" · ")}`;
  const ranked = rankAccounts(
    inp.names.map((name) => ({ name, ...(inp.cache[name] ? { usage: inp.cache[name] } : {}) })),
    inp.now,
  );
  const best = pickBest(ranked, inp.activeName);
  if (best && best.name !== inp.activeName) out += ` ${paint(ANSI.warn, `→ ${best.name}`)}`;
  if (inp.now - oldest > STALE_MS) out += ` ${paint(ANSI.dim, `(${fmtDuration(inp.now - oldest)} old)`)}`;
  return out;
}

/** true when some account has no snapshot or one older than STATUSLINE_REFRESH_MS */
export function needsRefresh(names: string[], cache: Record<string, UsageSnapshot>, now: number): boolean {
  return names.some((n) => {
    const s = cache[n];
    return s === undefined || now - s.fetchedAt > STATUSLINE_REFRESH_MS;
  });
}

/**
 * Start `macsub usage --refresh-cache` detached, at most once per
 * STATUSLINE_REFRESH_MS across every session's status line (marker mtime).
 */
export async function spawnBackgroundRefresh(markerFile: string, now: number, argv: string[] = process.argv): Promise<boolean> {
  try {
    const s = await stat(markerFile);
    if (now - s.mtimeMs < STATUSLINE_REFRESH_MS) return false;
    await utimes(markerFile, new Date(now), new Date(now));
  } catch {
    try {
      await writeFile(markerFile, "", { mode: 0o600, flag: "wx" });
      await utimes(markerFile, new Date(now), new Date(now));
    } catch {
      return false; // another status line created it first
    }
  }
  const script = argv[1];
  if (!script) return false;
  const child = spawn(process.execPath, [script, "usage", "--refresh-cache"], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
  return true;
}
