import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireDirLock, LockTimeoutError, withClaudeLocks, withConfigLock } from "../src/swap/locks.js";

const SEC = 1000;

test("locks: acquire creates dir, release removes it, release idempotent", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "macsub-locks-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const path = join(base, "test.lock");
  const lock = await acquireDirLock(path, { staleMs: 60 * SEC, touchMs: 5 * SEC });
  assert.ok(existsSync(path));
  assert.ok(existsSync(join(path, ".macsub-owner")));
  await lock.release();
  assert.ok(!existsSync(path));
  await lock.release(); // idempotent
});

test("locks: busy lock rejects with LockTimeoutError after waitMs", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "macsub-locks-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const path = join(base, "test.lock");
  const l1 = await acquireDirLock(path, { staleMs: 60 * SEC, touchMs: 5 * SEC });
  await assert.rejects(
    () => acquireDirLock(path, { staleMs: 60 * SEC, touchMs: 5 * SEC, waitMs: 150, pollMs: 50 }),
    LockTimeoutError,
  );
  await l1.release();
});

test("locks: stale lock (backdated mtime via utimes) is broken and retaken", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "macsub-locks-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const path = join(base, "test.lock");
  const l1 = await acquireDirLock(path, { staleMs: SEC, touchMs: 5 * SEC });
  // backdate mtime well beyond the 1s stale window
  const old = new Date(Date.now() - 30 * SEC);
  await utimes(path, old, old);
  const l2 = await acquireDirLock(path, { staleMs: SEC, touchMs: 5 * SEC, waitMs: 2 * SEC, pollMs: 50 });
  assert.ok(existsSync(path));
  // previous owner's release must NOT delete the new owner's lock (token check)
  await l1.release();
  assert.ok(existsSync(path), "old owner release must not remove the retaken lock");
  await l2.release();
  assert.ok(!existsSync(path));
});

test("locks: lock dir vanished externally → next acquire recreates it", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "macsub-locks-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const path = join(base, "test.lock");
  const l1 = await acquireDirLock(path, { staleMs: 60 * SEC, touchMs: 5 * SEC });
  await rm(path, { recursive: true, force: true });
  const l2 = await acquireDirLock(path, { staleMs: 60 * SEC, touchMs: 5 * SEC, waitMs: 2 * SEC, pollMs: 50 });
  await l1.release(); // no-op: dir exists but token differs? token file also new → mismatch → skip
  assert.ok(existsSync(path));
  await l2.release();
});

test("locks: touch interval keeps a held lock fresh past the stale window", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "macsub-locks-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const path = join(base, "test.lock");
  const staleMs = 800;
  const l1 = await acquireDirLock(path, { staleMs, touchMs: 100 });
  await new Promise((r) => setTimeout(r, staleMs + 300)); // > stale window
  const mtime = (await stat(path)).mtimeMs;
  assert.ok(Date.now() - mtime < staleMs, "mtime must have been touched recently");
  // still fresh → a second acquire times out rather than breaking it
  await assert.rejects(
    () => acquireDirLock(path, { staleMs, touchMs: 100, waitMs: 200, pollMs: 50 }),
    LockTimeoutError,
  );
  await l1.release();
  assert.ok(!existsSync(path));
});

test("locks: withConfigLock holds <dir>/.claude.json.lock (stale 10s) around fn", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "macsub-locks-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const claudeJson = join(base, ".claude.json");
  const lockPath = join(base, ".claude.json.lock");
  let seen: boolean;
  const out = await withConfigLock(
    async () => {
      seen = existsSync(lockPath);
      return 42;
    },
    { env: { HOME: base }, claudeJsonPath: claudeJson },
  );
  assert.equal(out, 42);
  assert.ok(seen!);
  assert.ok(!existsSync(lockPath), "lock released after fn");
});

test("locks: withClaudeLocks acquires oauth_refresh then .claude.lock, releases both", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "macsub-locks-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { HOME: home, CLAUDE_CONFIG_DIR: join(home, "cc") };
  const oauthLock = join(home, "cc", ".oauth_refresh.lock");
  const claudeLock = join(home, ".claude.lock");
  const order: string[] = [];
  await withClaudeLocks(
    async () => {
      order.push("fn");
      assert.ok(existsSync(oauthLock));
      assert.ok(existsSync(claudeLock));
    },
    { env },
  );
  assert.deepEqual(order, ["fn"]);
  assert.ok(!existsSync(oauthLock));
  assert.ok(!existsSync(claudeLock));
});

test("locks: withClaudeLocks releases both when fn throws", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "macsub-locks-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { HOME: home, CLAUDE_CONFIG_DIR: join(home, "cc") };
  await assert.rejects(
    () =>
      withClaudeLocks(
        async () => {
          throw new Error("boom");
        },
        { env },
      ),
    /boom/,
  );
  assert.ok(!existsSync(join(home, "cc", ".oauth_refresh.lock")));
  assert.ok(!existsSync(join(home, ".claude.lock")));
});
