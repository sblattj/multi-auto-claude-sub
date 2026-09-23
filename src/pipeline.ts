/**
 * Health ladder orchestration (SPEC §5): L0 fresh → L1 refresh → L2 web-session
 * → L3 browser agent → L4 manual. Composes the vault/swap, oauth and cdp modules.
 */
import type { AccountRecord, ActiveState, HealthResult, Vault } from "./types.js";
import { refreshWithCas, type TokenRefresher } from "./oauth/health.js";
import { AUTHORIZE_URL, CLIENT_ID, LOGIN_SCOPES, OAuthClient } from "./oauth/client.js";
import type { FetchImpl } from "./oauth/client.js";
import { StaleSessionError, websessionLogin } from "./oauth/websession.js";
import { startCallbackListener } from "./oauth/callback.js";
import { challenge, generateVerifier, randomState } from "./oauth/pkce.js";
import { runLoginAgent } from "./cdp/agent.js";
import { installFreshCredential } from "./swap/swap.js";
import { withClaudeLocks } from "./swap/locks.js";
import { log } from "./util/log.js";

export interface EnsureOptions {
  fetchImpl?: FetchImpl;
  /** account password for the browser login form (opt-in keychain storage; cli supplies) */
  password?: string;
  onNotify?: (msg: string) => void;
  loginTimeoutMs?: number;
  /** skip L0/L1 and go straight to L2/L3 (macsub login) */
  force?: boolean;
  /** lock/config path resolution (tests) */
  env?: NodeJS.ProcessEnv;
  /** L3 agent override (tests) */
  loginAgent?: typeof runLoginAgent;
}

export interface AuthorizeUrlArgs {
  redirectUri: string;
  codeChallenge: string;
  state: string;
  /** account email; prefills the claude.ai login form */
  loginHint?: string;
}

/** The authorize URL Claude Code builds for a claude.ai (subscription) login. */
export function buildAuthorizeUrl(args: AuthorizeUrlArgs): string {
  const params = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: args.redirectUri,
    scope: LOGIN_SCOPES.join(" "),
    code_challenge: args.codeChallenge,
    code_challenge_method: "S256",
    state: args.state,
  });
  if (args.loginHint && args.loginHint.includes("@")) params.set("login_hint", args.loginHint);
  return `${AUTHORIZE_URL}?${params}`;
}

/** true when this account is the one installed in Claude Code's live state */
async function isActiveAccount(vault: Vault, name: string): Promise<boolean> {
  return (await vault.activeAccount()) === name;
}

