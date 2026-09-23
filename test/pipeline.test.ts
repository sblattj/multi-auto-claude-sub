import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildAuthorizeUrl, ensureHealthy, refreshAccount } from "../src/pipeline.js";
import { CLIENT_ID, type FetchImpl } from "../src/oauth/client.js";
import type { TokenRefresher } from "../src/oauth/health.js";
import type { runLoginAgent } from "../src/cdp/agent.js";
import type {
  AccountRecord,
  ActiveState,
  ClaudeAiOauth,
  CredentialBlob,
  OauthAccount,
  Vault,
} from "../src/types.js";

const HOUR = 3_600_000;

function oauth(tag: string, expiresAt: number): ClaudeAiOauth {
  return {
    accessToken: `sk-ant-fake-access-${tag}`,
    refreshToken: `sk-ant-fake-refresh-${tag}`,
    expiresAt,
    refreshTokenExpiresAt: Date.now() + 100 * HOUR,
    scopes: ["user:inference"],
  };
}

function acc(email: string): OauthAccount {
  return { emailAddress: email, accountUuid: `uuid-${email}`, organizationUuid: `org-${email}` };
}

/** vaulted record whose access token has expired (needs L1) */
function staleRec(name = "beta"): AccountRecord {
  return {
    name,
    credential: { claudeAiOauth: oauth(`${name}-old`, Date.now() - HOUR) },
    oauthAccount: acc(`${name}@example.com`),
    savedAt: 1_000,
  };
}

class FakeVault implements Vault {
  records = new Map<string, AccountRecord>();
  active: string | null = null;
  async list(): Promise<AccountRecord[]> {
    return [...this.records.values()];
  }
  async get(name: string): Promise<AccountRecord | null> {
    return this.records.get(name) ?? null;
  }
  async save(r: AccountRecord): Promise<void> {
    this.records.set(r.name, r);
  }
  async remove(name: string): Promise<void> {
    this.records.delete(name);
  }
  async activeAccount(): Promise<string | null> {
    return this.active;
  }
  async setActive(name: string | null): Promise<void> {
    this.active = name;
  }
}

class FakeActive implements ActiveState {
  writes: CredentialBlob[] = [];
  merges: OauthAccount[] = [];
  constructor(
    public cred: CredentialBlob | null = null,
    public account: OauthAccount | null = null,
  ) {}
  platform(): NodeJS.Platform {
    return "darwin";
  }
  async readCredential(): Promise<CredentialBlob | null> {
    return this.cred;
  }
  async writeCredential(b: CredentialBlob): Promise<void> {
    this.writes.push(b);
    this.cred = b;
  }
  async readOauthAccount(): Promise<OauthAccount | null> {
    return this.account;
  }
  async mergeOauthAccount(a: OauthAccount): Promise<void> {
    this.merges.push(a);
  }
}

