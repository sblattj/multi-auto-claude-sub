import test from "node:test";
import assert from "node:assert/strict";
import { fetchUsage, OAUTH_BETA, parseUsage, USAGE_URL, UsageHttpError } from "../src/usage/usage.js";
import type { FetchImpl, FetchRequestInit } from "../src/oauth/client.js";
import { bar, explainPick, fmtDetails, fmtDuration } from "../src/usage/format.js";
import { rankAccounts } from "../src/usage/rank.js";

const NOW = Date.parse("2026-09-24T15:46:48Z");
const HOUR = 3_600_000;

/** Shape of a real /api/oauth/usage response (numbers only, trimmed). */
const LIVE_BODY = {
  five_hour: { utilization: 11.0, resets_at: "2026-09-24T18:39:59.666564+00:00", limit_dollars: null },
  seven_day: { utilization: 32.0, resets_at: "2026-09-29T20:59:59.666585+00:00", limit_dollars: null },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  nimbus_quill: { utilization: 0.0, resets_at: null },
  extra_usage: {
    is_enabled: true,
    monthly_limit: 4000,
    used_credits: 0.0,
    currency: "USD",
    decimal_places: 2,
  },
  limits: [
    { kind: "session", group: "session", percent: 11, resets_at: "2026-09-24T18:39:59.666564+00:00", scope: null },
    { kind: "weekly_all", group: "weekly", percent: 32, resets_at: "2026-09-29T20:59:59.666585+00:00", scope: null },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 1,
      resets_at: "2026-09-29T20:59:59.666736+00:00",
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
    },
  ],
  spend: {
    used: { amount_minor: 0, currency: "USD", exponent: 2 },
    limit: { amount_minor: 4000, currency: "USD", exponent: 2 },
    enabled: true,
  },
};

test("parseUsage: real payload → session, weekly, per-model weekly, extra usage", () => {
  const u = parseUsage(LIVE_BODY, NOW);
  assert.equal(u.fetchedAt, NOW);
  assert.deepEqual(u.session, { pct: 11, resetsAt: Date.parse("2026-09-24T18:39:59.666564+00:00") });
  assert.deepEqual(u.weekly, { pct: 32, resetsAt: Date.parse("2026-09-29T20:59:59.666585+00:00") });
  assert.deepEqual(u.scoped, [{ label: "Fable", pct: 1, resetsAt: Date.parse("2026-09-29T20:59:59.666736+00:00") }]);
  assert.deepEqual(u.extra, { enabled: true, usedMinor: 0, limitMinor: 4000, currency: "USD", exponent: 2 });
});

test("parseUsage: falls back to limits[] and legacy per-model keys", () => {
  const u = parseUsage(
    {
      limits: [
        { kind: "session", percent: 40, resets_at: "2026-09-24T18:00:00Z" },
        { kind: "weekly_all", percent: 70, resets_at: null },
      ],
      seven_day_opus: { utilization: 55, resets_at: "2026-09-26T00:00:00Z" },
      extra_usage: { is_enabled: false, used_credits: 120, monthly_limit: null, currency: "USD", decimal_places: 2 },
    },
    NOW,
  );
  assert.deepEqual(u.session, { pct: 40, resetsAt: Date.parse("2026-09-24T18:00:00Z") });
  assert.deepEqual(u.weekly, { pct: 70, resetsAt: null });
  assert.deepEqual(u.scoped, [{ label: "Opus", pct: 55, resetsAt: Date.parse("2026-09-26T00:00:00Z") }]);
  assert.deepEqual(u.extra, { enabled: false, usedMinor: 120, limitMinor: null, currency: "USD", exponent: 2 });
});

test("parseUsage: empty object parses to nothing; non-object throws", () => {
  assert.deepEqual(parseUsage({}, NOW), { fetchedAt: NOW, scoped: [] });
  assert.throws(() => parseUsage([], NOW), /not a JSON object/);
});

function stub(res: () => Response): { calls: Array<{ url: string; init: FetchRequestInit }>; fetch: FetchImpl } {
  const calls: Array<{ url: string; init: FetchRequestInit }> = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return res();
    },
  };
}

test("fetchUsage: GET with bearer + oauth beta header", async () => {
  const s = stub(() => new Response(JSON.stringify(LIVE_BODY), { status: 200 }));
  const u = await fetchUsage("sk-ant-oat-fake", s.fetch, () => NOW);
  assert.equal(u.weekly?.pct, 32);
  assert.equal(s.calls.length, 1);
  const c = s.calls[0]!;
  assert.equal(c.url, USAGE_URL);
  assert.equal(c.init.method, "GET");
  assert.equal(c.init.headers.authorization, "Bearer sk-ant-oat-fake");
  assert.equal(c.init.headers["anthropic-beta"], OAUTH_BETA);
  assert.ok(c.init.signal instanceof AbortSignal);
});

test("fetchUsage: HTTP errors carry status and the API message", async () => {
  const s = stub(
    () => new Response(JSON.stringify({ error: { type: "authentication_error", message: "token revoked" } }), { status: 401 }),
  );
  await assert.rejects(fetchUsage("t", s.fetch), (e: unknown) => {
    assert.ok(e instanceof UsageHttpError);
    assert.equal(e.status, 401);
    assert.match(e.message, /HTTP 401.*token revoked/);
    return true;
  });
});

test("fmtDuration: compact, largest two units", () => {
  assert.equal(fmtDuration(-5), "now");
  assert.equal(fmtDuration(30_000), "<1m");
  assert.equal(fmtDuration(45 * 60_000), "45m");
  assert.equal(fmtDuration(2 * HOUR + 13 * 60_000), "2h 13m");
  assert.equal(fmtDuration(3 * HOUR), "3h");
  assert.equal(fmtDuration(5 * 24 * HOUR + 5 * HOUR + 59 * 60_000), "5d 5h");
  assert.equal(fmtDuration(7 * 24 * HOUR), "7d");
});

test("bar + details render", () => {
  assert.equal(bar(0), "░░░░░░░░░░");
  assert.equal(bar(32), "███░░░░░░░");
  assert.equal(bar(250), "██████████");
  assert.equal(fmtDetails(parseUsage(LIVE_BODY, NOW)), "Fable weekly 1% · extra usage on, $0.00 of $40.00");
});

test("explainPick names the pick and the runner-up", () => {
  const ranked = rankAccounts(
    [
      { name: "a", usage: { fetchedAt: NOW, scoped: [], weekly: { pct: 90, resetsAt: NOW + 168 * HOUR } } },
      { name: "b", usage: { fetchedAt: NOW, scoped: [], weekly: { pct: 10, resetsAt: NOW + 24 * HOUR } } },
    ],
    NOW,
  );
  assert.deepEqual(explainPick(ranked[0], ranked, NOW), [
    "best: b (90% of weekly left, resets in 1d)",
    "  vs a (10% of weekly left, resets in 7d)",
  ]);
  assert.deepEqual(explainPick(undefined, [], NOW), ["best: can't tell, no account's usage could be read"]);
});
