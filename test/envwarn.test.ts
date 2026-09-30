import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { ENV_OVERRIDE_VARS, envOverrides, envOverrideWarnings } from "../src/util/envwarn.js";

const execFileP = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "src", "cli.ts");

/** Minimal child env: a throwaway HOME and NONE of the override vars — the
 *  developer shell exporting them must never leak into the control cases. */
function childEnv(home: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const base: Record<string, string> = { HOME: home, PATH: process.env.PATH ?? "" };
  for (const v of ENV_OVERRIDE_VARS) delete base[v];
  return { ...base, ...extra };
}

/** Run the CLI via tsx against a throwaway HOME; returns stdout + exit code. */
async function runCli(t: TestContext, args: string[], extra: Record<string, string> = {}) {
  const home = await mkdtemp(join(tmpdir(), "macsub-envwarn-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  try {
    const { stdout } = await execFileP(process.execPath, ["--import", "tsx", CLI, ...args], {
      cwd: ROOT,
      env: childEnv(home, extra),
      timeout: 30_000,
    });
    return { stdout, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; code?: number };
    return { stdout: err.stdout ?? "", code: err.code ?? -1 };
  }
}

test("envwarn: detects each override var, set and non-empty", () => {
  for (const v of ENV_OVERRIDE_VARS) {
    assert.deepEqual(envOverrides({ [v]: "some-value" }), [v], v);
  }
});

test("envwarn: empty and whitespace-only values are ignored", () => {
  const blank = Object.fromEntries(ENV_OVERRIDE_VARS.map((v) => [v, ""]));
  assert.deepEqual(envOverrides(blank), []);
  assert.deepEqual(envOverrides({ ANTHROPIC_API_KEY: "   " }), []);
});

test("envwarn: multiple vars come back in precedence order", () => {
  assert.deepEqual(
    envOverrides({
      ANTHROPIC_BASE_URL: "https://proxy.example",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x",
      ANTHROPIC_API_KEY: "sk-ant-x",
      ANTHROPIC_AUTH_TOKEN: "tok",
    }),
    ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL"],
  );
});

test("envwarn: warning block is one line per var plus one explanation", () => {
  const lines = envOverrideWarnings(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /^env override: ANTHROPIC_API_KEY is set/);
  assert.match(lines[1]!, /^env override: CLAUDE_CODE_OAUTH_TOKEN is set/);
  assert.match(lines[2]!, /claude reads these before the keychain/);
  assert.deepEqual(envOverrideWarnings([]), []);
});

test("current: warns when override vars are in the env", async (t) => {
  const { stdout, code } = await runCli(t, ["current"], {
    ANTHROPIC_API_KEY: "sk-ant-dummy",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-dummy",
  });
  assert.match(stdout, /env override: ANTHROPIC_API_KEY is set — claude may authenticate with it instead of the vault account/);
  assert.match(stdout, /env override: CLAUDE_CODE_OAUTH_TOKEN is set/);
  assert.match(stdout, /claude reads these before the keychain/);
  // env overrides warn but do not change current's own outcome (empty vault → 1)
  assert.equal(code, 1);
});

test("current: no warning when the env is clean (control)", async (t) => {
  const { stdout, code } = await runCli(t, ["current"]);
  assert.doesNotMatch(stdout, /env override/);
  assert.equal(code, 1);
});

test("doctor: exits 2 when override vars are in the env", async (t) => {
  const { stdout, code } = await runCli(t, ["doctor"], { ANTHROPIC_API_KEY: "sk-ant-dummy" });
  assert.match(stdout, /env override: ANTHROPIC_API_KEY is set/);
  assert.equal(code, 2);
});

test("doctor: exits 0 with a clean env (control)", async (t) => {
  const { stdout, code } = await runCli(t, ["doctor"]);
  assert.doesNotMatch(stdout, /env override: ANTHROPIC_API_KEY is set/);
  assert.match(stdout, /env overrides: none/);
  assert.equal(code, 0);
});
