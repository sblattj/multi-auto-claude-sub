import type { AccountRecord, ClaudeAiOauth, CredentialBlob, HealthResult, Vault } from "../types.js";
import { redact } from "../util/log.js";

export type AssessLevel = "fresh" | "refreshable" | "dead";

export interface AssessResult {
  level: AssessLevel;
  detail?: string;
}

/** L0/L1 gate: access token must outlive now by >60s; refresh must outlive now. */
export function assess(cred: CredentialBlob, now: number = Date.now()): AssessResult {
  const { expiresAt, refreshTokenExpiresAt } = cred.claudeAiOauth;
  if (expiresAt > now + 60_000) {
    return { level: "fresh" };
  }
  if (refreshTokenExpiresAt > now) {
    return { level: "refreshable" };
  }
  return { level: "dead" };
}

/** Minimal surface refreshWithCas needs; OAuthClient satisfies it structurally. */
export interface TokenRefresher {
  refreshTokens(refreshToken: string, prev?: Partial<ClaudeAiOauth>): Promise<ClaudeAiOauth>;
}

export async function refreshWithCas(
  vault: Vault,
  accountName: string,
  client: TokenRefresher,
  hasWebSession = false,
  now: () => number = Date.now,
): Promise<HealthResult> {
  const rec = await vault.get(accountName);
  if (rec === null) {
    throw new Error(`macsub: unknown account "${accountName}"`);
  }

  const pre = assess(rec.credential, now());
  if (pre.level === "fresh") {
    return { level: "fresh", credential: rec.credential };
  }

  const usedRefreshToken = rec.credential.claudeAiOauth.refreshToken;
  let fresh: CredentialBlob;
  try {
    const claudeAiOauth = await client.refreshTokens(usedRefreshToken, rec.credential.claudeAiOauth);
    fresh = { claudeAiOauth };
  } catch (err) {
    return {
      level: hasWebSession ? "needs-web-session" : "needs-browser-login",
      detail: redact(describe(err)),
    };
  }

  const cur = await vault.get(accountName);
  if (cur !== null && cur.credential.claudeAiOauth.refreshToken === usedRefreshToken) {
    const updated: AccountRecord = { ...cur, credential: fresh, lastRefreshedAt: now() };
    await vault.save(updated);
    return { level: "refreshed", credential: fresh };
  }
  return {
    level: "refreshed",
    credential: fresh,
    detail: "cas-conflict: vaulted refreshToken changed during refresh; vault left untouched",
  };
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
