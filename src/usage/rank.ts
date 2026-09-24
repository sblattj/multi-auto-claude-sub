/**
 * "Best account" ranking. Weekly allowance is use-it-or-lose-it: whatever is
 * left at the weekly reset is gone. So the best account is the one whose unused
 * allowance expires fastest: weekly % left ÷ hours until the weekly reset.
 *   A: 90% used, resets in 7d → 10 / 168 ≈ 0.06 %/h
 *   B: 10% used, resets in 1d → 90 / 24  = 3.75 %/h  → B
 * Accounts at a limit are skipped, a nearly spent 5-hour window slows an
 * account down, and one with under LOW_WEEKLY_LEFT % of its week left only
 * wins when nothing else is usable.
 */
import type { UsageSnapshot, UsageWindow } from "./usage.js";

const HOUR = 3_600_000;
const WEEK_HOURS = 168;
/** under this much weekly allowance left, an account ranks behind usable ones */
export const LOW_WEEKLY_LEFT = 5;
/** a 5-hour window with at least this much left does not slow an account down */
const SESSION_COMFORT_LEFT = 25;
/** a 5-hour window resetting this soon counts as fresh */
const SESSION_RESET_SOON_MS = 30 * 60_000;
/** stay on the current account unless another scores this many times better */
export const STICKY_FACTOR = 1.15;

export type Tier = "ready" | "low" | "unknown" | "blocked";

export interface Candidate {
  name: string;
  usage?: UsageSnapshot;
}

export interface Ranked {
  name: string;
  tier: Tier;
  /** weekly % left per hour until the weekly reset, scaled by 5h headroom */
  score: number;
  weeklyLeft?: number;
  /** epoch ms of the weekly reset; null when the week has not started */
  weeklyResetsAt?: number | null;
  /** blocked accounts: when the limit that blocks them resets */
  availableAt?: number;
}

/** A window whose reset time has passed (a cached snapshot) is empty again. */
function current(w: UsageWindow | undefined, now: number): UsageWindow | undefined {
  if (!w) return undefined;
  return w.resetsAt !== null && w.resetsAt <= now ? { pct: 0, resetsAt: null } : w;
}

export function rankOne(c: Candidate, now: number = Date.now()): Ranked {
  const week = current(c.usage?.weekly, now);
  if (!c.usage || !week) return { name: c.name, tier: "unknown", score: 0 };
  const session = current(c.usage.session, now);
  const weeklyLeft = Math.max(0, 100 - week.pct);
  const base = { name: c.name, weeklyLeft, weeklyResetsAt: week.resetsAt };

  const blockedUntil = [week, session]
    .filter((w): w is UsageWindow => w !== undefined && w.pct >= 100 && w.resetsAt !== null)
    .map((w) => w.resetsAt!);
  if (blockedUntil.length > 0) {
    return { ...base, tier: "blocked", score: 0, availableAt: Math.max(...blockedUntil) };
  }

  const hours = week.resetsAt === null ? WEEK_HOURS : Math.max((week.resetsAt - now) / HOUR, 1);
  let score = weeklyLeft / hours;
  if (session && !(session.resetsAt !== null && session.resetsAt - now <= SESSION_RESET_SOON_MS)) {
    score *= Math.min(1, Math.max(0, 100 - session.pct) / SESSION_COMFORT_LEFT);
  }
  return { ...base, tier: weeklyLeft < LOW_WEEKLY_LEFT ? "low" : "ready", score };
}

const TIER_ORDER: Record<Tier, number> = { ready: 0, low: 1, unknown: 2, blocked: 3 };

/** Best first. Blocked accounts sort by when they free up. */
export function rankAccounts(cands: Candidate[], now: number = Date.now()): Ranked[] {
  return cands
    .map((c) => rankOne(c, now))
    .sort(
      (a, b) =>
        TIER_ORDER[a.tier] - TIER_ORDER[b.tier] ||
        (a.tier === "blocked"
          ? (a.availableAt ?? Infinity) - (b.availableAt ?? Infinity)
          : b.score - a.score) ||
        a.name.localeCompare(b.name),
    );
}

/**
 * The account to use. Keeps `currentName` when it is in the same tier and
 * within STICKY_FACTOR of the top score, so near-ties don't flip-flop and
 * force session restarts. undefined when no account has usage data.
 */
export function pickBest(ranked: Ranked[], currentName: string | null): Ranked | undefined {
  const top = ranked[0];
  if (!top || top.tier === "unknown") return undefined;
  const cur = currentName === null ? undefined : ranked.find((r) => r.name === currentName);
  if (
    cur &&
    cur !== top &&
    cur.tier === top.tier &&
    (cur.tier === "ready" || cur.tier === "low") &&
    cur.score * STICKY_FACTOR >= top.score
  ) {
    return cur;
  }
  return top;
}
