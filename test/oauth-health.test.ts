import test from "node:test";
import assert from "node:assert/strict";
import type { AccountRecord, ClaudeAiOauth, Vault } from "../src/types.js";
import { OAuthError } from "../src/oauth/client.js";
import { assess, refreshWithCas, type TokenRefresher } from "../src/oauth/health.js";

const NOW = 1_000_000_000_000;

function cred(over: Partial<ClaudeAiOauth> = {}): { claudeAiOauth: ClaudeAiOauth } {
  return {
    claudeAiOauth: {
      accessToken: "sk-ant-atok-old",
      refreshToken: "sk-ant-rtok-old",
      expiresAt: NOW - 1000,
      refreshTokenExpiresAt: NOW + 3_600_000,
      scopes: ["user:inference"],
      ...over,
    },
  };
}

class FakeVault implements Vault {
  store = new Map<string, AccountRecord>();
  saveCalls: AccountRecord[] = [];
  queuedGets: (AccountRecord | null)[] = [];

  constructor(recs: AccountRecord[] = []) {
    for (const r of recs) this.store.set(r.name, r);
  }
  async list(): Promise<AccountRecord[]> {
    return [...this.store.values()];
  }
  async get(name: string): Promise<AccountRecord | null> {
    if (this.queuedGets.length > 0) return this.queuedGets.shift() ?? null;
    return this.store.get(name) ?? null;
  }
  async save(rec: AccountRecord): Promise<void> {
    this.saveCalls.push(rec);
    this.store.set(rec.name, rec);
  }
  async remove(name: string): Promise<void> {
    this.store.delete(name);
  }
  async activeAccount(): Promise<string | null> {
    return null;
  }
  async setActive(_name: string | null): Promise<void> {}
}

