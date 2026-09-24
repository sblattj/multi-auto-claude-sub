/** Plan usage per account: the same /api/oauth/usage endpoint Claude Code's
 *  /usage screen reads (5-hour session window, weekly window, per-model weekly
 *  limits, extra-usage spend). */
import type { FetchImpl } from "../oauth/client.js";

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const OAUTH_BETA = "oauth-2025-04-20";
const REQUEST_TIMEOUT_MS = 10_000;

export interface UsageWindow {
  /** percent of the window's allowance used, 0-100 (can exceed 100) */
  pct: number;
  /** epoch ms; null when the window has not started (no usage yet) */
  resetsAt: number | null;
}

export interface ScopedLimit extends UsageWindow {
  /** e.g. "Opus", "Fable" */
  label: string;
}

export interface ExtraUsage {
  enabled: boolean;
  /** minor currency units (cents) */
  usedMinor: number;
  limitMinor: number | null;
  currency: string;
  exponent: number;
}

export interface UsageSnapshot {
  fetchedAt: number;
  /** five_hour */
  session?: UsageWindow;
  /** seven_day (all models) */
  weekly?: UsageWindow;
  /** weekly limits for a single model */
  scoped: ScopedLimit[];
  extra?: ExtraUsage;
}

export class UsageHttpError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`usage request failed (HTTP ${status})${detail ? `: ${detail}` : ""}`);
    this.name = "UsageHttpError";
    this.status = status;
  }
}

export async function fetchUsage(
  accessToken: string,
  fetchImpl: FetchImpl = (url, init) => globalThis.fetch(url, init),
  now: () => number = Date.now,
): Promise<UsageSnapshot> {
  const res = await fetchImpl(USAGE_URL, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "anthropic-beta": OAUTH_BETA,
      accept: "application/json",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new UsageHttpError(res.status, errorMessage(text));
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("usage response is not valid JSON");
  }
  return parseUsage(json, now());
}

function errorMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: unknown } | string };
    if (typeof j.error === "string") return j.error;
    if (typeof j.error?.message === "string") return j.error.message;
  } catch {
    // not JSON
  }
  return body.slice(0, 200);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function time(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function windowOf(v: unknown): UsageWindow | undefined {
  if (!isObj(v)) return undefined;
  const pct = num(v.utilization);
  return pct === undefined ? undefined : { pct, resetsAt: time(v.resets_at) };
}

function limitWindow(limits: Obj[], kind: string): UsageWindow | undefined {
  const l = limits.find((x) => x.kind === kind);
  const pct = l ? num(l.percent) : undefined;
  return pct === undefined ? undefined : { pct, resetsAt: time(l!.resets_at) };
}

export function parseUsage(json: unknown, fetchedAt: number): UsageSnapshot {
  if (!isObj(json)) throw new Error("usage response is not a JSON object");
  const limits = Array.isArray(json.limits) ? json.limits.filter(isObj) : [];
  const out: UsageSnapshot = { fetchedAt, scoped: [] };

  const session = windowOf(json.five_hour) ?? limitWindow(limits, "session");
  if (session) out.session = session;
  const weekly = windowOf(json.seven_day) ?? limitWindow(limits, "weekly_all");
  if (weekly) out.weekly = weekly;

  for (const l of limits) {
    if (l.kind !== "weekly_scoped") continue;
    const model = isObj(l.scope) && isObj(l.scope.model) ? l.scope.model.display_name : undefined;
    const pct = num(l.percent);
    if (typeof model === "string" && pct !== undefined) {
      out.scoped.push({ label: model, pct, resetsAt: time(l.resets_at) });
    }
  }
  if (out.scoped.length === 0) {
    // older payloads: per-model weekly windows as top-level keys
    for (const [key, label] of [["seven_day_opus", "Opus"], ["seven_day_sonnet", "Sonnet"]] as const) {
      const w = windowOf(json[key]);
      if (w) out.scoped.push({ label, ...w });
    }
  }

  const extra = extraOf(json);
  if (extra) out.extra = extra;
  return out;
}

function extraOf(json: Obj): ExtraUsage | undefined {
  const spend = json.spend;
  if (isObj(spend) && isObj(spend.used)) {
    const used = num(spend.used.amount_minor);
    if (used !== undefined) {
      const limit = isObj(spend.limit) ? num(spend.limit.amount_minor) : undefined;
      return {
        enabled: spend.enabled === true,
        usedMinor: used,
        limitMinor: limit ?? null,
        currency: typeof spend.used.currency === "string" ? spend.used.currency : "USD",
        exponent: num(spend.used.exponent) ?? 2,
      };
    }
  }
  const eu = json.extra_usage;
  if (isObj(eu) && typeof eu.is_enabled === "boolean") {
    return {
      enabled: eu.is_enabled,
      usedMinor: num(eu.used_credits) ?? 0,
      limitMinor: num(eu.monthly_limit) ?? null,
      currency: typeof eu.currency === "string" ? eu.currency : "USD",
      exponent: num(eu.decimal_places) ?? 2,
    };
  }
  return undefined;
}
