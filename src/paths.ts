/** Config-path resolution for macsub.
 *
 * All resolution takes an explicit env (default process.env) so behavior is pure
 * and testable. Honors:
 *  - CLAUDE_CONFIG_DIR: config-home override applying to BOTH .credentials.json
 *    and .claude.json
 *  - the legacy ~/.claude/.claude.json alternate config path, valid ONLY if it
 *    contains an oauthAccount key (probed only when CLAUDE_CONFIG_DIR is unset)
 *  - MACSUB_HOME: vault root (default ~/.macsub)
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ResolvedPaths {
  macsubHome: string;
  accountsDir: string;
  vaultConfigFile: string;
  /** last usage snapshot per account (no secrets) */
  usageCacheFile: string;
  configDir: string;
  credentialsFile: string;
  primaryClaudeJson: string;
  legacyClaudeJson: string;
  /** resolved .claude.json: primary unless it is absent and the legacy file
   *  exists and contains an oauthAccount key */
  claudeJson: string;
  sessionsDir: string;
  ideDir: string;
  oauthRefreshLock: string;
  claudeLock: string;
  claudeJsonLock: string;
}

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME ?? env.USERPROFILE ?? homedir();
}

function nonEmpty(v: string | undefined): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function legacyHasOauthAccount(path: string): boolean {
  try {
    const obj: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof obj === "object" && obj !== null && "oauthAccount" in obj;
  } catch {
    return false;
  }
}

export function pathsFor(env: NodeJS.ProcessEnv = process.env): ResolvedPaths {
  const home = homeDir(env);
  const macsubHome = nonEmpty(env.MACSUB_HOME) ?? join(home, ".macsub");
  const configDirOverride = nonEmpty(env.CLAUDE_CONFIG_DIR);
  const configDir = configDirOverride ?? join(home, ".claude");
  const credentialsFile = join(configDir, ".credentials.json");
  const primaryClaudeJson = configDirOverride
    ? join(configDir, ".claude.json")
    : join(home, ".claude.json");
  // With CLAUDE_CONFIG_DIR set there is no separate legacy path: configDir IS
  // the config home for .claude.json.
  const legacyClaudeJson = configDirOverride
    ? join(configDir, ".claude.json")
    : join(home, ".claude", ".claude.json");
  let claudeJson = primaryClaudeJson;
  if (
    !configDirOverride &&
    !existsSync(primaryClaudeJson) &&
    existsSync(legacyClaudeJson) &&
    legacyHasOauthAccount(legacyClaudeJson)
  ) {
    claudeJson = legacyClaudeJson;
  }
  return {
    macsubHome,
    accountsDir: join(macsubHome, "accounts"),
    vaultConfigFile: join(macsubHome, "config.json"),
    usageCacheFile: join(macsubHome, "usage.json"),
    configDir,
    credentialsFile,
    primaryClaudeJson,
    legacyClaudeJson,
    claudeJson,
    sessionsDir: join(configDir, "sessions"),
    ideDir: join(configDir, "ide"),
    oauthRefreshLock: join(configDir, ".oauth_refresh.lock"),
    claudeLock: join(home, ".claude.lock"),
    claudeJsonLock: join(dirname(claudeJson), ".claude.json.lock"),
  };
}
