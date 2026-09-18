import { test } from "node:test";
import assert from "node:assert/strict";
import { focusAndType, FillError } from "../src/cdp/fill.js";
import { EMAIL_FIELD_EXPR } from "../src/cdp/classify.js";
import { ScriptedConn } from "./helpers.js";

test("focusAndType: happy path — focus, verify, insertText, value-verify + input/change events", async () => {
  const conn = new ScriptedConn({
    script: [{ ok: true }, { focused: true }, { ok: true }],
  });
  await focusAndType(conn, EMAIL_FIELD_EXPR, "me@example.com");
  const inserts = conn.sendsOf("Input.insertText");
  assert.equal(inserts.length, 1);
  assert.deepEqual(inserts[0], { text: "me@example.com" });
  // third eval dispatches React insurance events
  assert.match(conn.evals[2] ?? "", /dispatchEvent/);
  assert.match(conn.evals[2] ?? "", /"input"/);
  assert.match(conn.evals[2] ?? "", /"change"/);
  // and the value check embeds the text safely
  assert.match(conn.evals[2] ?? "", /me@example\.com/);
});

test("focusAndType TWO-GATE: activeElement check fails -> NO Input.insertText is sent", async () => {
  const conn = new ScriptedConn({
    script: [{ ok: true }, { focused: false }],
  });
  const err = await focusAndType(conn, EMAIL_FIELD_EXPR, "secret-text").then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof FillError);
  assert.equal(err.gate, "focus");
  assert.match(err.message, /two-gate/);
  assert.equal(conn.sendsOf("Input.insertText").length, 0, "insertText must NOT be called");
});

test("focusAndType: element not found -> locate gate error, no insertText", async () => {
  const conn = new ScriptedConn({ script: [{ ok: false, reason: "element not found" }] });
  const err = await focusAndType(conn, EMAIL_FIELD_EXPR, "x@y.z").then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof FillError);
  assert.equal(err.gate, "locate");
  assert.equal(conn.sendsOf("Input.insertText").length, 0);
});

test("focusAndType: hostile eval returns (null/garbage) -> gate failure, no insertText", async () => {
  for (const v of [null, undefined, 42, "nope"]) {
    const conn = new ScriptedConn({ script: [v] });
    const err = await focusAndType(conn, EMAIL_FIELD_EXPR, "x").then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof FillError, `hostile focus value ${String(v)}`);
    assert.equal(conn.sendsOf("Input.insertText").length, 0);
  }
});

test("focusAndType: post-insert value verification failure throws", async () => {
  const conn = new ScriptedConn({ script: [{ ok: true }, { focused: true }, { ok: false }] });
  const err = await focusAndType(conn, EMAIL_FIELD_EXPR, "typed-text").then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof FillError);
  assert.equal(err.gate, "verify-value");
  // insertText DID run (both gates passed) — this failure is the value check
  assert.equal(conn.sendsOf("Input.insertText").length, 1);
});

test("focusAndType: insertText transport failure propagates", async () => {
  const conn = new ScriptedConn({
    script: [{ ok: true }, { focused: true }],
    throwOn: { "Input.insertText": new Error("insert boom") },
  });
  await assert.rejects(focusAndType(conn, EMAIL_FIELD_EXPR, "a@b.c"), /insert boom/);
});
