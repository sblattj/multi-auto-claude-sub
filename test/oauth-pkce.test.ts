import test from "node:test";
import assert from "node:assert/strict";
import { challenge, generateVerifier, isVerifierShaped, randomState } from "../src/oauth/pkce.js";

test("pkce: RFC 7636 appendix B vector", () => {
  assert.equal(
    challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("pkce: challenge output is 43-char unpadded base64url", () => {
  const c = challenge(generateVerifier());
  assert.match(c, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!c.includes("="));
});

test("pkce: generateVerifier produces RFC 7636 unreserved chars, 43-128 length", () => {
  for (let i = 0; i < 200; i++) {
    const v = generateVerifier();
    assert.ok(isVerifierShaped(v), `bad verifier: ${v}`);
    assert.ok(v.length >= 43 && v.length <= 128);
  }
  const set = new Set(Array.from({ length: 100 }, () => generateVerifier()));
  assert.equal(set.size, 100);
});

test("pkce: randomState is unique and url-safe", () => {
  const states = Array.from({ length: 100 }, () => randomState());
  assert.equal(new Set(states).size, 100);
  for (const s of states) {
    assert.match(s, /^[A-Za-z0-9_-]+$/);
    assert.ok(s.length >= 16);
  }
});
