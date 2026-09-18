import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createActiveState } from "../src/vault/credentials.js";
import type { CredentialBlob, OauthAccount } from "../src/types.js";

const execFileP = promisify(execFile);

function blob(tag: string): CredentialBlob {
  return {
    claudeAiOauth: {
      accessToken: `sk-ant-fake-access-${tag}`,
      refreshToken: `sk-ant-fake-refresh-${tag}`,
      expiresAt: 1_900_000_000_000,
      refreshTokenExpiresAt: 1_950_000_000_000,
      scopes: ["user:inference", "user:sessions:claude_code"],
    },
  };
}

function acc(email: string): OauthAccount {
  return { emailAddress: email, accountUuid: `uuid-${email}`, organizationUuid: `org-${email}` };
}

test("credentials: mergeOauthAccount preserves 100 unrelated keys and replaces oauthAccount", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "macsub-cred-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const claudeJson = join(dir, ".claude.json");
  const original: Record<string, unknown> = {};
  for (let i = 0; i < 100; i++) original[`key${i}`] = { i, arr: [i, "x", { deep: true }], s: `v${i}` };
  original.theme = "dark";
  original.mcpServers = { fetch: { command: "uvx", args: ["mcp-server-fetch"] } };
  await writeFile(claudeJson, JSON.stringify(original, null, 2));
  const state = createActiveState({ configDir: dir, claudeJsonPath: claudeJson, env: { HOME: dir } });

  await state.mergeOauthAccount(acc("one@example.com"));
  let parsed = JSON.parse(await readFile(claudeJson, "utf8")) as Record<string, unknown>;
  for (const [k, v] of Object.entries(original)) assert.deepEqual(parsed[k], v, `key ${k} must survive`);
  assert.deepEqual(parsed.oauthAccount, acc("one@example.com"));

  await state.mergeOauthAccount(acc("two@example.com"));
  parsed = JSON.parse(await readFile(claudeJson, "utf8")) as Record<string, unknown>;
  for (const [k, v] of Object.entries(original)) assert.deepEqual(parsed[k], v, `key ${k} must survive`);
  assert.deepEqual(parsed.oauthAccount, acc("two@example.com"));

  // 2-space indent formatting (CC tolerates reformat)
  const raw = await readFile(claudeJson, "utf8");
  assert.match(raw, /\n {2}"oauthAccount"/);
});

test("credentials: mergeOauthAccount creates the file when absent; readOauthAccount null/round-trip", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "macsub-cred-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const claudeJson = join(dir, ".claude.json");
  const state = createActiveState({ configDir: dir, claudeJsonPath: claudeJson, env: { HOME: dir } });
  assert.equal(await state.readOauthAccount(), null);
  await state.mergeOauthAccount(acc("fresh@example.com"));
  const parsed = JSON.parse(await readFile(claudeJson, "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), ["oauthAccount"]);
  assert.deepEqual(await state.readOauthAccount(), acc("fresh@example.com"));
  assert.equal((await stat(claudeJson)).mode & 0o777, 0o600);
});

test("credentials: readOauthAccount null when key absent from existing file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "macsub-cred-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const claudeJson = join(dir, ".claude.json");
  await writeFile(claudeJson, JSON.stringify({ theme: "dark" }));
  const state = createActiveState({ configDir: dir, claudeJsonPath: claudeJson, env: { HOME: dir } });
  assert.equal(await state.readOauthAccount(), null);
});

test("credentials: file-authoritative platform branch round-trips .credentials.json 0600", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "macsub-cred-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = createActiveState({
    platform: "linux",
    configDir: dir,
    claudeJsonPath: join(dir, ".claude.json"),
    env: { HOME: dir },
  });
  assert.equal(state.platform(), "linux");
  assert.equal(await state.readCredential(), null);
  await state.writeCredential(blob("first"));
  const f = join(dir, ".credentials.json");
  assert.deepEqual(await state.readCredential(), blob("first"));
  assert.equal((await stat(f)).mode & 0o777, 0o600);
  await state.writeCredential(blob("second"));
  assert.deepEqual(await state.readCredential(), blob("second"));
});

test("credentials: malformed credential blob throws (not silently null)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "macsub-cred-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, ".credentials.json"), "not json");
  const state = createActiveState({
    platform: "linux",
    configDir: dir,
    claudeJsonPath: join(dir, ".claude.json"),
    env: { HOME: dir },
  });
  await assert.rejects(() => state.readCredential(), /credential blob/);
});

test("credentials: keychain round-trip against macsub-test-credentials (darwin only)", async (t) => {
  if (process.platform !== "darwin") return t.skip("macOS keychain only");
  const SERVICE = "macsub-test-credentials";
  const dir = await mkdtemp(join(tmpdir(), "macsub-kc-"));
  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true });
    for (let i = 0; i < 10; i++) {
      try {
        await execFileP("security", ["delete-generic-password", "-s", SERVICE]);
      } catch {
        return;
      }
    }
  };
  t.after(cleanup);
  await cleanup(); // clear any leftover from a crashed earlier run

  const state = createActiveState({
    keychainService: SERVICE,
    configDir: dir,
    claudeJsonPath: join(dir, ".claude.json"),
    env: { HOME: dir },
  });
  assert.equal(state.platform(), "darwin");

  // absent item (fresh random service) reads as null, never throws
  const absent = createActiveState({
    keychainService: `macsub-test-absent-${Date.now()}`,
    configDir: dir,
    claudeJsonPath: join(dir, ".claude.json"),
    env: { HOME: dir },
  });
  assert.equal(await absent.readCredential(), null);

  // write → keychain + mirror file; read → identical
  await state.writeCredential(blob("kc"));
  assert.deepEqual(await state.readCredential(), blob("kc"));
  const mirror = join(dir, ".credentials.json");
  assert.deepEqual(JSON.parse(await readFile(mirror, "utf8")), blob("kc"));
  assert.equal((await stat(mirror)).mode & 0o777, 0o600);

  // overwrite via delete-all-then-add: read must return the NEW value
  await state.writeCredential(blob("kc2"));
  assert.deepEqual(await state.readCredential(), blob("kc2"));

  // explicit cleanup leaves the keychain empty
  await cleanup();
  assert.equal(await state.readCredential(), null);
});
