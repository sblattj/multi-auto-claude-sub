import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installFreshCredential, swap } from "../src/swap/swap.js";
import type {
  AccountRecord,
  ActiveState,
  CredentialBlob,
  OauthAccount,
  Vault,
} from "../src/types.js";

function blob(tag: string): CredentialBlob {
  return {
    claudeAiOauth: {
      accessToken: `sk-ant-fake-access-${tag}`,
      refreshToken: `sk-ant-fake-refresh-${tag}`,
      expiresAt: 1_900_000_000_000,
      refreshTokenExpiresAt: 1_950_000_000_000,
      scopes: ["user:inference"],
    },
  };
}

function acc(email: string): OauthAccount {
  return { emailAddress: email, accountUuid: `uuid-${email}`, organizationUuid: `org-${email}` };
}

function rec(name: string, tag = name): AccountRecord {
  return { name, credential: blob(tag), oauthAccount: acc(`${name}@example.com`), savedAt: 1_000 };
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
    if (!this.records.delete(name)) throw new Error(`no vaulted account named "${name}"`);
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
  readCred: CredentialBlob | null = null;
  readAcc: OauthAccount | null = null;
  readErr: Error | null = null;
  failNextWrite: Error | null = null;
  platform(): NodeJS.Platform {
    return "darwin";
  }
  async readCredential(): Promise<CredentialBlob | null> {
    if (this.readErr) throw this.readErr;
    return this.readCred;
  }
  async writeCredential(b: CredentialBlob): Promise<void> {
    if (this.failNextWrite) {
      const e = this.failNextWrite;
      this.failNextWrite = null;
      throw e;
    }
    this.writes.push(b);
  }
  async readOauthAccount(): Promise<OauthAccount | null> {
    return this.readAcc;
  }
  async mergeOauthAccount(a: OauthAccount): Promise<void> {
    this.merges.push(a);
  }
}

async function tmpEnv(): Promise<{ env: NodeJS.ProcessEnv; home: string }> {
  const home = await mkdtemp(join(tmpdir(), "macsub-swap-"));
  return { env: { HOME: home, CLAUDE_CONFIG_DIR: join(home, "cc") }, home };
}

const noSessions = async (): Promise<string[]> => [];

test("swap: unknown account → failed-unknown-account, nothing touched", async (t) => {
  const { env, home } = await tmpEnv();
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = new FakeVault();
  const active = new FakeActive();
  const res = await swap(vault, active, "ghost", { env, detectSessions: noSessions });
  assert.equal(res.outcome, "failed-unknown-account");
  assert.equal(res.from, null);
  assert.equal(res.to, "ghost");
  assert.deepEqual(active.writes, []);
  assert.deepEqual(active.merges, []);
  assert.equal(vault.active, null);
});

test("swap: first use (no active account) → swapped, no re-vault", async (t) => {
  const { env, home } = await tmpEnv();
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = new FakeVault();
  const work = rec("work");
  vault.records.set("work", work);
  const active = new FakeActive();
  const res = await swap(vault, active, "work", { env, detectSessions: noSessions });
  assert.equal(res.outcome, "swapped");
  assert.equal(res.from, null);
  assert.equal(res.to, "work");
  assert.deepEqual(res.warnings, []);
  assert.deepEqual(active.writes, [work.credential]);
  assert.deepEqual(active.merges, [work.oauthAccount]);
  assert.equal(vault.active, "work");
  assert.ok(!existsSync(join(home, "cc", ".oauth_refresh.lock")), "locks released");
  assert.ok(!existsSync(join(home, ".claude.lock")), "locks released");
});

test("swap: re-vaults the LIVE outgoing credential over the stale vault copy", async (t) => {
  const { env, home } = await tmpEnv();
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = new FakeVault();
  vault.records.set("old", rec("old", "stale"));
  vault.records.set("work", rec("work"));
  vault.active = "old";
  const active = new FakeActive();
  const rotated = blob("rotated-live");
  const liveAcc = acc("old-rotated@example.com");
  active.readCred = rotated;
  active.readAcc = liveAcc;
  const res = await swap(vault, active, "work", { env, detectSessions: noSessions });
  assert.equal(res.outcome, "swapped");
  assert.equal(res.from, "old");
  // outgoing record now holds the LIVE credential + identity, savedAt bumped
  const oldRec = vault.records.get("old")!;
  assert.deepEqual(oldRec.credential, rotated);
  assert.deepEqual(oldRec.oauthAccount, liveAcc);
  assert.ok(oldRec.savedAt > 1_000);
  // target installed
  assert.deepEqual(active.writes, [rec("work").credential]);
  assert.deepEqual(active.merges, [rec("work").oauthAccount]);
  assert.equal(vault.active, "work");
});

