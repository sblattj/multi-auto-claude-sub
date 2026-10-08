import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLoginTimeoutMs } from "../src/util/duration.js";

test("resolveLoginTimeoutMs: flag beats env beats default", () => {
  assert.equal(resolveLoginTimeoutMs("10m", { MACSUB_LOGIN_TIMEOUT: "5m" }, 180_000), 600_000);
  assert.equal(resolveLoginTimeoutMs(undefined, { MACSUB_LOGIN_TIMEOUT: "5m" }, 180_000), 300_000);
  assert.equal(resolveLoginTimeoutMs(undefined, {}, 180_000), 180_000);
  assert.equal(resolveLoginTimeoutMs(undefined, { MACSUB_LOGIN_TIMEOUT: "  " }, 180_000), 180_000);
});

test("resolveLoginTimeoutMs: a bad flag throws", () => {
  assert.throws(() => resolveLoginTimeoutMs("soon", {}, 1), /bad duration "soon"/);
  assert.throws(() => resolveLoginTimeoutMs("0s", {}, 1), /greater than zero/);
});

test("resolveLoginTimeoutMs: a bad env value is reported and ignored", () => {
  const warned: string[] = [];
  assert.equal(resolveLoginTimeoutMs(undefined, { MACSUB_LOGIN_TIMEOUT: "forever" }, 180_000, (m) => warned.push(m)), 180_000);
  assert.equal(resolveLoginTimeoutMs(undefined, { MACSUB_LOGIN_TIMEOUT: "0" }, 180_000, (m) => warned.push(m)), 180_000);
  assert.equal(warned.length, 2);
  assert.match(warned[0] ?? "", /MACSUB_LOGIN_TIMEOUT="forever"/);
});
