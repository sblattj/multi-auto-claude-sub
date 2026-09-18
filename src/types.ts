/** Shared contracts for multi-auto-claude-sub. This file is the single source
 * of truth for cross-module types. Seats must code against these, not redeclare. */

export interface ClaudeAiOauth {
  accessToken: string;
  refreshToken: string;
  /** epoch ms — access token expiry */
  expiresAt: number;
  /** epoch ms — refresh token expiry; past this, only re-login works */
  refreshTokenExpiresAt: number;
  scopes?: string[];
  [k: string]: unknown;
}

export interface CredentialBlob {
  claudeAiOauth: ClaudeAiOauth;
}

export interface OauthAccount {
  emailAddress: string;
  accountUuid: string;
  organizationUuid: string;
  organizationName?: string;
  [k: string]: unknown;
}

export interface WebSession {
  /** claude.ai `sessionKey` cookie value (prefix sk-ant-) */
  sessionKey: string;
  savedAt: number;
  /** true when claude.ai rejected it as too stale for OAuth elevation */
  stale?: boolean;
}

export interface AccountRecord {
  name: string;
  credential: CredentialBlob;
  oauthAccount: OauthAccount;
  webSession?: WebSession;
  savedAt: number;
  lastRefreshedAt?: number;
}

export type SwapOutcome =
  | "swapped"
  | "swapped-with-warnings"
  | "failed-keychain-push"
  | "failed-unknown-account"
  | "failed-active-state-unreadable";

export interface SwapResult {
  outcome: SwapOutcome;
  from: string | null;
  to: string;
  warnings: string[];
  detail?: string;
}

export type HealthLevel =
  | "fresh" // access token valid
  | "refreshed" // refresh flow succeeded
  | "needs-web-session" // refresh dead, but a webSession cookie exists to try
  | "needs-browser-login" // must run the CDP login agent
  | "needs-manual-login"; // everything failed; print manual instructions

export interface HealthResult {
  level: HealthLevel;
  credential?: CredentialBlob;
  detail?: string;
}

export interface Vault {
  list(): Promise<AccountRecord[]>;
  get(name: string): Promise<AccountRecord | null>;
  save(rec: AccountRecord): Promise<void>;
  remove(name: string): Promise<void>;
  /** name of the account the tool believes is active, or null */
  activeAccount(): Promise<string | null>;
  setActive(name: string | null): Promise<void>;
}

/** The live "logged in as" state that Claude Code itself reads/writes. */
export interface ActiveState {
  platform(): NodeJS.Platform;
  /** keychain (macOS, authoritative) or .credentials.json (linux/win) */
  readCredential(): Promise<CredentialBlob | null>;
  /** On macOS: delete-all-then-add keychain item; mirror file write. Throws on failure. */
  writeCredential(blob: CredentialBlob): Promise<void>;
  readOauthAccount(): Promise<OauthAccount | null>;
  /** read-modify-write of ONLY the account-bound keys into the live config; never replaces other keys */
  mergeOauthAccount(acc: OauthAccount): Promise<void>;
}

export type LoginAgentStage =
  | "authorized"
  | "otp-wait"
  | "password-required"
  | "timeout"
  | "no-chrome"
  | "callback-captured"
  | "error";

export interface LoginAgentResult {
  success: boolean;
  stage: LoginAgentStage;
  detail?: string;
  /** authorization code + state captured from the localhost callback, if we got that far */
  callback?: { code: string; state: string };
}

export interface LoginAgentOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** account email for the login form */
  email: string;
  /** ONLY set when the user opted into storing it (OS keychain); never persist in vault files */
  password?: string;
  onNotify?: (msg: string) => void;
}
