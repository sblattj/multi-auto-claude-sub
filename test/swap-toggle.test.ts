import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVault } from "../src/vault/store.js";
import { resolveToggle } from "../src/swap/toggle.js";
import type { AccountRecord, ActiveState, OauthAccount } from "../src/types.js";

function rec(name: string, email: string): AccountRecord {
  return {
    name,
    credential: { claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: 1, refreshTokenExpiresAt: 2 } },
    oauthAccount: { emailAddress: email, accountUuid: "u", organizationUuid: "o" },
    savedAt: 1,
  };
}

function stubActive(email: string | null): ActiveState {
  const acc: OauthAccount | null = email
    ? { emailAddress: email, accountUuid: "u", organizationUuid: "o" }
    : null;
  return {
    platform: () => "darwin",
    readCredential: async () => null,
    writeCredential: async () => {},
    readOauthAccount: async () => acc,
    mergeOauthAccount: async () => {},
  };
}

function vaultAt(dir: string) {
  return createVault({ env: { MACSUB_HOME: dir } });
}

test("toggle: two accounts → the non-active one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "macsub-toggle-"));
  try {
    const vault = vaultAt(dir);
    await vault.save(rec("alpha", "a@x.com"));
    await vault.save(rec("work", "w@x.com"));
    await vault.setActive("alpha");
    assert.deepEqual(await resolveToggle(vault, stubActive("a@x.com")), { to: "work", from: "alpha" });
    await vault.setActive("work");
    assert.deepEqual(await resolveToggle(vault, stubActive("w@x.com")), { to: "alpha", from: "work" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("toggle: null pointer falls back to live email match", async () => {
  const dir = mkdtempSync(join(tmpdir(), "macsub-toggle-"));
  try {
    const vault = vaultAt(dir);
    await vault.save(rec("alpha", "a@x.com"));
    await vault.save(rec("work", "w@x.com"));
    assert.deepEqual(await resolveToggle(vault, stubActive("w@x.com")), { to: "alpha", from: "work" });
    // no pointer, live email matches nothing → swap to first, from null
    assert.deepEqual(await resolveToggle(vault, stubActive("z@x.com")), { to: "alpha", from: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("toggle: not exactly two accounts → throws naming them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "macsub-toggle-"));
  try {
    const vault = vaultAt(dir);
    await assert.rejects(resolveToggle(vault, stubActive(null)), /vault is empty/);
    await vault.save(rec("alpha", "a@x.com"));
    await assert.rejects(resolveToggle(vault, stubActive(null)), /exactly two/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
