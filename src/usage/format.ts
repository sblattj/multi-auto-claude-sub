/** Terminal rendering for usage: bars, durations, the pick explanation. */
import type { ExtraUsage, UsageSnapshot, UsageWindow } from "./usage.js";
import type { Ranked } from "./rank.js";

/** "45m", "2h 13m", "5d 5h"; "now" when due */
export function fmtDuration(ms: number): string {
  if (ms <= 60_000) return ms <= 0 ? "now" : "<1m";
  const mins = Math.floor(ms / 60_000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  const m = mins % 60;
  if (hours > 0) return m > 0 ? `${hours}h ${m}m` : `${hours}h`;
  return `${m}m`;
}

export function fmtAge(ms: number): string {
  return ms < 60_000 ? "just now" : `${fmtDuration(ms)} ago`;
}

export function bar(pct: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** "62%", left-padded to 4 so columns line up */
export function fmtPct(pct: number): string {
  return `${Math.round(pct)}%`.padStart(4);
}

export function fmtReset(w: UsageWindow | undefined, now: number): string {
  if (!w) return "-";
  if (w.resetsAt === null) return "not started";
  return w.resetsAt <= now ? "reset" : fmtDuration(w.resetsAt - now);
}

/** "62%  ██████░░░░" */
export function fmtWindow(w: UsageWindow | undefined): string {
  return w ? `${bar(w.pct)} ${fmtPct(w.pct)}` : "-";
}

function money(minor: number, exponent: number, currency: string): string {
  const v = (minor / 10 ** exponent).toFixed(exponent);
  return currency === "USD" ? `$${v}` : `${v} ${currency}`;
}

export function fmtExtra(e: ExtraUsage): string {
  if (!e.enabled) return "extra usage off";
  const used = money(e.usedMinor, e.exponent, e.currency);
  return e.limitMinor === null
    ? `extra usage on, ${used} spent`
    : `extra usage on, ${used} of ${money(e.limitMinor, e.exponent, e.currency)}`;
}

/** Per-model weekly limits and extra-usage spend: "Fable weekly 1% · extra usage on, $0.00 of $40.00" */
export function fmtDetails(u: UsageSnapshot): string {
  const parts = u.scoped.map((s) => `${s.label} weekly ${Math.round(s.pct)}%`);
  if (u.extra) parts.push(fmtExtra(u.extra));
  return parts.join(" · ");
}

/** One-clause summary of a ranked account, e.g. "68% of weekly left, resets in 5d 5h" */
export function describeRank(r: Ranked, now: number): string {
  switch (r.tier) {
    case "unknown":
      return "usage unknown";
    case "blocked":
      return `at a usage limit, frees up in ${fmtDuration((r.availableAt ?? now) - now)}`;
    default: {
      const left = `${Math.round(r.weeklyLeft ?? 0)}% of weekly left`;
      const reset =
        r.weeklyResetsAt === null || r.weeklyResetsAt === undefined
          ? "week not started yet"
          : `resets in ${fmtDuration(r.weeklyResetsAt - now)}`;
      return r.tier === "low" ? `only ${left}, ${reset}` : `${left}, ${reset}`;
    }
  }
}

/**
 * Lines explaining the pick, e.g.
 *   best: beta (68% of weekly left, resets in 5d 5h)
 *   vs alpha (10% of weekly left, resets in 6d 23h)
 */
export function explainPick(best: Ranked | undefined, ranked: Ranked[], now: number): string[] {
  if (!best) return ["best: can't tell, no account's usage could be read"];
  const lines = [`best: ${best.name} (${describeRank(best, now)})`];
  if (best.tier === "blocked") lines[0] += "; every account is at a limit";
  for (const r of ranked) {
    if (r.name !== best.name) lines.push(`  vs ${r.name} (${describeRank(r, now)})`);
  }
  return lines;
}
