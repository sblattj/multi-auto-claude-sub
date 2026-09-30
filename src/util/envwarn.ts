/** Environment variables that override Claude Code's subscription auth.
 *
 * Claude Code authenticates with env vars before it ever reads the keychain
 * subscription login, so a shell exporting any of these silently defeats the
 * vault: `claude` bills a different account than `macsub current` reports.
 * Precedence: ANTHROPIC_AUTH_TOKEN > ANTHROPIC_API_KEY > apiKeyHelper >
 * CLAUDE_CODE_OAUTH_TOKEN > … > keychain subscription OAuth (last). */

export const ENV_OVERRIDE_VARS = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
] as const;

export type EnvOverrideVar = (typeof ENV_OVERRIDE_VARS)[number];

/** Which override vars are set AND non-empty in env (in precedence order). */
export function envOverrides(env: NodeJS.ProcessEnv = process.env): EnvOverrideVar[] {
  return ENV_OVERRIDE_VARS.filter((v) => (env[v] ?? "").trim() !== "");
}

/** Warning block: one line per var, plus one explanation line. Empty when clean. */
export function envOverrideWarnings(vars: readonly EnvOverrideVar[]): string[] {
  if (vars.length === 0) return [];
  return [
    ...vars.map((v) => `env override: ${v} is set — claude may authenticate with it instead of the vault account`),
    "claude reads these before the keychain subscription login (ANTHROPIC_AUTH_TOKEN > ANTHROPIC_API_KEY > CLAUDE_CODE_OAUTH_TOKEN); unset them to bill the vault account",
  ];
}
