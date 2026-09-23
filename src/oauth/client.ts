import type { ClaudeAiOauth } from "../types.js";

export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
/** Claude Code's CLAUDE_AI_AUTHORIZE_URL (subscription login). The similar-looking
 *  platform.claude.com/oauth/authorize is the Console (API billing) login. */
export const AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
/** Scopes Claude Code refreshes a claude.ai login with. */
export const CLAUDE_AI_SCOPES: readonly string[] = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
  "user:plugins",
];
/** Scopes Claude Code requests on a fresh claude.ai login. */
export const LOGIN_SCOPES: readonly string[] = ["org:create_api_key", ...CLAUDE_AI_SCOPES];

const REQUEST_TIMEOUT_MS = 30_000;
/** Used only when the server omits refresh_token_expires_in and there is no
 *  previous expiry to keep (Claude Code's own fallback is 30 days). */
const REFRESH_TOKEN_FALLBACK_TTL_MS = 30 * 86_400_000;

export interface FetchRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type FetchImpl = (url: string, init: FetchRequestInit) => Promise<Response>;

export class OAuthError extends Error {
  readonly code: string;
  readonly status: number;
  readonly description?: string;

  constructor(status: number, code: string, description?: string) {
    super(
      description
        ? `oauth error ${code} (HTTP ${status}): ${description}`
        : `oauth error ${code} (HTTP ${status})`,
    );
    this.name = "OAuthError";
    this.status = status;
    this.code = code;
    if (description !== undefined) this.description = description;
  }
}

export class MalformedTokenResponseError extends Error {
  constructor(detail: string) {
    super(`malformed token response: ${detail}`);
    this.name = "MalformedTokenResponseError";
  }
}

export interface ExchangeCodeArgs {
  code: string;
  redirectUri: string;
  codeVerifier: string;
  /** the state sent to the authorize endpoint; Claude Code echoes it here */
  state: string;
}

export class OAuthClient {
  readonly #fetch: FetchImpl;
  readonly #now: () => number;

  constructor(fetchImpl: FetchImpl = (url, init) => globalThis.fetch(url, init), now: () => number = Date.now) {
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  /** Refresh with a one-time refresh token. `prev` (the credential being
   *  refreshed) supplies the scopes to request and any fields the server omits;
   *  its extra keys (subscriptionType, rateLimitTier, …) are carried over. */
  async refreshTokens(refreshToken: string, prev?: Partial<ClaudeAiOauth>): Promise<ClaudeAiOauth> {
    const scopes = prev?.scopes && prev.scopes.length > 0 ? prev.scopes : CLAUDE_AI_SCOPES;
    const fresh = await this.#tokenRequest(
      {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        scope: scopes.join(" "),
      },
      { ...prev, refreshToken },
    );
    return { ...prev, ...fresh };
  }

  async exchangeCode(args: ExchangeCodeArgs): Promise<ClaudeAiOauth> {
    return this.#tokenRequest(
      {
        grant_type: "authorization_code",
        code: args.code,
        redirect_uri: args.redirectUri,
        client_id: CLIENT_ID,
        code_verifier: args.codeVerifier,
        state: args.state,
      },
      {},
    );
  }

  async #tokenRequest(params: Record<string, string>, fallback: Partial<ClaudeAiOauth>): Promise<ClaudeAiOauth> {
    const res = await this.#fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      throw parseOauthError(res.status, text);
    }
    return parseTokenResponse(text, fallback, this.#now());
  }
}

function parseOauthError(status: number, body: string): OAuthError {
  let code: string | undefined;
  let description: string | undefined;
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    if (typeof json.error === "string") {
      code = json.error;
      if (typeof json.error_description === "string") description = json.error_description;
    } else if (typeof json.error === "object" && json.error !== null) {
      // Anthropic API envelope, e.g. HTTP 429 {"error":{"type":"rate_limit_error","message":…}}
      const e = json.error as Record<string, unknown>;
      if (typeof e.type === "string") code = e.type;
      if (typeof e.message === "string") description = e.message;
    }
  } catch {
    // non-JSON error body
  }
  if (code === undefined && description !== undefined) code = "oauth_error";
  return new OAuthError(status, code ?? `http_${status}`, description);
}

/** The token endpoint answers in OAuth snake_case (access_token, expires_in in
 *  seconds, …); convert to the camelCase epoch-ms shape Claude Code stores. */
function parseTokenResponse(body: string, fallback: Partial<ClaudeAiOauth>, now: number): ClaudeAiOauth {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new MalformedTokenResponseError("body is not valid JSON");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new MalformedTokenResponseError("body is not a JSON object");
  }
  const raw = json as Record<string, unknown>;

  const accessToken = raw.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new MalformedTokenResponseError("access_token missing or empty");
  }
  const refreshToken =
    typeof raw.refresh_token === "string" && raw.refresh_token.length > 0 ? raw.refresh_token : fallback.refreshToken;
  if (refreshToken === undefined || refreshToken.length === 0) {
    throw new MalformedTokenResponseError("refresh_token missing or empty");
  }
  const expiresIn = raw.expires_in;
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new MalformedTokenResponseError("expires_in missing or not a positive number");
  }
  const refreshIn = raw.refresh_token_expires_in;
  const refreshTokenExpiresAt =
    typeof refreshIn === "number" && Number.isFinite(refreshIn) && refreshIn > 0
      ? now + refreshIn * 1000
      : (fallback.refreshTokenExpiresAt ?? now + REFRESH_TOKEN_FALLBACK_TTL_MS);

  const out: ClaudeAiOauth = { accessToken, refreshToken, expiresAt: now + expiresIn * 1000, refreshTokenExpiresAt };
  if (typeof raw.scope === "string") out.scopes = raw.scope.split(" ").filter(Boolean);
  else if (fallback.scopes !== undefined) out.scopes = fallback.scopes;
  return out;
}