class FakeRefresher implements TokenRefresher {
  calls: string[] = [];
  onCall: () => void = () => {};
  constructor(private readonly result: ClaudeAiOauth | Error) {}
  async refreshTokens(refreshToken: string): Promise<ClaudeAiOauth> {
    this.calls.push(refreshToken);
    this.onCall();
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

async function tmpEnv(): Promise<{ env: NodeJS.ProcessEnv; home: string; refreshLock: string; claudeLock: string }> {
  const home = await mkdtemp(join(tmpdir(), "macsub-pipeline-"));
  return {
    env: { HOME: home, CLAUDE_CONFIG_DIR: join(home, "cc") },
    home,
    refreshLock: join(home, "cc", ".oauth_refresh.lock"),
    claudeLock: join(home, ".claude.lock"),
  };
}

test("buildAuthorizeUrl: claude.ai subscription login, as Claude Code builds it", () => {
  const url = new URL(
    buildAuthorizeUrl({
      redirectUri: "http://localhost:4242/callback",
      codeChallenge: "chal",
      state: "st",
      loginHint: "me@example.com",
    }),
  );
  assert.equal(url.origin + url.pathname, "https://claude.com/cai/oauth/authorize");
  const p = url.searchParams;
  assert.equal(p.get("code"), "true");
  assert.equal(p.get("client_id"), CLIENT_ID);
  assert.equal(p.get("response_type"), "code");
  assert.equal(p.get("redirect_uri"), "http://localhost:4242/callback");
  assert.equal(p.get("code_challenge"), "chal");
  assert.equal(p.get("code_challenge_method"), "S256");
  assert.equal(p.get("state"), "st");
  assert.equal(p.get("login_hint"), "me@example.com");
  const scopes = (p.get("scope") ?? "").split(" ");
  for (const s of ["user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers"]) {
    assert.ok(scopes.includes(s), `scope ${s}`);
  }
});

test("buildAuthorizeUrl: no login_hint for a placeholder identity", () => {
  const base = { redirectUri: "http://localhost:1/callback", codeChallenge: "c", state: "s" };
  assert.equal(new URL(buildAuthorizeUrl({ ...base, loginHint: "(unknown)" })).searchParams.has("login_hint"), false);
  assert.equal(new URL(buildAuthorizeUrl(base)).searchParams.has("login_hint"), false);
});

test("refreshAccount (live account): a newer live credential is adopted, no refresh token spent", async (t) => {
  const { env, home } = await tmpEnv();
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = new FakeVault();
  vault.records.set("beta", staleRec());
  vault.active = "beta";
  // a running Claude Code session already refreshed the installed token
  const live = { claudeAiOauth: oauth("beta-refreshed-by-cc", Date.now() + 8 * HOUR) };
  const active = new FakeActive(live, acc("beta@example.com"));
  const client = new FakeRefresher(new Error("must not be called"));

  const r = await refreshAccount(vault, active, "beta", client, { env });

  assert.equal(r.level, "fresh");
  assert.match(r.detail ?? "", /adopted the live credential/);
  assert.equal(client.calls.length, 0);
  assert.deepEqual(vault.records.get("beta")!.credential, live);
  assert.equal(active.writes.length, 0, "live state already holds it");
});

test("refreshAccount (live account): refresh runs under Claude Code's refresh locks, then installs", async (t) => {
  const { env, home, refreshLock, claudeLock } = await tmpEnv();
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = new FakeVault();
  const rec = staleRec();
  vault.records.set("beta", rec);
  vault.active = "beta";
  const active = new FakeActive(rec.credential, acc("beta@example.com"));
  const fresh = oauth("beta-new", Date.now() + 8 * HOUR);
  const client = new FakeRefresher(fresh);
  let lockedDuringPost = false;
  client.onCall = () => {
    lockedDuringPost = existsSync(refreshLock) && existsSync(claudeLock);
  };

  const r = await refreshAccount(vault, active, "beta", client, { env });

  assert.equal(r.level, "refreshed");
  assert.ok(lockedDuringPost, "no Claude Code session can spend the same refresh token meanwhile");
  assert.deepEqual(client.calls, ["sk-ant-fake-refresh-beta-old"]);
  assert.deepEqual(vault.records.get("beta")!.credential.claudeAiOauth, fresh);
  assert.deepEqual(active.writes, [{ claudeAiOauth: fresh }]);
  assert.deepEqual(active.merges, [rec.oauthAccount]);
  assert.ok(!existsSync(refreshLock) && !existsSync(claudeLock), "locks released");
});

test("refreshAccount (live account): a live credential for another email is never adopted", async (t) => {
  const { env, home } = await tmpEnv();
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = new FakeVault();
  vault.records.set("beta", staleRec());
  vault.active = "beta";
  const active = new FakeActive(
    { claudeAiOauth: oauth("someone-else", Date.now() + 8 * HOUR) },
    acc("other@example.com"),
  );
  const client = new FakeRefresher(oauth("beta-new", Date.now() + 8 * HOUR));

  const r = await refreshAccount(vault, active, "beta", client, { env });

  assert.equal(r.level, "refreshed");
  assert.deepEqual(client.calls, ["sk-ant-fake-refresh-beta-old"]);
});

test("refreshAccount (vault-only account): no locks, no live writes", async (t) => {
  const { env, home, refreshLock } = await tmpEnv();
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = new FakeVault();
  vault.records.set("beta", staleRec());
  vault.active = "alpha";
  const active = new FakeActive();
  const client = new FakeRefresher(oauth("beta-new", Date.now() + 8 * HOUR));
  let locked = true;
  client.onCall = () => {
    locked = existsSync(refreshLock);
  };

  const r = await refreshAccount(vault, active, "beta", client, { env });

  assert.equal(r.level, "refreshed");
  assert.equal(locked, false);
  assert.equal(active.writes.length, 0);
});

test("ensureHealthy: failed refresh + failed browser login -> both reasons in the detail", async (t) => {
  const { env, home } = await tmpEnv();
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = new FakeVault();
  vault.records.set("beta", staleRec());
  vault.active = "alpha";
  const fetchImpl: FetchImpl = async () =>
    new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "Rate limited." } }), { status: 429 });

  let authorizeUrl = "";
  let listenerAfterTimeout = "";
  const loginAgent: typeof runLoginAgent = async (url, opts, deps) => {
    authorizeUrl = url;
    const handle = await deps!.startCallbackListener!();
    // the listener must outlive the agent's own deadline, or it masks the agent's detail
    listenerAfterTimeout = await Promise.race([
      handle.done.then(
        () => "code",
        (e: Error) => `rejected: ${e.message}`,
      ),
      new Promise<string>((r) => setTimeout(() => r("pending"), (opts.timeoutMs ?? 0) * 3)),
    ]);
    handle.close();
    return { success: false, stage: "timeout", detail: "no authorization after 20ms (last page state: otp-wait at claude.ai/magic-link)" };
  };

  const r = await ensureHealthy(vault, new FakeActive(), "beta", {
    env,
    fetchImpl,
    loginAgent,
    loginTimeoutMs: 20,
    onNotify: () => {},
  });

  assert.equal(r.level, "needs-manual-login");
  assert.match(r.detail ?? "", /refresh: oauth error rate_limit_error \(HTTP 429\): Rate limited\./);
  assert.match(r.detail ?? "", /browser: .*last page state: otp-wait at claude\.ai\/magic-link/);
  assert.equal(listenerAfterTimeout, "pending");
  const u = new URL(authorizeUrl);
  assert.equal(u.origin + u.pathname, "https://claude.com/cai/oauth/authorize");
  assert.equal(u.searchParams.get("login_hint"), "beta@example.com");
});

test("ensureHealthy: invalid_grant from the token endpoint reaches the final detail", async (t) => {
  const { env, home } = await tmpEnv();
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = new FakeVault();
  vault.records.set("beta", staleRec());
  const fetchImpl: FetchImpl = async () =>
    new Response(JSON.stringify({ error: "invalid_grant", error_description: "Refresh token revoked" }), { status: 400 });
  const loginAgent: typeof runLoginAgent = async () => ({ success: false, stage: "no-chrome", detail: "no Chrome" });

  const r = await ensureHealthy(vault, new FakeActive(), "beta", { env, fetchImpl, loginAgent, onNotify: () => {} });
  assert.match(r.detail ?? "", /refresh: oauth error invalid_grant \(HTTP 400\): Refresh token revoked/);
  assert.match(r.detail ?? "", /browser: no Chrome/);
});
