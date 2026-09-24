import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createVault, readVaultConfig, updateVaultConfig } from "../src/vault/store.js";
import type { AccountRecord } from "../src/types.js";

let seq = 0;
function rec(name: string): AccountRecord {
  return {
    name,
    credential: {
      claudeAiOauth: {
        accessToken: `sk-ant-fake-${++seq}`,
        refreshToken: `sk-ant-fake-refresh-${seq}`,
        expiresAt: Date.now() + 3_600_000,
        refreshTokenExpiresAt: Date.now() + 86_400_000,
        scopes: ["user:inference"],
      },
    },
    oauthAccount: { emailAddress: `${name}@example.com`, accountUuid: `u-${name}`, organizationUuid: `o-${name}` },
    savedAt: Date.now(),
  };
}

test("vault: save/get round-trip, file mode 0600, dir 0700", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "macsub-vault-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = createVault({ home });
  const r = rec("work");
  await vault.save(r);
  const got = await vault.get("work");
  assert.deepEqual(got, r);
  const accountsDir = join(home, "accounts");
  assert.equal((await stat(accountsDir)).mode & 0o777, 0o700);
  const f = join(accountsDir, "work.json");
  assert.equal((await stat(f)).mode & 0o777, 0o600);
  const onDisk = JSON.parse(await readFile(f, "utf8")) as AccountRecord;
  assert.equal(onDisk.name, "work");
});

test("vault: names with spaces/odd chars round-trip via slug + name scan", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "macsub-vault-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = createVault({ home });
  const r = rec("my personal acct");
  await vault.save(r);
  assert.deepEqual(await vault.get("my personal acct"), r);
  const names = (await vault.list()).map((x) => x.name);
  assert.deepEqual(names, ["my personal acct"]);
});

test("vault: list sorted by name; get unknown → null", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "macsub-vault-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = createVault({ home });
  await vault.save(rec("zeta"));
  await vault.save(rec("alpha"));
  assert.deepEqual((await vault.list()).map((r) => r.name), ["alpha", "zeta"]);
  assert.equal(await vault.get("nope"), null);
});

test("vault: remove deletes the file; removing unknown throws", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "macsub-vault-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = createVault({ home });
  await vault.save(rec("work"));
  await vault.remove("work");
  assert.equal(await vault.get("work"), null);
  await assert.rejects(() => vault.remove("work"), /no vaulted account/);
});

test("vault: activeAccount / setActive with config.json contents", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "macsub-vault-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = createVault({ home });
  assert.equal(await vault.activeAccount(), null); // no config.json yet
  await vault.setActive("work");
  assert.equal(await vault.activeAccount(), "work");
  const raw = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as { activeAccount: string };
  assert.deepEqual(raw, { activeAccount: "work" });
  await vault.setActive(null);
  assert.equal(await vault.activeAccount(), null);
});

test("vault config: setActive keeps swapMode and other keys", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "macsub-vault-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = createVault({ home });
  assert.deepEqual(await readVaultConfig(home), {});
  await updateVaultConfig({ swapMode: "best" }, home);
  await vault.setActive("work");
  assert.deepEqual(await readVaultConfig(home), { swapMode: "best", activeAccount: "work" });
  await updateVaultConfig({ swapMode: "toggle" }, home);
  assert.equal(await vault.activeAccount(), "work");
  assert.equal((await readVaultConfig(home)).swapMode, "toggle");
});

test("vault: save overwrites existing record (re-vault updates)", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "macsub-vault-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = createVault({ home });
  const first = rec("work");
  await vault.save(first);
  const second = { ...first, savedAt: first.savedAt + 5, credential: rec("other").credential };
  await vault.save(second);
  assert.deepEqual(await vault.get("work"), second);
});
