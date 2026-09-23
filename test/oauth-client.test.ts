import test from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_AI_SCOPES,
  CLIENT_ID,
  MalformedTokenResponseError,
  OAuthClient,
  OAuthError,
  TOKEN_URL,
  type FetchImpl,
  type FetchRequestInit,
} from "../src/oauth/client.js";

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

const NOW = 1_800_000_000_000;

/** What platform.claude.com/v1/oauth/token actually returns: OAuth snake_case, seconds. */
const TOKEN_BODY = {
  token_type: "Bearer",
  access_token: "sk-ant-atok-test-abc",
  refresh_token: "sk-ant-rtok-test-def",
  expires_in: 28_800,
  refresh_token_expires_in: 1_900_000,
  scope: "user:profile user:inference user:sessions:claude_code",
};

function bodyOf(call: Call): Record<string, unknown> {
  return JSON.parse(call.init.body ?? "{}") as Record<string, unknown>;
}

test("client: refreshTokens sends JSON with scope and converts the snake_case response", async () => {
  const { calls, fetch } = stubFetch(() => jsonResponse(TOKEN_BODY));
  const client = new OAuthClient(fetch, () => NOW);
  const oauth = await client.refreshTokens("sk-ant-rtok-old");

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, TOKEN_URL);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers["content-type"], "application/json");
  assert.ok(call.init.signal instanceof AbortSignal, "token requests carry a timeout signal");
  assert.deepEqual(bodyOf(call), {
    grant_type: "refresh_token",
    refresh_token: "sk-ant-rtok-old",
    client_id: CLIENT_ID,
    scope: CLAUDE_AI_SCOPES.join(" "),
  });

  assert.deepEqual(oauth, {
    accessToken: "sk-ant-atok-test-abc",
    refreshToken: "sk-ant-rtok-test-def",
    expiresAt: NOW + 28_800_000,
    refreshTokenExpiresAt: NOW + 1_900_000_000,
    scopes: ["user:profile", "user:inference", "user:sessions:claude_code"],
  });
  assert.equal("access_token" in oauth, false, "raw snake_case keys are not stored");
});

test("client: refreshTokens requests the previous scopes and keeps omitted fields + extras", async () => {
  const { calls, fetch } = stubFetch(() => jsonResponse({ access_token: "sk-ant-atok-2", expires_in: 3600 }));
  const client = new OAuthClient(fetch, () => NOW);
  const prev = {
    accessToken: "sk-ant-atok-1",
    refreshToken: "sk-ant-rtok-1",
    expiresAt: NOW - 1,
    refreshTokenExpiresAt: NOW + 5_000_000,
    scopes: ["user:inference"],
    subscriptionType: "max",
  };
  const oauth = await client.refreshTokens("sk-ant-rtok-1", prev);

  assert.equal(bodyOf(calls[0]!).scope, "user:inference");
  assert.equal(oauth.accessToken, "sk-ant-atok-2");
  assert.equal(oauth.refreshToken, "sk-ant-rtok-1", "no rotation in the response: keep the old token");
  assert.equal(oauth.expiresAt, NOW + 3_600_000);
  assert.equal(oauth.refreshTokenExpiresAt, NOW + 5_000_000);
  assert.deepEqual(oauth.scopes, ["user:inference"]);
  assert.equal(oauth.subscriptionType, "max");
});

test("client: exchangeCode sends JSON incl. state and parses the snake_case response", async () => {
  const { calls, fetch } = stubFetch(() => jsonResponse(TOKEN_BODY));
  const client = new OAuthClient(fetch, () => NOW);
  const oauth = await client.exchangeCode({
    code: "ac_12345",
    redirectUri: "http://localhost:4242/callback",
    codeVerifier: "v".padEnd(43, "v"),
    state: "st-1",
  });
  assert.equal(oauth.accessToken, TOKEN_BODY.access_token);
  assert.equal(oauth.refreshToken, TOKEN_BODY.refresh_token);
  assert.equal(oauth.expiresAt, NOW + 28_800_000);

  assert.equal(calls[0]!.init.headers["content-type"], "application/json");
  assert.deepEqual(bodyOf(calls[0]!), {
    grant_type: "authorization_code",
    code: "ac_12345",
    redirect_uri: "http://localhost:4242/callback",
    client_id: CLIENT_ID,
    code_verifier: "vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv",
    state: "st-1",
  });
});

test("client: exchangeCode without refresh_token_expires_in falls back to 30 days", async () => {
  const { fetch } = stubFetch(() => jsonResponse({ access_token: "a", refresh_token: "r", expires_in: 60 }));
  const oauth = await new OAuthClient(fetch, () => NOW).exchangeCode({
    code: "c",
    redirectUri: "http://localhost:1/callback",
    codeVerifier: "v".padEnd(43, "v"),
    state: "s",
  });
  assert.equal(oauth.refreshTokenExpiresAt, NOW + 30 * 86_400_000);
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

test("client: Anthropic error envelope (HTTP 429) maps type + message", async () => {
  const { fetch } = stubFetch(() =>
    jsonResponse({ error: { type: "rate_limit_error", message: "Rate limited. Please try again later." } }, 429),
  );
  await assert.rejects(new OAuthClient(fetch).refreshTokens("x"), (err: unknown) => {
    assert.ok(err instanceof OAuthError);
    assert.equal(err.code, "rate_limit_error");
    assert.equal(err.status, 429);
    assert.match(err.message, /Rate limited/);
    return true;
  });
});

test("client: missing or mistyped required fields throw MalformedTokenResponseError", async () => {
  const missingAccess = stubFetch(() => jsonResponse({ refresh_token: "b", expires_in: 1 }));
  await assert.rejects(
    new OAuthClient(missingAccess.fetch).refreshTokens("x"),
    (e: unknown) => e instanceof MalformedTokenResponseError && /access_token/.test((e as Error).message),
  );

  const missingRefresh = stubFetch(() => jsonResponse({ access_token: "a", expires_in: 1 }));
  await assert.rejects(
    new OAuthClient(missingRefresh.fetch).exchangeCode({ code: "c", redirectUri: "r", codeVerifier: "v", state: "s" }),
    (e: unknown) => e instanceof MalformedTokenResponseError && /refresh_token/.test((e as Error).message),
  );

  const stringExpiry = stubFetch(() => jsonResponse({ access_token: "a", refresh_token: "b", expires_in: "123" }));
  await assert.rejects(
    new OAuthClient(stringExpiry.fetch).refreshTokens("x"),
    (e: unknown) => e instanceof MalformedTokenResponseError && /expires_in/.test((e as Error).message),
  );

  // the old camelCase shape is what Claude Code STORES, never what the server sends
  const camel = stubFetch(() =>
    jsonResponse({ accessToken: "a", refreshToken: "b", expiresAt: 1, refreshTokenExpiresAt: 2 }),
  );
  await assert.rejects(new OAuthClient(camel.fetch).refreshTokens("x"), MalformedTokenResponseError);

  const notJson = stubFetch(() => new Response("<html>", { status: 200 }));
  await assert.rejects(
    new OAuthClient(notJson.fetch).refreshTokens("x"),
    MalformedTokenResponseError,
  );
});
