import { test } from "node:test";
import assert from "node:assert/strict";
import { PollTimeoutError, pollForActionable, trustedClick, withFocusEmulation } from "../src/cdp/focus.js";
import { ScriptedConn, type ScriptedOpts } from "./helpers.js";

test("withFocusEmulation: enables, runs fn, disables in order", async () => {
  const conn = new ScriptedConn();
  const out = await withFocusEmulation(conn, async () => 42);
  assert.equal(out, 42);
  assert.deepEqual(conn.focusToggles(), [true, false]);
});

test("withFocusEmulation: fn throw still disables, and the original error propagates", async () => {
  const conn = new ScriptedConn();
  await assert.rejects(
    withFocusEmulation(conn, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.deepEqual(conn.focusToggles(), [true, false]);
});

test("withFocusEmulation: failure of the disable send is swallowed, not masking the body error", async () => {
  const conn = new ScriptedConn();
  const calls: string[] = [];
  conn.send = ((method: string, params: Record<string, unknown> = {}) => {
    calls.push(method);
    if (method === "Emulation.setFocusEmulationEnabled" && params.enabled === false) {
      return Promise.reject(new Error("disable failed"));
    }
    return Promise.resolve({} as never);
  }) as typeof conn.send;
  await assert.rejects(
    withFocusEmulation(conn, async () => {
      throw new Error("body-failed");
    }),
    /body-failed/,
  );
  assert.equal(calls.filter((m) => m === "Emulation.setFocusEmulationEnabled").length, 2);
});

test("trustedClick: mouseMoved -> mousePressed -> mouseReleased, left button, clickCount 1", async () => {
  const conn = new ScriptedConn();
  await trustedClick(conn, { x: 123, y: 45 });
  const mouse = conn.sendsOf("Input.dispatchMouseEvent");
  assert.equal(mouse.length, 3);
  assert.deepEqual(
    mouse.map((p) => p.type),
    ["mouseMoved", "mousePressed", "mouseReleased"],
  );
  for (const p of mouse) {
    assert.equal(p.button ?? "left", "left");
  }
  assert.equal(mouse[1]?.clickCount, 1);
  assert.equal(mouse[1]?.x, 123);
  assert.equal(mouse[2]?.y, 45);
});

test("pollForActionable: skips disabled authorize-buttons, returns once enabled", async () => {
  const opts: ScriptedOpts = {
    script: [
      { kind: "authorize-button", x: 1, y: 2, disabled: true },
      { kind: "authorize-button", x: 1, y: 2, disabled: true },
      { kind: "authorize-button", x: 7, y: 8, disabled: false },
    ],
  };
  const conn = new ScriptedConn(opts);
  const hit = await pollForActionable(conn, { timeoutMs: 2000, pollMs: 1, kinds: ["authorize-button"] });
  assert.deepEqual(hit, { kind: "authorize-button", x: 7, y: 8, disabled: false });
  assert.equal(conn.calls.filter((c) => c.method === "Input.dispatchMouseEvent").length, 0);
});

test("pollForActionable: returns a field kind immediately when in kinds", async () => {
  const conn = new ScriptedConn({ script: [{ kind: "email-field", x: 5, y: 6 }] });
  const hit = await pollForActionable(conn, { timeoutMs: 500, pollMs: 1, kinds: ["email-field", "password-field"] });
  assert.deepEqual(hit, { kind: "email-field", x: 5, y: 6 });
});

test("pollForActionable: field kind NOT in kinds keeps polling", async () => {
  const conn = new ScriptedConn({ script: [{ kind: "email-field", x: 5, y: 6 }], repeatLast: true });
  await assert.rejects(
    pollForActionable(conn, { timeoutMs: 40, pollMs: 5, kinds: ["authorize-button"] }),
    PollTimeoutError,
  );
});

test("pollForActionable: timeout throws PollTimeoutError carrying the last classification", async () => {
  const conn = new ScriptedConn({
    script: [
      { kind: "authorize-button", x: 1, y: 2, disabled: true },
      { kind: "authorize-button", x: 1, y: 2, disabled: true },
    ],
    repeatLast: true,
  });
  const err = await pollForActionable(conn, { timeoutMs: 60, pollMs: 5, kinds: ["authorize-button"] }).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof PollTimeoutError, `expected PollTimeoutError, got ${String(err)}`);
  assert.equal(err.name, "PollTimeoutError");
  assert.match(err.message, /authorize-button/);
  assert.deepEqual(err.last, { kind: "authorize-button", x: 1, y: 2, disabled: true });
});

test("pollForActionable: hostile eval values parse to unknown and time out cleanly", async () => {
  const conn = new ScriptedConn({ script: [null, 42, "garbage", {}], repeatLast: true });
  const err = await pollForActionable(conn, { timeoutMs: 50, pollMs: 5, kinds: ["email-field"] }).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof PollTimeoutError);
  assert.equal(err.last.kind, "unknown");
});
