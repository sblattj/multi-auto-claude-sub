import { test } from "node:test";
import assert from "node:assert/strict";
import { runLoginAgent } from "../src/cdp/agent.js";
import type { LoginAgentOptions } from "../src/types.js";
import { ScriptedAgentConn, deferredCallback, type ScriptedOpts } from "./helpers.js";

const AUTH_URL = "https://platform.claude.com/oauth/authorize?response_type=code";

function opts(over: Partial<LoginAgentOptions> = {}): LoginAgentOptions {
  return { email: "me@example.com", timeoutMs: 4000, pollMs: 1, ...over };
}

test("runLoginAgent: no debug endpoint -> stage no-chrome, listener still closed", async () => {
  const { handle, isClosed } = deferredCallback();
  const res = await runLoginAgent(AUTH_URL, opts(), {
    discoverBase: async () => null,
    startCallbackListener: () => handle,
  });
  assert.deepEqual(res, {
    success: false,
    stage: "no-chrome",
    detail: "no Chrome DevTools endpoint (CDP_BASE unset; probed 127.0.0.1:9222,9223,9224)",
  });
  assert.equal(isClosed(), true);
});

test("runLoginAgent: happy path — callback already captured (immediate listener)", async () => {
  const { handle, resolve } = deferredCallback();
  const conn = new ScriptedAgentConn();
  resolve({ code: "CODE123", state: "ST9" });
  const res = await runLoginAgent(AUTH_URL, opts(), {
    conn,
    startCallbackListener: () => handle,
  });
  assert.deepEqual(res, {
    success: true,
    stage: "authorized",
    callback: { code: "CODE123", state: "ST9" },
  });
  // opened its OWN tab at the authorize URL and closed it in the finally
  assert.deepEqual(conn.newTabs, [AUTH_URL]);
  assert.deepEqual(conn.closedTabs, ["T1"]);
  assert.deepEqual(conn.focusToggles(), [true, false]);
});

test("runLoginAgent: full flow — email fill, disabled authorize polling, enabled click, callback", async () => {
  const { handle, resolve, isClosed } = deferredCallback();
  const emailField = { kind: "email-field", x: 10, y: 20 };
  const script: ScriptedOpts = {
    // iter 1: classify=email; focusAndType gates; clickContinue miss
    script: [
      emailField,
      { ok: true },
      { focused: true },
      { ok: true },
      undefined,
      { kind: "authorize-button", x: 1, y: 2, disabled: true },
      { kind: "authorize-button", x: 1, y: 2, disabled: true },
      { kind: "authorize-button", x: 30, y: 40, disabled: false },
    ],
    onSend: (method, params) => {
      if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
        resolve({ code: "AUTHCODE", state: "ST" });
      }
    },
  };
  const conn = new ScriptedAgentConn(script);
  const res = await runLoginAgent(`${AUTH_URL}&state=ST`, opts(), {
    conn,
    startCallbackListener: () => handle,
  });
  assert.equal(res.success, true);
  assert.equal(res.stage, "authorized");
  assert.deepEqual(res.callback, { code: "AUTHCODE", state: "ST" });

  const inserts = conn.sendsOf("Input.insertText");
  assert.equal(inserts.length, 1);
  assert.deepEqual(inserts[0], { text: "me@example.com" });

  const mouse = conn.sendsOf("Input.dispatchMouseEvent");
  assert.ok(mouse.length >= 3, "trusted click fired");
  assert.equal(mouse[0]?.type, "mouseMoved");

  assert.deepEqual(conn.closedTabs, ["T1"]);
  assert.deepEqual(conn.focusToggles(), [true, false]);
  assert.equal(isClosed(), true);
});

test("runLoginAgent: mid-flow throw -> stage error AND tab closed + emulation disabled after the failure", async () => {
  const { handle, isClosed } = deferredCallback();
  const conn = new ScriptedAgentConn({
    script: [{ kind: "email-field", x: 1, y: 2 }, { ok: true }, { focused: true }],
    throwOn: { "Input.insertText": new Error("insert exploded") },
  });
  const res = await runLoginAgent(AUTH_URL, opts(), {
    conn,
    startCallbackListener: () => handle,
  });
  assert.equal(res.success, false);
  assert.equal(res.stage, "error");
  assert.match(res.detail ?? "", /insert exploded/);
  assert.deepEqual(conn.closedTabs, ["T1"], "tab closed even though the flow threw");

  const insertIdx = conn.calls.findIndex((c) => c.method === "Input.insertText");
  const disableIdx = conn.calls.findIndex(
    (c) => c.method === "Emulation.setFocusEmulationEnabled" && c.params.enabled === false,
  );
  assert.ok(insertIdx >= 0 && disableIdx > insertIdx, "focus disable happens AFTER the failure, in finally");
  assert.deepEqual(conn.focusToggles(), [true, false]);
  assert.equal(isClosed(), true);
});

