import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { detectLiveSessions } from "../src/swap/sessions.js";

test("sessions: live pid warned, dead pid ignored, ide port lock warned", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "macsub-sessions-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sessionsDir = join(base, "sessions");
  const ideDir = join(base, "ide");
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(ideDir, { recursive: true });
  // dead pid: 999999 exceeds macOS pid_max, process.kill → ESRCH
  await writeFile(join(sessionsDir, "999999.json"), "{}");
  // live pid: this very test process
  await writeFile(join(sessionsDir, `${process.pid}.json`), "{}");
  // non-pid filenames ignored
  await writeFile(join(sessionsDir, "README.json"), "{}");
  await writeFile(join(ideDir, "9323.lock"), "");
  await writeFile(join(ideDir, "notaport.lock"), "");

  const warnings = await detectLiveSessions({ sessionsDir, ideDir });
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((w) => w.includes(String(process.pid))), "live pid must be reported");
  assert.ok(!warnings.some((w) => w.includes("999999")), "dead pid must not be reported");
  assert.ok(warnings.some((w) => w.includes("9323")), "ide port lock must be reported");
});

test("sessions: missing dirs → no warnings, no throw", async () => {
  const warnings = await detectLiveSessions({
    sessionsDir: "/nonexistent-macsub/sessions",
    ideDir: "/nonexistent-macsub/ide",
  });
  assert.deepEqual(warnings, []);
});

test("sessions: never kills — detection only (functional smoke: still alive)", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "macsub-sessions-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sessionsDir = join(base, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(sessionsDir, `${process.pid}.json`), "{}");
  await detectLiveSessions({ sessionsDir, ideDir: join(base, "ide") });
  // if detection had killed the pid we'd never reach this assertion
  assert.equal(process.kill(process.pid, 0), true);
});
