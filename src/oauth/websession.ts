import type { CredentialBlob } from "../types.js";
import { challenge, generateVerifier, randomState } from "./pkce.js";
import { CLIENT_ID, OAuthClient, OAuthError, type FetchImpl } from "./client.js";

export const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const ACCOUNT_URL = "https://claude.ai/api/account";
const AUTHORIZE_BASE = "https://claude.ai/v1/oauth";
const FULL_SCOPES = "user:inference user:sessions:claude_code";
const FALLBACK_SCOPES = "user:inference";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const STALE_CODE = "session_stale_relogin";

/** claude.ai rejected the sessionKey as too stale for OAuth elevation; caller
 * must set webSession.stale = true and fall through to L3. */
export class StaleSessionError extends Error {
  constructor(cause?: unknown) {
    super("claude.ai session too stale for OAuth elevation (session_stale_relogin)");
    this.name = "StaleSessionError";
    this.cause = cause;
  }
}

export class EmailMismatchError extends Error {
  constructor(
    readonly expectedEmail: string,
    readonly actualEmail: string,
  ) {
    super(`sessionKey belongs to ${actualEmail}, expected ${expectedEmail}`);
    this.name = "EmailMismatchError";
  }
}

interface AccountApiResponse {
  account?: { email_address?: unknown };
  email_address?: unknown;
  memberships?: Array<{ organization?: { uuid?: unknown } }>;
}

function extractOrgAndEmail(json: unknown): { orgUuid: string; email: string } {
  if (typeof json !== "object" || json === null) {
    throw new OAuthError(200, "malformed_account_response", "/api/account returned a non-object");
  }
  const body = json as AccountApiResponse;
  const email = body.account?.email_address ?? body.email_address;
  const orgUuid = body.memberships?.[0]?.organization?.uuid;
  if (typeof email !== "string" || email.length === 0) {
    throw new OAuthError(200, "malformed_account_response", "no email_address in /api/account response");
  }
  if (typeof orgUuid !== "string" || orgUuid.length === 0) {
    throw new OAuthError(200, "malformed_account_response", "no memberships[0].organization.uuid in /api/account response");
  }
  return { orgUuid, email };
}

/**
 * L2 headless login (SPEC §5): sessionKey cookie → org uuid + email check →
 * PKCE authorize on claude.ai → code exchange on platform.claude.com.
 * On `session_stale_relogin` retries once with user:inference-only scopes;
 * a second stale rejection throws StaleSessionError.
 */
export async function websessionLogin(
  sessionKey: string,
  expectedEmail: string,
  fetchImpl?: FetchImpl,
): Promise<CredentialBlob> {
  const fetch: FetchImpl = fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  const cookie = `sessionKey=${sessionKey}`;

  const accountRes = await fetch(ACCOUNT_URL, {
    method: "GET",
    headers: { accept: "application/json", cookie, "user-agent": USER_AGENT },
  });
  const accountBody = await accountRes.text();
  if (!accountRes.ok) {
    throw toOauthError(accountRes.status, accountBody, "account lookup failed");
  }
  const { orgUuid, email } = extractOrgAndEmail(safeJson(accountBody));
  if (email.toLowerCase() !== expectedEmail.toLowerCase()) {
    throw new EmailMismatchError(expectedEmail, email);
  }

  const verifier = generateVerifier();
  const authorize = async (scope: string): Promise<string> => {
    const res = await fetch(`${AUTHORIZE_BASE}/${orgUuid}/authorize`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        origin: "https://claude.ai",
        referer: "https://claude.ai/",
        cookie,
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        response_type: "code",
        scope,
        code_challenge: challenge(verifier),
        code_challenge_method: "S256",
        redirect_uri: REDIRECT_URI,
        state: randomState(),
      }),
    });
    const text = await res.text();
    const json = safeJson(text);
    const errCode = errorField(json);
    if (!res.ok || errCode !== undefined) {
      throw toOauthError(res.status, text, "authorize failed", json);
    }
    const code = jsonRecord(json).authorization_code;
    if (typeof code !== "string" || code.length === 0) {
      throw new OAuthError(res.status, "malformed_authorize_response", "no authorization_code in response");
    }
    return code;
  };

  let code: string;
  try {
    code = await authorize(FULL_SCOPES);
  } catch (err) {
    if (err instanceof OAuthError && err.code === STALE_CODE) {
      try {
        code = await authorize(FALLBACK_SCOPES);
      } catch (retryErr) {
        if (retryErr instanceof OAuthError && retryErr.code === STALE_CODE) {
          throw new StaleSessionError(retryErr);
        }
        throw retryErr;
      }
    } else {
      throw err;
    }
  }

  const client = new OAuthClient(fetch);
  const claudeAiOauth = await client.exchangeCode({ code, redirectUri: REDIRECT_URI, codeVerifier: verifier });
  return { claudeAiOauth };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function jsonRecord(json: unknown): Record<string, unknown> {
  return typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
}

function errorField(json: unknown): string | undefined {
  const v = jsonRecord(json).error;
  return typeof v === "string" ? v : undefined;
}

function toOauthError(status: number, body: string, context: string, parsed?: unknown): OAuthError {
  const json = parsed ?? safeJson(body);
  const rec = jsonRecord(json);
  const code = typeof rec.error === "string" ? rec.error : undefined;
  const desc = typeof rec.error_description === "string" ? rec.error_description : undefined;
  const detail = desc !== undefined ? `${context}: ${desc}` : context;
  return new OAuthError(status, code ?? `http_${status}`, detail);
}
