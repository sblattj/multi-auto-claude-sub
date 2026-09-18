import type { ClaudeAiOauth } from "../types.js";

export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

export interface FetchRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
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
}

export class OAuthClient {
  readonly #fetch: FetchImpl;

  constructor(fetchImpl: FetchImpl = (url, init) => globalThis.fetch(url, init)) {
    this.#fetch = fetchImpl;
  }

  async refreshTokens(refreshToken: string): Promise<ClaudeAiOauth> {
    return this.#tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    });
  }

  async exchangeCode(args: ExchangeCodeArgs): Promise<ClaudeAiOauth> {
    return this.#tokenRequest({
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: args.redirectUri,
      code_verifier: args.codeVerifier,
      client_id: CLIENT_ID,
    });
  }

  async #tokenRequest(params: Record<string, string>): Promise<ClaudeAiOauth> {
    const res = await this.#fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(params).toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      throw parseOauthError(res.status, text);
    }
    return parseClaudeAiOauth(text);
  }
}

function parseOauthError(status: number, body: string): OAuthError {
  let code: string | undefined;
  let description: string | undefined;
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    if (typeof json.error === "string") code = json.error;
    if (typeof json.error_description === "string") description = json.error_description;
  } catch {
    // non-JSON error body
  }
  if (code === undefined && description !== undefined) code = "oauth_error";
  return new OAuthError(status, code ?? `http_${status}`, description);
}

function parseClaudeAiOauth(body: string): ClaudeAiOauth {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new MalformedTokenResponseError("body is not valid JSON");
  }
  if (typeof json !== "object" || json === null) {
    throw new MalformedTokenResponseError("body is not a JSON object");
  }
  const raw = json as Record<string, unknown>;
  const { accessToken, refreshToken, expiresAt, refreshTokenExpiresAt } = raw;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new MalformedTokenResponseError("accessToken missing or empty");
  }
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new MalformedTokenResponseError("refreshToken missing or empty");
  }
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    throw new MalformedTokenResponseError("expiresAt missing or not a finite number");
  }
  if (typeof refreshTokenExpiresAt !== "number" || !Number.isFinite(refreshTokenExpiresAt)) {
    throw new MalformedTokenResponseError("refreshTokenExpiresAt missing or not a finite number");
  }
  return { ...raw, accessToken, refreshToken, expiresAt, refreshTokenExpiresAt };
}
