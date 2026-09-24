import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoBest } from "../src/auto.js";
import type { FetchImpl } from "../src/oauth/client.js";
import type { TokenRefresher } from "../src/oauth/health.js";
import type { swap } from "../src/swap/swap.js";
import type { AccountRecord, ActiveState, ClaudeAiOauth, CredentialBlob, OauthAccount, Vault } from "../src/types.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
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
function rec(name: string, expiresAt = NOW + HOUR): AccountRecord {
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
  constructor(public cred: CredentialBlob | null = null, public account: OauthAccount | null = null) {}
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

/** usage stub keyed by bearer token: [weekly %, weekly reset in ms] */
function usageFetch(byToken: Record<string, [number, number]>): { calls: string[]; fetch: FetchImpl } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (_url, init) => {
      const token = init.headers.authorization!.replace("Bearer ", "");
      calls.push(token);
      const u = byToken[token];
      if (!u) return new Response("{}", { status: 401 });
      const body = { seven_day: { utilization: u[0], resets_at: new Date(NOW + u[1]).toISOString() } };
      return new Response(JSON.stringify(body), { status: 200 });
    },
  };
}

function swapSpy(vault: FakeVault): { calls: string[]; impl: typeof swap } {
  const calls: string[] = [];
  const impl: typeof swap = async (_v, _a, to) => {
    calls.push(to);
    const from = vault.active;
    vault.active = to;
    return { outcome: "swapped", from, to, warnings: [] };
  };
  return { calls, impl };
}

async function home(t: test.TestContext): Promise<{ env: NodeJS.ProcessEnv; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "macsub-auto-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, env: { HOME: dir, MACSUB_HOME: dir, CLAUDE_CONFIG_DIR: join(dir, "cc") } };
}

const noRefresh: TokenRefresher = {
  async refreshTokens() {
    throw new Error("should not refresh");
  },
};

test("autoBest: fresh cache that still ranks the current account first → kept, no requests", async (t) => {
  const { env, dir } = await home(t);
  const snap = (pct: number, resetIn: number) => ({ fetchedAt: NOW - 60_000, scoped: [], weekly: { pct, resetsAt: NOW + resetIn } });
  await writeFile(join(dir, "usage.json"), JSON.stringify({ alpha: snap(10, DAY), beta: snap(90, 7 * DAY) }));
  const vault = new FakeVault([rec("alpha"), rec("beta")], "alpha");
  const f = usageFetch({});
  const s = swapSpy(vault);
  const r = await autoBest(vault, new FakeActive(), { trigger: "auto", env, maxAgeMs: 5 * 60_000, fetchImpl: f.fetch, swapImpl: s.impl, client: noRefresh });
  assert.equal(r.action, "kept");
  assert.equal(f.calls.length, 0);
  assert.equal(s.calls.length, 0);
  assert.match(await readFile(join(dir, "auto.log"), "utf8"), / auto kept alpha /);
});

test("autoBest: the example (A 90%/7d vs B 10%/1d) swaps A → B", async (t) => {
  const { env, dir } = await home(t);
  const vault = new FakeVault([rec("A"), rec("B")], "A");
  const f = usageFetch({ "sk-ant-fake-access-A": [90, 7 * DAY], "sk-ant-fake-access-B": [10, DAY] });
  const s = swapSpy(vault);
  const r = await autoBest(vault, new FakeActive(), { trigger: "limit", env, fetchImpl: f.fetch, swapImpl: s.impl, client: noRefresh, now: () => NOW });
  assert.equal(r.action, "swapped");
  assert.equal(r.to, "B");
  assert.deepEqual(s.calls, ["B"]);
  assert.match(r.reason, /^90% of weekly left, resets in 1d; A: 10% of weekly left/);
  assert.match(await readFile(join(dir, "auto.log"), "utf8"), / limit swapped A->B /);
});

test("autoBest: an expired target is refreshed (L1) before the swap; a dead one is skipped", async (t) => {
  const { env } = await home(t);
  const f = usageFetch({ "sk-ant-fake-access-A": [90, 7 * DAY] });
  // B's access token expired: its usage comes from the cache
  const cache = { B: { fetchedAt: NOW - HOUR, scoped: [], weekly: { pct: 10, resetsAt: NOW + DAY } } };
  await writeFile(join(env.MACSUB_HOME!, "usage.json"), JSON.stringify(cache));

  const ok = new FakeVault([rec("A"), rec("B", NOW - HOUR)], "A");
  const refreshed: string[] = [];
  const client: TokenRefresher = {
    async refreshTokens(rt) {
      refreshed.push(rt);
      return oauth("B-new", NOW + 8 * HOUR);
    },
  };
  const s1 = swapSpy(ok);
  const r1 = await autoBest(ok, new FakeActive(), { trigger: "auto", env, fetchImpl: f.fetch, swapImpl: s1.impl, client });
  assert.equal(r1.action, "swapped");
  assert.deepEqual(refreshed, ["sk-ant-fake-refresh-B"]);

  const dead = new FakeVault([rec("A"), rec("B", NOW - HOUR)], "A");
  const failing: TokenRefresher = {
    async refreshTokens() {
      throw new Error("oauth error invalid_grant (HTTP 400)");
    },
  };
  const s2 = swapSpy(dead);
  const r2 = await autoBest(dead, new FakeActive(), { trigger: "auto", env, fetchImpl: f.fetch, swapImpl: s2.impl, client: failing });
  assert.equal(r2.action, "skipped");
  assert.match(r2.reason, /B is best but its token needs a login.*macsub login B/);
  assert.equal(s2.calls.length, 0, "never installs an account without a working token");
});

test("autoBest: a hung usage read times out without swapping", async (t) => {
  const { env } = await home(t);
  const vault = new FakeVault([rec("A"), rec("B")], "A");
  const hang: FetchImpl = () => new Promise(() => {});
  const s = swapSpy(vault);
  const started = Date.now();
  const r = await autoBest(vault, new FakeActive(), { trigger: "auto", env, fetchImpl: hang, swapImpl: s.impl, timeoutMs: 150 });
  assert.equal(r.action, "skipped");
  assert.match(r.reason, /timed out after 0.15s/);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(s.calls.length, 0);
});

test("autoBest: another auto-swap holding the lock → skipped as busy", async (t) => {
  const { env, dir } = await home(t);
  await mkdir(join(dir, "auto.lock"));
  const vault = new FakeVault([rec("A"), rec("B")], "A");
  const r = await autoBest(vault, new FakeActive(), { trigger: "limit", env, fetchImpl: usageFetch({}).fetch });
  assert.equal(r.action, "skipped");
  assert.equal(r.busy, true);
});

test("autoBest: fewer than two accounts, or a throwing vault, never throw", async (t) => {
  const { env } = await home(t);
  const one = await autoBest(new FakeVault([rec("A")], "A"), new FakeActive(), { trigger: "auto", env });
  assert.equal(one.action, "skipped");
  const broken = new FakeVault([], null);
  broken.list = async () => {
    throw new Error("disk on fire");
  };
  const r = await autoBest(broken, new FakeActive(), { trigger: "auto", env });
  assert.deepEqual([r.action, r.reason], ["skipped", "error: disk on fire"]);
});
