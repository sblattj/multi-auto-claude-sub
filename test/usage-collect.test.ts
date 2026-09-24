import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectUsage } from "../src/usage/collect.js";
import type { FetchImpl } from "../src/oauth/client.js";
import type { TokenRefresher } from "../src/oauth/health.js";
import type { AccountRecord, ActiveState, ClaudeAiOauth, CredentialBlob, OauthAccount, Vault } from "../src/types.js";

const HOUR = 3_600_000;
const NOW = Date.now();

function oauth(tag: string, expiresAt: number): ClaudeAiOauth {
  return {
    accessToken: `sk-ant-fake-access-${tag}`,
    refreshToken: `sk-ant-fake-refresh-${tag}`,
    expiresAt,
    refreshTokenExpiresAt: NOW + 100 * HOUR,
  };
}
const acc = (email: string): OauthAccount => ({ emailAddress: email, accountUuid: `u-${email}`, organizationUuid: `o-${email}` });
function rec(name: string, expiresAt: number): AccountRecord {
  return { name, credential: { claudeAiOauth: oauth(name, expiresAt) }, oauthAccount: acc(`${name}@example.com`), savedAt: 1 };
}

class FakeVault implements Vault {
  records = new Map<string, AccountRecord>();
  constructor(recs: AccountRecord[], public active: string | null) {
    for (const r of recs) this.records.set(r.name, r);
  }
  async list() {
    return [...this.records.values()];
  }
  async get(name: string) {
    return this.records.get(name) ?? null;
  }
  async save(r: AccountRecord) {
    this.records.set(r.name, r);
  }
  async remove(name: string) {
    this.records.delete(name);
  }
  async activeAccount() {
    return this.active;
  }
  async setActive(name: string | null) {
    this.active = name;
  }
}

class FakeActive implements ActiveState {
  constructor(public cred: CredentialBlob | null, public account: OauthAccount | null) {}
  platform(): NodeJS.Platform {
    return "linux";
  }
  async readCredential() {
    return this.cred;
  }
  async writeCredential(b: CredentialBlob) {
    this.cred = b;
  }
  async readOauthAccount() {
    return this.account;
  }
  async mergeOauthAccount() {}
}

/** usage endpoint stub: weekly % keyed by the bearer token */
function usageFetch(byToken: Record<string, number>): { seen: string[]; fetch: FetchImpl } {
  const seen: string[] = [];
  return {
    seen,
    fetch: async (_url, init) => {
      const token = init.headers.authorization!.replace("Bearer ", "");
      seen.push(token);
      const pct = byToken[token];
      if (pct === undefined) return new Response('{"error":{"message":"invalid token"}}', { status: 401 });
      return new Response(JSON.stringify({ seven_day: { utilization: pct, resets_at: null } }), { status: 200 });
    },
  };
}

async function tmpHome(t: test.TestContext): Promise<{ env: NodeJS.ProcessEnv; cacheFile: string }> {
  const home = await mkdtemp(join(tmpdir(), "macsub-usage-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { env: { HOME: home, CLAUDE_CONFIG_DIR: join(home, "cc"), MACSUB_HOME: home }, cacheFile: join(home, "usage.json") };
}

test("collectUsage: active account reads with the live token, others with their vault token", async (t) => {
  const { env, cacheFile } = await tmpHome(t);
  const vault = new FakeVault([rec("alpha", NOW - HOUR), rec("beta", NOW + HOUR)], "alpha");
  // a running session refreshed alpha: the live token is newer than the vault's expired one
  const live = { claudeAiOauth: oauth("alpha-live", NOW + HOUR) };
  const active = new FakeActive(live, acc("alpha@example.com"));
  const f = usageFetch({ "sk-ant-fake-access-alpha-live": 20, "sk-ant-fake-access-beta": 70 });

  const out = await collectUsage(vault, active, { env, cacheFile, fetchImpl: f.fetch, refresh: false });
  assert.deepEqual(
    out.map((u) => [u.name, u.usage?.weekly?.pct, u.cached ?? false]),
    [["alpha", 20, false], ["beta", 70, false]],
  );
  const cache = JSON.parse(await readFile(cacheFile, "utf8")) as Record<string, { weekly: { pct: number } }>;
  assert.equal(cache.alpha!.weekly.pct, 20);
  assert.equal(cache.beta!.weekly.pct, 70);
});

test("collectUsage: expired token without refresh falls back to the cache, marked cached", async (t) => {
  const { env, cacheFile } = await tmpHome(t);
  await writeFile(cacheFile, JSON.stringify({ beta: { fetchedAt: NOW - 2 * HOUR, scoped: [], weekly: { pct: 55, resetsAt: null } } }));
  const vault = new FakeVault([rec("beta", NOW - HOUR)], null);
  const f = usageFetch({});
  const [beta] = await collectUsage(vault, new FakeActive(null, null), { env, cacheFile, fetchImpl: f.fetch });
  assert.equal(f.seen.length, 0, "no request with an expired token");
  assert.equal(beta!.cached, true);
  assert.equal(beta!.usage?.weekly?.pct, 55);
  assert.match(beta!.error!, /access token expired/);
});

test("collectUsage: with refresh, an expired inactive account is refreshed (L1) and read", async (t) => {
  const { env, cacheFile } = await tmpHome(t);
  const vault = new FakeVault([rec("beta", NOW - HOUR)], null);
  const refreshed: string[] = [];
  const client: TokenRefresher = {
    async refreshTokens(rt) {
      refreshed.push(rt);
      return oauth("beta-new", NOW + 8 * HOUR);
    },
  };
  const f = usageFetch({ "sk-ant-fake-access-beta-new": 5 });
  const [beta] = await collectUsage(vault, new FakeActive(null, null), { env, cacheFile, fetchImpl: f.fetch, client, refresh: true });
  assert.deepEqual(refreshed, ["sk-ant-fake-refresh-beta"]);
  assert.equal(beta!.usage?.weekly?.pct, 5);
  assert.equal(beta!.cached, undefined);
  assert.equal((await vault.get("beta"))!.credential.claudeAiOauth.accessToken, "sk-ant-fake-access-beta-new");
});

test("collectUsage: a failed read with no cache reports the error, token redacted", async (t) => {
  const { env, cacheFile } = await tmpHome(t);
  const vault = new FakeVault([rec("beta", NOW + HOUR)], null);
  const f = usageFetch({});
  const [beta] = await collectUsage(vault, new FakeActive(null, null), { env, cacheFile, fetchImpl: f.fetch });
  assert.equal(beta!.usage, undefined);
  assert.match(beta!.error!, /HTTP 401.*invalid token/);
});
