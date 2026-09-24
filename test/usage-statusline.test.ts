import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsRefresh, renderStatusline, spawnBackgroundRefresh, STATUSLINE_REFRESH_MS } from "../src/usage/statusline.js";
import { parseDuration } from "../src/util/duration.js";
import type { UsageSnapshot } from "../src/usage/usage.js";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const snap = (s5: number, w7: number, w7ResetIn: number, age = 60_000): UsageSnapshot => ({
  fetchedAt: NOW - age,
  scoped: [],
  session: { pct: s5, resetsAt: NOW + 2 * HOUR },
  weekly: { pct: w7, resetsAt: NOW + w7ResetIn },
});

test("statusline: every account's 5h/7d, active starred, no hint when active is best", () => {
  const out = renderStatusline({
    names: ["alpha", "beta"],
    activeName: "alpha",
    cache: { alpha: snap(2, 0, 2 * DAY), beta: snap(11, 32, 5 * DAY) },
    now: NOW,
    color: false,
  });
  assert.equal(out, "5h/7d alpha* 2/0% · beta 11/32%");
});

test("statusline: points at the better account, marks missing and stale data", () => {
  const out = renderStatusline({
    names: ["A", "B", "C"],
    activeName: "A",
    cache: { A: snap(40, 90, 7 * DAY), B: snap(5, 10, DAY, 45 * 60_000) },
    now: NOW,
    color: false,
  });
  assert.equal(out, "5h/7d A* 40/90% · B 5/10% · C ? → B (45m old)");
});

test("statusline: windows whose reset passed show 0; color only when asked", () => {
  const past: UsageSnapshot = { fetchedAt: NOW - 60_000, scoped: [], session: { pct: 100, resetsAt: NOW - 1 }, weekly: { pct: 50, resetsAt: NOW + DAY } };
  assert.equal(renderStatusline({ names: ["A"], activeName: "A", cache: { A: past }, now: NOW, color: false }), "5h/7d A* 0/50%");
  const colored = renderStatusline({ names: ["A"], activeName: "A", cache: { A: snap(90, 10, DAY) }, now: NOW, color: true });
  assert.match(colored, /\x1b\[1;38;5;203m90\/10%/); // 85%+ is critical
  assert.equal(renderStatusline({ names: [], activeName: null, cache: {}, now: NOW, color: false }), "");
});

test("statusline: refresh needed when a snapshot is missing or older than the refresh window", () => {
  assert.equal(needsRefresh(["A"], { A: snap(1, 1, DAY) }, NOW), false);
  assert.equal(needsRefresh(["A"], { A: snap(1, 1, DAY, STATUSLINE_REFRESH_MS + 1) }, NOW), true);
  assert.equal(needsRefresh(["A", "B"], { A: snap(1, 1, DAY) }, NOW), true);
});

test("statusline: background refresh spawns at most once per window", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "macsub-sl-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = join(dir, "noop.mjs");
  await writeFile(script, "");
  const marker = join(dir, ".usage-refresh");
  const argv = [process.execPath, script];
  const now = Date.now();
  assert.equal(await spawnBackgroundRefresh(marker, now, argv), true);
  assert.equal(await spawnBackgroundRefresh(marker, now + 1_000, argv), false);
  assert.equal(await spawnBackgroundRefresh(marker, now + STATUSLINE_REFRESH_MS + 1, argv), true);
  assert.ok((await stat(marker)).mtimeMs >= now + STATUSLINE_REFRESH_MS);
});

test("parseDuration", () => {
  assert.equal(parseDuration("300ms"), 300);
  assert.equal(parseDuration("4s"), 4_000);
  assert.equal(parseDuration("4"), 4_000);
  assert.equal(parseDuration("1.5m"), 90_000);
  assert.equal(parseDuration("2h"), 7_200_000);
  assert.throws(() => parseDuration("soon"), /bad duration/);
});