test("swap: outgoing live credential missing → warning, vault copy unchanged, swap proceeds", async (t) => {
  const { env, home } = await tmpEnv();
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = new FakeVault();
  const oldRec = rec("old");
  vault.records.set("old", oldRec);
  vault.records.set("work", rec("work"));
  vault.active = "old";
  const active = new FakeActive();
  active.readCred = null; // CC logged out
  const res = await swap(vault, active, "work", { env, detectSessions: noSessions });
  assert.equal(res.outcome, "swapped-with-warnings");
  assert.ok(res.warnings.some((w) => w.includes("no live credential")));
  assert.deepEqual(vault.records.get("old")!.credential, oldRec.credential);
  assert.equal(vault.active, "work");
});

test("swap: keychain push failure restores the outgoing credential", async (t) => {
  const { env, home } = await tmpEnv();
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = new FakeVault();
  vault.records.set("old", rec("old", "stale"));
  vault.records.set("work", rec("work"));
  vault.active = "old";
  const active = new FakeActive();
  const rotated = blob("rotated-live");
  active.readCred = rotated;
  active.readAcc = acc("old@example.com");
  active.failNextWrite = new Error("keychain denied");
  const res = await swap(vault, active, "work", { env, detectSessions: noSessions });
  assert.equal(res.outcome, "failed-keychain-push");
  assert.ok(res.detail!.includes("credential install failed"));
  assert.ok(res.detail!.includes("outgoing credential restored"));
  // the only successful write is the RESTORE of the outgoing live credential
  assert.deepEqual(active.writes, [rotated]);
  assert.deepEqual(active.merges, []);
  assert.equal(vault.active, "old");
});

test("swap: keychain push failure with no outgoing → nothing restored, noted in detail", async (t) => {
  const { env, home } = await tmpEnv();
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = new FakeVault();
  vault.records.set("work", rec("work"));
  const active = new FakeActive();
  active.failNextWrite = new Error("keychain denied");
  const res = await swap(vault, active, "work", { env, detectSessions: noSessions });
  assert.equal(res.outcome, "failed-keychain-push");
  assert.deepEqual(active.writes, []);
  assert.ok(res.detail!.includes("no outgoing credential to restore"));
});

test("swap: unreadable active state (readCredential throws) → failed-active-state-unreadable", async (t) => {
  const { env, home } = await tmpEnv();
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = new FakeVault();
  vault.records.set("old", rec("old"));
  vault.records.set("work", rec("work"));
  vault.active = "old";
  const active = new FakeActive();
  active.readErr = new Error("keychain read failed (exit 51)");
  const res = await swap(vault, active, "work", { env, detectSessions: noSessions });
  assert.equal(res.outcome, "failed-active-state-unreadable");
  assert.deepEqual(active.writes, []);
  assert.deepEqual(active.merges, []);
  assert.equal(vault.active, "old");
});

test("swap: live-session warnings propagate as swapped-with-warnings", async (t) => {
  const { env, home } = await tmpEnv();
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = new FakeVault();
  vault.records.set("work", rec("work"));
  const active = new FakeActive();
  const res = await swap(vault, active, "work", {
    env,
    detectSessions: async () => ["live Claude Code session (pid 1)"],
  });
  assert.equal(res.outcome, "swapped-with-warnings");
  assert.deepEqual(res.warnings, ["live Claude Code session (pid 1)"]);
  assert.equal(vault.active, "work");
});

test("swap: activeAccount set but record missing → warning, proceeds, restore path still armed", async (t) => {
  const { env, home } = await tmpEnv();
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = new FakeVault();
  vault.records.set("work", rec("work"));
  vault.active = "ghost";
  const active = new FakeActive();
  const liveCred = blob("ghost-live");
  active.readCred = liveCred;
  const res = await swap(vault, active, "work", { env, detectSessions: noSessions });
  assert.equal(res.outcome, "swapped-with-warnings");
  assert.ok(res.warnings.some((w) => w.includes("no vault record")));
  assert.equal(vault.active, "work");
});

test("installFreshCredential: locks + write + merge, in that order, no vault change", async (t) => {
  const { env, home } = await tmpEnv();
  t.after(() => rm(home, { recursive: true, force: true }));
  const active = new FakeActive();
  const calls: string[] = [];
  const origWrite = active.writeCredential.bind(active);
  active.writeCredential = async (b) => {
    calls.push("write");
    assert.ok(existsSync(join(home, "cc", ".oauth_refresh.lock")), "locks must be held during write");
    assert.ok(existsSync(join(home, ".claude.lock")), "locks must be held during write");
    await origWrite(b);
  };
  const origMerge = active.mergeOauthAccount.bind(active);
  active.mergeOauthAccount = async (a) => {
    calls.push("merge");
    await origMerge(a);
  };
  const r = rec("fresh");
  await installFreshCredential(active, r, { env });
  assert.deepEqual(calls, ["write", "merge"]);
  assert.deepEqual(active.writes, [r.credential]);
  assert.deepEqual(active.merges, [r.oauthAccount]);
  assert.ok(!existsSync(join(home, "cc", ".oauth_refresh.lock")), "locks released");
  assert.ok(!existsSync(join(home, ".claude.lock")), "locks released");
});
