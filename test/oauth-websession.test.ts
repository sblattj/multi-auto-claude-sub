import test from "node:test";
import assert from "node:assert/strict";
import { challenge, isVerifierShaped } from "../src/oauth/pkce.js";
import { CLIENT_ID, TOKEN_URL, type FetchImpl, type FetchRequestInit } from "../src/oauth/client.js";
import { EmailMismatchError, REDIRECT_URI, StaleSessionError, websessionLogin } from "../src/oauth/websession.js";

interface Call {
  url: string;
  init: FetchRequestInit;
}

const SESSION_KEY = "sk-ant-sid01-test-session-key";
const ORG = "org-uuid-abc123";
const EMAIL = "user@example.com";

const ACCOUNT_OK = {
  status: 200,
  body: {
    account: { email_address: EMAIL, uuid: "acc-1" },
    memberships: [{ organization: { uuid: ORG, name: "Acme" }, role: "member" }],
  },
};

function authzOk(code: string): { status: number; body: unknown } {
  return { status: 200, body: { authorization_code: code } };
}

const TOKEN_OK = {
  status: 200,
  body: {
    accessToken: "sk-ant-atok-new",
    refreshToken: "sk-ant-rtok-new",
    expiresAt: 1_900_000_000_000,
    refreshTokenExpiresAt: 2_000_000_000_000,
    scopes: ["user:inference", "user:sessions:claude_code"],
  },
};

function stubFetch(responses: Array<{ status: number; body: unknown }>): { calls: Call[]; fetch: FetchImpl } {
  const calls: Call[] = [];
  const fetch: FetchImpl = async (url, init) => {
    const n = calls.length;
    calls.push({ url: String(url), init });
    const r = responses[n];
    if (r === undefined) throw new Error(`unexpected fetch #${n}: ${String(url)}`);
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetch };
}

test("websession: full happy path — URL/headers/body of all three calls", async () => {
  const { calls, fetch } = stubFetch([ACCOUNT_OK, authzOk("auth_code_1"), TOKEN_OK]);

  const blob = await websessionLogin(SESSION_KEY, EMAIL, fetch);

  assert.equal(calls.length, 3);
  assert.equal(blob.claudeAiOauth.accessToken, "sk-ant-atok-new");
  assert.equal(blob.claudeAiOauth.refreshToken, "sk-ant-rtok-new");

  // call 1: account lookup
  const c0 = calls[0]!;
  assert.equal(c0.url, "https://claude.ai/api/account");
  assert.equal(c0.init.method, "GET");
  assert.equal(c0.init.headers.cookie, `sessionKey=${SESSION_KEY}`);
  assert.equal(c0.init.body, undefined);

  // call 2: authorize
  const c1 = calls[1]!;
  assert.equal(c1.url, `https://claude.ai/v1/oauth/${ORG}/authorize`);
  assert.equal(c1.init.method, "POST");
  assert.equal(c1.init.headers.origin, "https://claude.ai");
  assert.equal(c1.init.headers.referer, "https://claude.ai/");
  assert.equal(c1.init.headers.cookie, `sessionKey=${SESSION_KEY}`);
  assert.equal(c1.init.headers["content-type"], "application/json");
  const body1 = JSON.parse(c1.init.body ?? "{}") as Record<string, unknown>;
  assert.equal(body1.client_id, CLIENT_ID);
  assert.equal(body1.response_type, "code");
  assert.equal(body1.scope, "user:inference user:sessions:claude_code");
  assert.equal(body1.code_challenge_method, "S256");
  assert.equal(body1.redirect_uri, REDIRECT_URI);
  const ch = body1.code_challenge;
  assert.equal(typeof ch, "string");
  assert.match(ch as string, /^[A-Za-z0-9_-]{43}$/);

  // call 3: exchange
  const c2 = calls[2]!;
  assert.equal(c2.url, TOKEN_URL);
  assert.equal(c2.init.method, "POST");
  const form = new URLSearchParams(c2.init.body ?? "");
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "auth_code_1");
  assert.equal(form.get("redirect_uri"), REDIRECT_URI);
  const verifier = form.get("code_verifier") ?? "";
  assert.ok(isVerifierShaped(verifier), `code_verifier not RFC 7636 shaped: ${verifier}`);
  assert.equal(challenge(verifier), ch, "code_challenge must be S256(code_verifier)");
});

test("websession: email mismatch is a typed error, no authorize call made", async () => {
  const { calls, fetch } = stubFetch([
    { status: 200, body: { ...ACCOUNT_OK.body, account: { email_address: "other@example.com" } } },
    authzOk("should-not-happen"),
    TOKEN_OK,
  ]);

  await assert.rejects(websessionLogin(SESSION_KEY, EMAIL, fetch), (err: unknown) => {
    assert.ok(err instanceof EmailMismatchError);
    assert.equal(err.expectedEmail, EMAIL);
    assert.equal(err.actualEmail, "other@example.com");
    return true;
  });
  assert.equal(calls.length, 1);
});

test("websession: session_stale_relogin retries once with user:inference-only scopes", async () => {
  const stale = { status: 400, body: { error: "session_stale_relogin" } };
  const { calls, fetch } = stubFetch([ACCOUNT_OK, stale, authzOk("auth_code_2"), TOKEN_OK]);

  const blob = await websessionLogin(SESSION_KEY, EMAIL, fetch);
  assert.equal(blob.claudeAiOauth.accessToken, "sk-ant-atok-new");
  assert.equal(calls.length, 4);

  const retryBody = JSON.parse(calls[2]!.init.body ?? "{}") as Record<string, unknown>;
  assert.equal(calls[2]!.url, `https://claude.ai/v1/oauth/${ORG}/authorize`);
  assert.equal(retryBody.scope, "user:inference");

  const form = new URLSearchParams(calls[3]!.init.body ?? "");
  assert.equal(form.get("code"), "auth_code_2");
  assert.equal(calls[3]!.url, TOKEN_URL);
});

test("websession: double stale throws StaleSessionError", async () => {
  const stale = { status: 400, body: { error: "session_stale_relogin" } };
  const { calls, fetch } = stubFetch([ACCOUNT_OK, stale, stale]);

  await assert.rejects(websessionLogin(SESSION_KEY, EMAIL, fetch), (err: unknown) => {
    assert.ok(err instanceof StaleSessionError);
    return true;
  });
  assert.equal(calls.length, 3);
});

test("websession: non-stale authorize error propagates without retry", async () => {
  const { calls, fetch } = stubFetch([
    ACCOUNT_OK,
    { status: 400, body: { error: "invalid_organization" } },
  ]);
  await assert.rejects(websessionLogin(SESSION_KEY, EMAIL, fetch), /invalid_organization/);
  assert.equal(calls.length, 2);
});

test("websession: email comparison is case-insensitive", async () => {
  const { calls, fetch } = stubFetch([ACCOUNT_OK, authzOk("c"), TOKEN_OK]);
  const blob = await websessionLogin(SESSION_KEY, "USER@Example.COM", fetch);
  assert.ok(blob.claudeAiOauth);
  assert.equal(calls.length, 3);
});
