/**
 * Health ladder orchestration (SPEC §5): L0 fresh → L1 refresh → L2 web-session
 * → L3 browser agent → L4 manual. Composes the vault/swap, oauth and cdp modules.
 */
import type { AccountRecord, ActiveState, HealthResult, Vault } from "./types.js";
import { refreshWithCas } from "./oauth/health.js";
import { OAuthClient } from "./oauth/client.js";
import type { FetchImpl } from "./oauth/client.js";
import { StaleSessionError, websessionLogin } from "./oauth/websession.js";
import { startCallbackListener } from "./oauth/callback.js";
import { challenge, generateVerifier, randomState } from "./oauth/pkce.js";
import { runLoginAgent } from "./cdp/agent.js";
import { installFreshCredential } from "./swap/swap.js";
import { log } from "./util/log.js";

export interface EnsureOptions {
  fetchImpl?: FetchImpl;
  /** account password for the browser login form (opt-in keychain storage; cli supplies) */
  password?: string;
  onNotify?: (msg: string) => void;
  loginTimeoutMs?: number;
  /** skip L0/L1 and go straight to L2/L3 (macsub login) */
  force?: boolean;
}

const AUTHORIZE_URL = "https://platform.claude.com/oauth/authorize";
const OAUTH_SCOPES = "user:inference user:sessions:claude_code";

/** true when this account is the one installed in Claude Code's live state */
async function isActiveAccount(vault: Vault, name: string): Promise<boolean> {
  return (await vault.activeAccount()) === name;
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

  // L0 + L1: freshness check + refresh-token flow with CAS re-vault
  if (!opts.force) {
    const r = await refreshWithCas(vault, accountName, client, rec.webSession != null && rec.webSession.stale !== true);
    if (r.level === "fresh") return r;
    if (r.level === "refreshed") {
      if (r.credential && (await isActiveAccount(vault, accountName))) {
        await installFreshCredential(active, { ...rec, credential: r.credential });
      }
      return r;
    }
    if (r.level === "needs-browser-login") {
      return browserLogin(vault, active, accountName, rec, client, opts, notify);
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
        await installFreshCredential(active, updated);
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

  return browserLogin(vault, active, accountName, rec, client, opts, notify);
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
): Promise<HealthResult> {
  log.step("browser auto-login (background tab, focus emulation)…");
  const listener = await startCallbackListener();
  const redirectUri = `http://localhost:${listener.port}/callback`;
  const verifier = generateVerifier();
  const state = randomState();
  const authorizeUrl = `${AUTHORIZE_URL}?${new URLSearchParams({
    client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    response_type: "code",
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPES,
    code_challenge: challenge(verifier),
    code_challenge_method: "S256",
    state,
  })}`;

  const timeoutMs = opts.loginTimeoutMs ?? 180_000;
  const done = listener.waitForCode(timeoutMs);
  done.catch(() => {}); // no unhandled rejection if the agent times out first

  const result = await runLoginAgent(
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

  if (!result.success || !result.callback) {
    notify("automatic login failed — manual fallback:");
    notify(`  1. run: claude login  (log in as ${rec.oauthAccount.emailAddress})`);
    notify(`  2. run: macsub add ${accountName}   (re-captures the fresh login)`);
    return {
      level: "needs-manual-login",
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
    };
  }

  const { code, state: cbState } = result.callback;
  if (cbState !== state) {
    return { level: "needs-manual-login", detail: "OAuth state mismatch on callback" };
  }
  const oauth = await client.exchangeCode({ code, redirectUri, codeVerifier: verifier });
  const updated: AccountRecord = { ...rec, credential: { claudeAiOauth: oauth }, lastRefreshedAt: Date.now() };
  await vault.save(updated);
  if (await isActiveAccount(vault, accountName)) {
    await installFreshCredential(active, updated);
  }
  return { level: "refreshed", credential: updated.credential };
}
