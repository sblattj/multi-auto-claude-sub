import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVault } from "../src/vault/store.js";
import { renameAccount } from "../src/vault/rename.js";
import type { AccountRecord } from "../src/types.js";

function rec(name: string): AccountRecord {
  return {
    name,
    credential: {
      claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: 1, refreshTokenExpiresAt: 2 },
    },
    oauthAccount: { emailAddress: "x@y.z", accountUuid: "u", organizationUuid: "o" },
    savedAt: 1,
  };
}

test("rename: file, name field, and active pointer all follow", async () => {
  const dir = mkdtempSync(join(tmpdir(), "macsub-rename-"));
  try {
    const vault = createVault({ env: { MACSUB_HOME: dir } });
    await vault.save(rec("sblattj"));
    await vault.setActive("sblattj");
    await renameAccount(vault, "sblattj", "personal");
    assert.equal(await vault.get("sblattj"), null);
    const renamed = await vault.get("personal");
    assert.ok(renamed);
    assert.equal(renamed.name, "personal");
    assert.equal(renamed.oauthAccount.emailAddress, "x@y.z");
    assert.equal(await vault.activeAccount(), "personal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rename: inactive account keeps active pointer untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "macsub-rename-"));
  try {
    const vault = createVault({ env: { MACSUB_HOME: dir } });
    await vault.save(rec("a"));
    await vault.save(rec("b"));
    await vault.setActive("a");
    await renameAccount(vault, "b", "c");
    assert.equal(await vault.activeAccount(), "a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rename: unknown source, existing target, and no-op each throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "macsub-rename-"));
  try {
    const vault = createVault({ env: { MACSUB_HOME: dir } });
    await vault.save(rec("a"));
    await assert.rejects(renameAccount(vault, "nope", "x"), /unknown account/);
    await assert.rejects(renameAccount(vault, "a", "a"), /already named/);
    await vault.save(rec("b"));
    await assert.rejects(renameAccount(vault, "a", "b"), /already exists/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