export interface RefreshAccountOptions {
  hasWebSession?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * L0 + L1 for one account. For the live account, the read → refresh → install
 * runs under Claude Code's own refresh locks: running sessions refresh the same
 * one-time token under those locks, so without them both sides can spend it and
 * one ends up with a dead token. A newer live credential (a session already
 * refreshed) is adopted into the vault instead of refreshing again.
 */
export async function refreshAccount(
  vault: Vault,
  active: ActiveState,
  accountName: string,
  client: TokenRefresher,
  opts: RefreshAccountOptions = {},
): Promise<HealthResult> {
  const hasWeb = opts.hasWebSession ?? false;
  if (!(await isActiveAccount(vault, accountName))) {
    // not installed anywhere: nobody else holds this token, no lock needed
    return refreshWithCas(vault, accountName, client, hasWeb);
  }
  return withClaudeLocks(
    async () => {
      const adopted = await adoptLiveCredential(vault, active, accountName);
      const r = await refreshWithCas(vault, accountName, client, hasWeb);
      if (r.level === "refreshed" && r.credential) {
        const rec = await vault.get(accountName);
        await active.writeCredential(r.credential);
        if (rec) await active.mergeOauthAccount(rec.oauthAccount);
      }
      if (adopted && r.level === "fresh") {
        return { ...r, detail: "adopted the live credential (a running Claude Code session already refreshed it)" };
      }
      return r;
    },
    opts.env ? { env: opts.env } : {},
  );
}

/** Caller holds the Claude locks. Saves the live credential into the vault when
 *  it belongs to this account and is newer than the vaulted copy. */
async function adoptLiveCredential(vault: Vault, active: ActiveState, accountName: string): Promise<boolean> {
  const rec = await vault.get(accountName);
  if (rec === null) return false;
  let live;
  let liveAcc;
  try {
    [live, liveAcc] = await Promise.all([active.readCredential(), active.readOauthAccount()]);
  } catch {
    return false; // unreadable live state: fall back to the vault copy
  }
  if (live === null || liveAcc === null) return false;
  if (liveAcc.emailAddress.toLowerCase() !== rec.oauthAccount.emailAddress.toLowerCase()) return false;
  const v = rec.credential.claudeAiOauth;
  const l = live.claudeAiOauth;
  if (l.refreshToken === v.refreshToken && l.accessToken === v.accessToken) return false;
  if (l.expiresAt < v.expiresAt) return false; // the vault copy is the newer one
  await vault.save({ ...rec, credential: live, savedAt: Date.now() });
  return true;
}

export async function ensureHealthy(
  vault: Vault,
  active: ActiveState,
  accountName: string,
  opts: EnsureOptions = {},
): Promise<HealthResult> {
  const rec = await vault.get(accountName);
  if (rec === null) {
    throw new Error(`macsub: unknown account "${accountName}"`);
  }
  const client = new OAuthClient(opts.fetchImpl);
  const notify = opts.onNotify ?? ((m: string) => log.warn(m));
  const hasWeb = rec.webSession != null && rec.webSession.stale !== true;

  // L0 + L1: freshness check + refresh-token flow with CAS re-vault
  let refreshDetail: string | undefined;
  if (!opts.force) {
    const r = await refreshAccount(vault, active, accountName, client, {
      hasWebSession: hasWeb,
      ...(opts.env ? { env: opts.env } : {}),
    });
    if (r.level === "fresh" || r.level === "refreshed") return r;
    refreshDetail = r.detail;
    log.warn(`token refresh failed${r.detail ? `: ${r.detail}` : ""}`);
    if (r.level === "needs-browser-login") {
      return browserLogin(vault, active, accountName, rec, client, opts, notify, refreshDetail);
    }
    // needs-web-session → fall through to L2
  }

  // L2: headless re-login from the saved claude.ai session cookie
  if (rec.webSession && rec.webSession.stale !== true) {
    try {
      log.step("trying saved claude.ai web session (headless)…");
      const credential = await websessionLogin(rec.webSession.sessionKey, rec.oauthAccount.emailAddress, opts.fetchImpl);
      const updated: AccountRecord = { ...rec, credential, lastRefreshedAt: Date.now() };
      await vault.save(updated);
      if (await isActiveAccount(vault, accountName)) {
        await installFreshCredential(active, updated, opts.env ? { env: opts.env } : {});
      }
      return { level: "refreshed", credential: updated.credential };
    } catch (err) {
      if (err instanceof StaleSessionError) {
        log.warn("saved web session is stale — marking and trying the browser agent");
        await vault.save({ ...rec, webSession: { ...rec.webSession, stale: true } });
      } else {
        log.warn(`web-session login failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return browserLogin(vault, active, accountName, rec, client, opts, notify, refreshDetail);
}

/** L3: full OAuth via the CDP-driven browser agent, then L4 fallback. */
async function browserLogin(
  vault: Vault,
  active: ActiveState,
  accountName: string,
  rec: AccountRecord,
  client: OAuthClient,
  opts: EnsureOptions,
  notify: (m: string) => void,
  refreshDetail?: string,
): Promise<HealthResult> {
  log.step("browser auto-login (background tab, focus emulation)…");
  const listener = await startCallbackListener();
  const redirectUri = `http://localhost:${listener.port}/callback`;
  const verifier = generateVerifier();
  const state = randomState();
  const authorizeUrl = buildAuthorizeUrl({
    redirectUri,
    codeChallenge: challenge(verifier),
    state,
    loginHint: rec.oauthAccount.emailAddress,
  });

  const timeoutMs = opts.loginTimeoutMs ?? 180_000;
  // No listener timeout: the agent owns the deadline and reports the page it
  // stalled on. A second timer here fired first and hid that detail.
  const done = listener.waitForCode();
  done.catch(() => {}); // rejects only when closed without a code

  const agent = opts.loginAgent ?? runLoginAgent;
  let result;
  try {
    result = await agent(
      authorizeUrl,
      {
        email: rec.oauthAccount.emailAddress,
        ...(opts.password !== undefined ? { password: opts.password } : {}),
        timeoutMs,
        onNotify: notify,
      },
      {
        startCallbackListener: () => ({ done, close: () => void listener.close() }),
      },
    );
  } finally {
    await listener.close(); // idempotent; never leave the port bound
  }

  if (!result.success || !result.callback) {
    notify("automatic login failed — manual fallback:");
    notify(`  1. run: claude auth login  (log in as ${rec.oauthAccount.emailAddress})`);
    notify(`  2. run: macsub add ${accountName}   (re-captures the fresh login)`);
    const parts = [
      ...(refreshDetail !== undefined ? [`refresh: ${refreshDetail}`] : []),
      ...(result.detail !== undefined ? [`browser: ${result.detail}`] : []),
    ];
    return {
      level: "needs-manual-login",
      ...(parts.length > 0 ? { detail: parts.join("; ") } : {}),
    };
  }

  const { code, state: cbState } = result.callback;
  if (cbState !== state) {
    return { level: "needs-manual-login", detail: "OAuth state mismatch on callback" };
  }
  const oauth = await client.exchangeCode({ code, redirectUri, codeVerifier: verifier, state });
  const updated: AccountRecord = { ...rec, credential: { claudeAiOauth: oauth }, lastRefreshedAt: Date.now() };
  await vault.save(updated);
  if (await isActiveAccount(vault, accountName)) {
    await installFreshCredential(active, updated, opts.env ? { env: opts.env } : {});
  }
  return { level: "refreshed", credential: updated.credential };
}
