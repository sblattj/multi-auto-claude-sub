import test from "node:test";
import assert from "node:assert/strict";
import { pickBest, rankAccounts, rankOne, type Candidate } from "../src/usage/rank.js";
import type { UsageWindow } from "../src/usage/usage.js";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function acct(name: string, weekly?: UsageWindow, session?: UsageWindow): Candidate {
  if (!weekly) return { name };
  return { name, usage: { fetchedAt: NOW, scoped: [], weekly, ...(session ? { session } : {}) } };
}
const w = (pct: number, resetsIn: number | null): UsageWindow => ({
  pct,
  resetsAt: resetsIn === null ? null : NOW + resetsIn,
});
const names = (cands: Candidate[]) => rankAccounts(cands, NOW).map((r) => r.name);

test("the example: A 90% used resetting in a week loses to B 10% used resetting in a day", () => {
  assert.deepEqual(names([acct("A", w(90, 7 * DAY)), acct("B", w(10, DAY))]), ["B", "A"]);
});

test("use it or lose it: half a week left that resets tomorrow beats a fresh week", () => {
  // A: 50% left but gone in 1d. B: 90% left for 7d. Spend A first, B keeps.
  assert.deepEqual(names([acct("A", w(50, DAY)), acct("B", w(10, 7 * DAY))]), ["A", "B"]);
});

test("an unstarted week counts as a full week away", () => {
  const r = rankOne(acct("A", w(0, null)), NOW);
  assert.equal(r.tier, "ready");
  assert.ok(Math.abs(r.score - 100 / 168) < 1e-9);
});

test("accounts at a limit are skipped; with all blocked, soonest free comes first", () => {
  assert.deepEqual(names([acct("A", w(100, 2 * DAY)), acct("B", w(95, 6 * DAY))]), ["B", "A"]);
  const sessionOut = acct("C", w(20, DAY), w(100, 2 * HOUR));
  assert.equal(rankOne(sessionOut, NOW).tier, "blocked");
  assert.equal(rankOne(sessionOut, NOW).availableAt, NOW + 2 * HOUR);
  assert.deepEqual(names([acct("A", w(100, 2 * DAY)), sessionOut]), ["C", "A"]);
});

test("a nearly spent 5-hour window counts against an account unless it resets soon", () => {
  const tired = acct("A", w(10, DAY), w(95, 3 * HOUR));
  const rested = acct("B", w(40, DAY), w(5, 3 * HOUR));
  assert.deepEqual(names([tired, rested]), ["B", "A"]);
  const aboutToReset = acct("A", w(10, DAY), w(95, 10 * 60_000));
  assert.deepEqual(names([aboutToReset, rested]), ["A", "B"]);
});

test("under 5% of the week left ranks behind any usable account", () => {
  // A's 3% expires in an hour (high pace) but it would run dry almost at once
  assert.deepEqual(names([acct("A", w(97, HOUR)), acct("B", w(60, 6 * DAY))]), ["B", "A"]);
  assert.equal(rankOne(acct("A", w(97, HOUR)), NOW).tier, "low");
});

test("stale cached windows whose reset passed count as empty", () => {
  const r = rankOne(acct("A", w(100, -HOUR), w(100, -HOUR)), NOW);
  assert.equal(r.tier, "ready");
  assert.equal(r.weeklyLeft, 100);
});

test("unknown usage ranks after usable accounts but before blocked ones", () => {
  assert.deepEqual(names([acct("U"), acct("X", w(100, DAY)), acct("L", w(99, DAY))]), ["L", "U", "X"]);
});

test("pickBest keeps the current account on a near tie, switches on a clear win", () => {
  const near = rankAccounts([acct("A", w(50, 2 * DAY)), acct("B", w(45, 2 * DAY))], NOW);
  assert.equal(near[0]!.name, "B");
  assert.equal(pickBest(near, "A")!.name, "A"); // 50 vs 55 left: not worth a swap
  const clear = rankAccounts([acct("A", w(90, 7 * DAY)), acct("B", w(10, DAY))], NOW);
  assert.equal(pickBest(clear, "A")!.name, "B");
  assert.equal(pickBest(clear, null)!.name, "B");
});

test("pickBest: nothing known → undefined", () => {
  assert.equal(pickBest(rankAccounts([acct("A"), acct("B")], NOW), "A"), undefined);
  assert.equal(pickBest([], null), undefined);
});
