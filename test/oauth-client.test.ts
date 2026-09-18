import test from "node:test";
import assert from "node:assert/strict";
import { CLIENT_ID, MalformedTokenResponseError, OAuthClient, OAuthError, TOKEN_URL, type FetchImpl, type FetchRequestInit } from "../src/oauth/client.js";

interface Call {
  url: string;
  init: FetchRequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(handler: (call: Call, n: number) => Response | Promise<Response>): { calls: Call[]; fetch: FetchImpl } {
  const calls: Call[] = [];
  const fetch: FetchImpl = async (url, init) => {
    const call = { url: String(url), init };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { calls, fetch };
}

const TOKEN_BODY = {
  accessToken: "sk-ant-atok-test-abc",
  refreshToken: "sk-ant-rtok-test-def",
  expiresAt: 1_900_000_000_000,
  refreshTokenExpiresAt: 2_000_000_000_000,
  scopes: ["user:inference"],
  extraUnknownField: { nested: true },
};

test("client: refreshTokens happy path sends correct form body and parses extras", async () => {
  const { calls, fetch } = stubFetch(() => jsonResponse(TOKEN_BODY));
  const client = new OAuthClient(fetch);
  const oauth = await client.refreshTokens("sk-ant-rtok-old");

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, TOKEN_URL);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers["content-type"], "application/x-www-form-urlencoded");
  const form = new URLSearchParams(call.init.body ?? "");
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "sk-ant-rtok-old");
  assert.equal(form.get("client_id"), CLIENT_ID);

  assert.equal(oauth.accessToken, TOKEN_BODY.accessToken);
  assert.equal(oauth.refreshToken, TOKEN_BODY.refreshToken);
  assert.equal(oauth.expiresAt, TOKEN_BODY.expiresAt);
  assert.equal(oauth.refreshTokenExpiresAt, TOKEN_BODY.refreshTokenExpiresAt);
  assert.deepEqual(oauth.scopes, ["user:inference"]);
  assert.deepEqual(oauth.extraUnknownField, { nested: true });
});

test("client: exchangeCode happy path", async () => {
  const { calls, fetch } = stubFetch(() => jsonResponse(TOKEN_BODY));
  const client = new OAuthClient(fetch);
  const oauth = await client.exchangeCode({
    code: "ac_12345",
    redirectUri: "https://console.anthropic.com/oauth/code/callback",
    codeVerifier: "v".padEnd(43, "v"),
  });
  assert.equal(oauth.accessToken, TOKEN_BODY.accessToken);

  const form = new URLSearchParams(calls[0]!.init.body ?? "");
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "ac_12345");
  assert.equal(form.get("redirect_uri"), "https://console.anthropic.com/oauth/code/callback");
  assert.equal(form.get("code_verifier"), "vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv");
  assert.equal(form.get("client_id"), CLIENT_ID);
});

test("client: HTTP 400 invalid_grant maps to OAuthError", async () => {
  const { fetch } = stubFetch(() =>
    jsonResponse({ error: "invalid_grant", error_description: "refresh token expired" }, 400),
  );
  const client = new OAuthClient(fetch);
  await assert.rejects(
    client.refreshTokens("sk-ant-rtok-old"),
    (err: unknown) => {
      assert.ok(err instanceof OAuthError);
      assert.equal(err.code, "invalid_grant");
      assert.equal(err.status, 400);
      assert.equal(err.description, "refresh token expired");
      assert.ok(err.message.includes("invalid_grant"));
      return true;
    },
  );
});

test("client: non-JSON error body maps to http_<status>", async () => {
  const { fetch } = stubFetch(
    () => new Response("bad gateway html", { status: 502, headers: { "content-type": "text/html" } }),
  );
  const client = new OAuthClient(fetch);
  await assert.rejects(client.refreshTokens("x"), (err: unknown) => {
    assert.ok(err instanceof OAuthError);
    assert.equal((err as OAuthError).code, "http_502");
    assert.equal((err as OAuthError).status, 502);
    return true;
  });
});

test("client: missing or mistyped required fields throw MalformedTokenResponseError", async () => {
  const missing = stubFetch(() => jsonResponse({ accessToken: "a", expiresAt: 1, refreshTokenExpiresAt: 2 }));
  await assert.rejects(
    new OAuthClient(missing.fetch).refreshTokens("x"),
    (e: unknown) => e instanceof MalformedTokenResponseError && /refreshToken/.test((e as Error).message),
  );

  const stringExpiry = stubFetch(() =>
    jsonResponse({ accessToken: "a", refreshToken: "b", expiresAt: "123", refreshTokenExpiresAt: 2 }),
  );
  await assert.rejects(
    new OAuthClient(stringExpiry.fetch).refreshTokens("x"),
    (e: unknown) => e instanceof MalformedTokenResponseError && /expiresAt/.test((e as Error).message),
  );

  const notJson = stubFetch(() => new Response("<html>", { status: 200 }));
  await assert.rejects(
    new OAuthClient(notJson.fetch).refreshTokens("x"),
    MalformedTokenResponseError,
  );
});
