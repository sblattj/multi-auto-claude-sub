import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathsFor } from "../src/paths.js";

test("paths: defaults with no overrides (env vars absent)", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "macsub-paths-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const p = pathsFor({ HOME: home });
  assert.equal(p.macsubHome, join(home, ".macsub"));
  assert.equal(p.accountsDir, join(home, ".macsub", "accounts"));
  assert.equal(p.vaultConfigFile, join(home, ".macsub", "config.json"));
  assert.equal(p.configDir, join(home, ".claude"));
  assert.equal(p.credentialsFile, join(home, ".claude", ".credentials.json"));
  assert.equal(p.primaryClaudeJson, join(home, ".claude.json"));
  assert.equal(p.legacyClaudeJson, join(home, ".claude", ".claude.json"));
  // nothing exists yet → primary wins
  assert.equal(p.claudeJson, join(home, ".claude.json"));
  assert.equal(p.sessionsDir, join(home, ".claude", "sessions"));
  assert.equal(p.ideDir, join(home, ".claude", "ide"));
  assert.equal(p.oauthRefreshLock, join(home, ".claude", ".oauth_refresh.lock"));
  assert.equal(p.claudeLock, join(home, ".claude.lock"));
  assert.equal(p.claudeJsonLock, join(home, ".claude.json.lock"));
});

test("paths: MACSUB_HOME override", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "macsub-paths-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const p = pathsFor({ HOME: home, MACSUB_HOME: join(home, "custom-vault") });
  assert.equal(p.macsubHome, join(home, "custom-vault"));
  // config paths unaffected
  assert.equal(p.configDir, join(home, ".claude"));
});

test("paths: CLAUDE_CONFIG_DIR applies to BOTH credentials file and .claude.json", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "macsub-paths-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cfg = join(home, "cc-config");
  // legacy file exists WITH oauthAccount — must be ignored when override is set
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(
    join(home, ".claude", ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "x@y.z" } }),
  );
  const p = pathsFor({ HOME: home, CLAUDE_CONFIG_DIR: cfg });
  assert.equal(p.configDir, cfg);
  assert.equal(p.credentialsFile, join(cfg, ".credentials.json"));
  assert.equal(p.primaryClaudeJson, join(cfg, ".claude.json"));
  assert.equal(p.claudeJson, join(cfg, ".claude.json"));
  assert.equal(p.oauthRefreshLock, join(cfg, ".oauth_refresh.lock"));
  assert.equal(p.claudeJsonLock, join(cfg, ".claude.json.lock"));
  // ~/.claude.lock is a home-dir lock, not config-dir
  assert.equal(p.claudeLock, join(home, ".claude.lock"));
});

test("paths: empty-string CLAUDE_CONFIG_DIR is treated as unset", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "macsub-paths-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const p = pathsFor({ HOME: home, CLAUDE_CONFIG_DIR: "" });
  assert.equal(p.configDir, join(home, ".claude"));
  assert.equal(p.credentialsFile, join(home, ".claude", ".credentials.json"));
});

test("paths: legacy ~/.claude/.claude.json used when primary absent and it has oauthAccount", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "macsub-paths-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(
    join(home, ".claude", ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "legacy@x.y" } }),
  );
  const p = pathsFor({ HOME: home });
  assert.equal(p.claudeJson, join(home, ".claude", ".claude.json"));
});

test("paths: legacy WITHOUT oauthAccount key is not valid — primary stays", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "macsub-paths-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(join(home, ".claude", ".claude.json"), JSON.stringify({ theme: "dark" }));
  const p = pathsFor({ HOME: home });
  assert.equal(p.claudeJson, join(home, ".claude.json"));
});

test("paths: primary .claude.json wins over legacy when it exists", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "macsub-paths-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(
    join(home, ".claude", ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "legacy@x.y" } }),
  );
  await writeFile(join(home, ".claude.json"), JSON.stringify({ theme: "dark" }));
  const p = pathsFor({ HOME: home });
  assert.equal(p.claudeJson, join(home, ".claude.json"));
  assert.equal(p.claudeJsonLock, join(home, ".claude.json.lock"));
});