test("runLoginAgent: timeout while otp-wait -> stage timeout, onNotify fired exactly once", async () => {
  const { handle } = deferredCallback();
  const conn = new ScriptedAgentConn({ script: [{ kind: "otp-wait" }], repeatLast: true });
  const notified: string[] = [];
  const res = await runLoginAgent(AUTH_URL, opts({ timeoutMs: 120, pollMs: 5 }), {
    conn,
    startCallbackListener: () => handle,
    onNotify: (m) => notified.push(m),
  });
  assert.equal(res.success, false);
  assert.equal(res.stage, "timeout");
  assert.match(res.detail ?? "", /otp-wait/);
  assert.equal(notified.length, 1);
  assert.match(notified[0] ?? "", /one-time code|check your email/i);
  assert.deepEqual(conn.closedTabs, ["T1"]);
});

test("runLoginAgent: password needed without opts.password -> notify once, keep polling, timeout", async () => {
  const { handle } = deferredCallback();
  const conn = new ScriptedAgentConn({ script: [{ kind: "password-field", x: 1, y: 2 }], repeatLast: true });
  const notified: string[] = [];
  const res = await runLoginAgent(AUTH_URL, opts({ timeoutMs: 120, pollMs: 5 }), {
    conn,
    startCallbackListener: () => handle,
    onNotify: (m) => notified.push(m),
  });
  assert.equal(res.stage, "timeout");
  assert.equal(notified.length, 1);
  assert.match(notified[0] ?? "", /password needed/i);
  assert.equal(conn.sendsOf("Input.insertText").length, 0, "no password insert without consent");
});

test("runLoginAgent: opts.password present -> fills the password field", async () => {
  const { handle } = deferredCallback();
  const conn = new ScriptedAgentConn({
    script: [
      { kind: "password-field", x: 1, y: 2 },
      { ok: true },
      { focused: true },
      { ok: true },
      undefined,
    ],
    repeatLast: true,
  });
  const res = await runLoginAgent(AUTH_URL, opts({ password: "hunter2", timeoutMs: 150, pollMs: 5 }), {
    conn,
    startCallbackListener: () => handle,
  });
  assert.equal(res.stage, "timeout"); // listener never resolves in this test
  const inserts = conn.sendsOf("Input.insertText");
  assert.equal(inserts.length, 1);
  assert.deepEqual(inserts[0], { text: "hunter2" });
  assert.match(conn.evals[1] ?? "", /input\[type=['"]?password['"]?\]/);
  assert.deepEqual(conn.closedTabs, ["T1"]);
});

test("runLoginAgent: callback state mismatch -> stage error, nothing exchanged", async () => {
  const { handle, resolve } = deferredCallback();
  resolve({ code: "C", state: "evil" });
  const conn = new ScriptedAgentConn();
  const res = await runLoginAgent(`${AUTH_URL}&state=expected`, opts(), {
    conn,
    startCallbackListener: () => handle,
  });
  assert.equal(res.success, false);
  assert.equal(res.stage, "error");
  assert.match(res.detail ?? "", /state mismatch/);
  assert.deepEqual(conn.closedTabs, ["T1"]);
});

test("runLoginAgent: result details never leak the authorization code", async () => {
  const { handle, resolve } = deferredCallback();
  const conn = new ScriptedAgentConn({
    script: [{ kind: "email-field", x: 1, y: 2 }],
    repeatLast: true,
  });
  resolve({ code: "sk-ant-SUPERSECRET", state: "s" });
  const res = await runLoginAgent(AUTH_URL, opts(), {
    conn,
    startCallbackListener: () => handle,
  });
  // success carries the callback structurally; error/timeout details must not embed it
  assert.equal(res.success, true);
  assert.equal(res.detail, undefined);
});

test("runLoginAgent: listener rejects mid-flow -> error detail keeps the last page state", async () => {
  let reject!: (e: Error) => void;
  const done = new Promise<{ code: string; state: string }>((_, rej) => {
    reject = rej;
  });
  done.catch(() => {});
  const conn = new ScriptedAgentConn({
    script: [{ kind: "unknown", where: "accounts.google.com/v3/signin/identifier" }],
    repeatLast: true,
  });
  setTimeout(() => reject(new Error("callback: no code captured within 50ms")), 30);
  const res = await runLoginAgent(AUTH_URL, opts({ timeoutMs: 2000, pollMs: 5 }), {
    conn,
    startCallbackListener: () => ({ done, close: () => {} }),
  });
  assert.equal(res.success, false);
  assert.equal(res.stage, "error");
  assert.match(res.detail ?? "", /no code captured/);
  assert.match(res.detail ?? "", /last page state: unknown at accounts\.google\.com\/v3\/signin\/identifier/);
  assert.deepEqual(conn.closedTabs, ["T1"]);
});

test("runLoginAgent: timeout detail names the page it stalled on", async () => {
  const { handle } = deferredCallback();
  const conn = new ScriptedAgentConn({ script: [{ kind: "otp-wait", where: "claude.ai/magic-link" }], repeatLast: true });
  const res = await runLoginAgent(AUTH_URL, opts({ timeoutMs: 60, pollMs: 5 }), {
    conn,
    startCallbackListener: () => handle,
  });
  assert.equal(res.stage, "timeout");
  assert.match(res.detail ?? "", /last page state: otp-wait at claude\.ai\/magic-link/);
});
