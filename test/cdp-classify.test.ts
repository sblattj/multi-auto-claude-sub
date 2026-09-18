import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseClassification,
  PAGE_CLASSIFIER_EXPR,
  EMAIL_FIELD_EXPR,
  PASSWORD_FIELD_EXPR,
  CONTINUE_BUTTON_EXPR,
} from "../src/cdp/classify.js";

test("parseClassification: nullish and primitives -> unknown", () => {
  for (const hostile of [null, undefined, 0, 42, "", "authorize-button", true, Number.NaN]) {
    assert.deepEqual(parseClassification(hostile), { kind: "unknown" }, `input ${String(hostile)}`);
  }
});

test("parseClassification: arrays and functions -> unknown", () => {
  assert.deepEqual(parseClassification([]), { kind: "unknown" });
  assert.deepEqual(parseClassification([{ kind: "email-field" }]), { kind: "unknown" });
  assert.deepEqual(parseClassification(() => {}), { kind: "unknown" });
});

test("parseClassification: empty or kind-less object -> unknown kind (coords kept)", () => {
  assert.deepEqual(parseClassification({}), { kind: "unknown" });
  assert.deepEqual(parseClassification({ x: 1, y: 2 }), { kind: "unknown", x: 1, y: 2 });
});

test("parseClassification: unknown kind string -> unknown kind (coords kept)", () => {
  assert.deepEqual(parseClassification({ kind: "evil", x: 1 }), { kind: "unknown", x: 1 });
  assert.deepEqual(parseClassification({ kind: "Authorize-Button" }), { kind: "unknown" });
});

test("parseClassification: every valid kind passes through", () => {
  const kinds = [
    ["authorize-button", { kind: "authorize-button", x: 10.5, y: 20.5, disabled: true }],
    ["authorize-button enabled", { kind: "authorize-button", x: 1, y: 2, disabled: false }],
    ["email-field", { kind: "email-field", x: 3, y: 4 }],
    ["password-field", { kind: "password-field", x: 5, y: 6 }],
    ["otp-wait", { kind: "otp-wait" }],
    ["unknown", { kind: "unknown" }],
    ["callback", { kind: "callback" }],
  ] as const;
  for (const [, input] of kinds) {
    assert.deepEqual(parseClassification(input), input);
  }
});

test("parseClassification: non-finite or non-number coords are dropped, not coerced", () => {
  const c = parseClassification({ kind: "email-field", x: "12", y: Number.NaN });
  assert.equal(c.kind, "email-field");
  assert.equal("x" in c, false);
  assert.equal("y" in c, false);
  const inf = parseClassification({ kind: "email-field", x: Infinity, y: 8 });
  assert.equal("x" in inf, false);
  assert.equal(inf.y, 8);
});

test("parseClassification: non-boolean disabled is dropped", () => {
  const c = parseClassification({ kind: "authorize-button", x: 1, y: 2, disabled: "true" });
  assert.equal(c.disabled, undefined);
  assert.equal("disabled" in c, false);
  assert.equal(parseClassification({ kind: "authorize-button", disabled: true }).disabled, true);
});

test("parseClassification: null kind value -> unknown kind (valid coords still kept)", () => {
  assert.deepEqual(parseClassification({ kind: null, x: 1, y: 2 }), { kind: "unknown", x: 1, y: 2 });
});

test("classifier expression sanity (structure only — live eval is the optional live test)", () => {
  assert.equal(typeof PAGE_CLASSIFIER_EXPR, "string");
  assert.match(PAGE_CLASSIFIER_EXPR, /localhost/);
  assert.match(PAGE_CLASSIFIER_EXPR, /authorize-button/);
  assert.match(PAGE_CLASSIFIER_EXPR, /input\[type=['"]?email['"]?\]/);
  assert.match(PAGE_CLASSIFIER_EXPR, /verification code|one-time/);
  assert.equal(PAGE_CLASSIFIER_EXPR.startsWith("(() => {"), true);
  assert.equal(PAGE_CLASSIFIER_EXPR.endsWith("})()"), true);
  assert.match(EMAIL_FIELD_EXPR, /input\[type=['"]?email['"]?\]/);
  assert.match(PAGE_CLASSIFIER_EXPR, new RegExp(EMAIL_FIELD_EXPR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(PASSWORD_FIELD_EXPR, /input\[type=['"]?password['"]?\]/);
  assert.match(CONTINUE_BUTTON_EXPR, /continue|next|log/);
});