class FakeRefresher implements TokenRefresher {
  calls: string[] = [];
  prevs: (Partial<ClaudeAiOauth> | undefined)[] = [];
  #result: ClaudeAiOauth | Error;
  constructor(result: ClaudeAiOauth | Error) {
    this.#result = result;
  }
  async refreshTokens(refreshToken: string, prev?: Partial<ClaudeAiOauth>): Promise<ClaudeAiOauth> {
    this.calls.push(refreshToken);
    this.prevs.push(prev);
    if (this.#result instanceof Error) throw this.#result;
    return this.#result;
  }
}

const REFRESHED: ClaudeAiOauth = {
  accessToken: "sk-ant-atok-new",
  refreshToken: "sk-ant-rtok-new",
  expiresAt: NOW + 3_600_000,
  refreshTokenExpiresAt: NOW + 100_000_000,
};

function record(name = "work"): AccountRecord {
  return {
    name,
    credential: cred(),
    oauthAccount: {
      emailAddress: "user@example.com",
      accountUuid: "a1",
      organizationUuid: "o1",
    },
    savedAt: NOW - 5000,
  };
}

test("health: assess boundaries at the 60s gate", () => {
  assert.equal(assess(cred({ expiresAt: NOW + 61_000 }), NOW).level, "fresh");
  assert.equal(assess(cred({ expiresAt: NOW + 60_000 }), NOW).level, "refreshable");
  assert.equal(assess(cred({ expiresAt: NOW + 59_000 }), NOW).level, "refreshable");
});

test("health: assess dead boundary uses strict > now", () => {
  assert.equal(assess(cred({ refreshTokenExpiresAt: NOW + 1 }), NOW).level, "refreshable");
  assert.equal(assess(cred({ refreshTokenExpiresAt: NOW }), NOW).level, "dead");
  assert.equal(assess(cred({ refreshTokenExpiresAt: NOW - 1 }), NOW).level, "dead");
});

test("health: refreshWithCas happy path saves with lastRefreshedAt", async () => {
  const vault = new FakeVault([record()]);
  const client = new FakeRefresher(REFRESHED);
  const t0 = Date.now();

  const result = await refreshWithCas(vault, "work", client);

  assert.equal(result.level, "refreshed");
  assert.equal(result.credential?.claudeAiOauth.accessToken, "sk-ant-atok-new");
  assert.deepEqual(client.calls, ["sk-ant-rtok-old"]);
  // the credential being refreshed is passed along (scopes to request, fields to keep)
  assert.deepEqual(client.prevs[0]?.scopes, ["user:inference"]);

  assert.equal(vault.saveCalls.length, 1);
  const saved = vault.saveCalls[0]!;
  assert.equal(saved.credential.claudeAiOauth.refreshToken, "sk-ant-rtok-new");
  assert.ok(saved.lastRefreshedAt !== undefined && saved.lastRefreshedAt >= t0);
  // untouched fields preserved
  assert.equal(saved.oauthAccount.emailAddress, "user@example.com");
});

test("health: fresh credentials short-circuit — no refresh token burned", async () => {
  const freshRec = record();
  freshRec.credential = cred({ expiresAt: NOW + 120_000 });
  const vault = new FakeVault([freshRec]);
  const client = new FakeRefresher(new Error("must not be called"));

  const result = await refreshWithCas(vault, "work", client, false, () => NOW);
  assert.equal(result.level, "fresh");
  assert.equal(client.calls.length, 0);
  assert.equal(vault.saveCalls.length, 0);
});

test("health: CAS conflict — vault rotated underneath, no save", async () => {
  const vault = new FakeVault([record()]);
  const rotated = record();
  rotated.credential = cred({ refreshToken: "sk-ant-rtok-rotated" });
  vault.queuedGets = [record(), rotated];

  const client = new FakeRefresher(REFRESHED);
  const result = await refreshWithCas(vault, "work", client);

  assert.equal(result.level, "refreshed");
  assert.equal(result.credential?.claudeAiOauth.accessToken, "sk-ant-atok-new");
  assert.match(result.detail ?? "", /cas-conflict/);
  assert.equal(vault.saveCalls.length, 0);
  assert.equal(vault.store.get("work")!.credential.claudeAiOauth.refreshToken, "sk-ant-rtok-old");
});

test("health: typed errors map by webSession presence", async () => {
  const invalidGrant = new OAuthError(400, "invalid_grant", "refresh token expired");

  const withWeb = new FakeVault([record()]);
  const r1 = await refreshWithCas(withWeb, "work", new FakeRefresher(invalidGrant), true);
  assert.equal(r1.level, "needs-web-session");
  assert.equal(r1.credential, undefined);
  assert.match(r1.detail ?? "", /invalid_grant/);

  const noWeb = new FakeVault([record()]);
  const r2 = await refreshWithCas(noWeb, "work", new FakeRefresher(invalidGrant), false);
  assert.equal(r2.level, "needs-browser-login");
});

test("health: error detail is redacted of sk-ant tokens", async () => {
  const leaky = new OAuthError(400, "invalid_grant", "token sk-ant-secret-value rejected");
  const vault = new FakeVault([record()]);
  const r = await refreshWithCas(vault, "work", new FakeRefresher(leaky), true);
  assert.ok(r.detail !== undefined && !r.detail.includes("sk-ant-secret-value"));
  assert.match(r.detail!, /sk-ant-\*\*\*/);
});

test("health: unknown account throws", async () => {
  const vault = new FakeVault();
  await assert.rejects(refreshWithCas(vault, "nope", new FakeRefresher(REFRESHED)), /unknown account/);
});

test("health: dead refresh token still attempts server refresh", async () => {
  const deadRec = record();
  deadRec.credential = cred({ refreshTokenExpiresAt: NOW - 1 });
  const vault = new FakeVault([deadRec]);
  const client = new FakeRefresher(REFRESHED);
  const r = await refreshWithCas(vault, "work", client);
  assert.equal(r.level, "refreshed");
  assert.equal(client.calls.length, 1);
});
