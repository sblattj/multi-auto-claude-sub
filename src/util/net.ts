/** Network plumbing: OS certificate trust for built-in fetch, and error text
 *  that keeps the low-level cause instead of undici's bare "fetch failed". */
import * as tls from "node:tls";

/** The slice of node:tls used here; getCACertificates needs Node ≥22.15 and
 *  setDefaultCACertificates Node ≥22.19 / ≥24.5, so both may be missing. */
export interface CaApi {
  getCACertificates?: (type: "default" | "system") => string[];
  setDefaultCACertificates?: (certs: string[]) => void;
}

export type SystemCaStatus =
  | { mode: "added"; count: number }
  | { mode: "none-needed" }
  | { mode: "unsupported" }
  | { mode: "disabled" }
  | { mode: "failed"; detail: string };

let lastStatus: SystemCaStatus | undefined;

/**
 * Trust the OS certificate store (macOS Keychain, Windows cert store) on top of
 * Node's bundled roots. TLS-inspecting proxies (Zscaler, Netskope, …) re-sign
 * every HTTPS response with a root that only the OS trusts, so without this
 * every token refresh fails with UNABLE_TO_GET_ISSUER_CERT_LOCALLY.
 * MACSUB_SYSTEM_CA=0 opts out.
 */
export function trustSystemCAs(api: CaApi = tls as CaApi, env: NodeJS.ProcessEnv = process.env): SystemCaStatus {
  lastStatus = computeTrust(api, env);
  return lastStatus;
}

function computeTrust(api: CaApi, env: NodeJS.ProcessEnv): SystemCaStatus {
  if (env.MACSUB_SYSTEM_CA === "0") return { mode: "disabled" };
  if (typeof api.getCACertificates !== "function" || typeof api.setDefaultCACertificates !== "function") {
    return { mode: "unsupported" };
  }
  try {
    const current = api.getCACertificates("default");
    const have = new Set(current);
    const extra = api.getCACertificates("system").filter((c) => !have.has(c));
    if (extra.length === 0) return { mode: "none-needed" };
    api.setDefaultCACertificates([...current, ...extra]);
    return { mode: "added", count: extra.length };
  } catch (err) {
    return { mode: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Result of the last trustSystemCAs() call (doctor reports it). */
export function systemCaStatus(): SystemCaStatus | undefined {
  return lastStatus;
}

const TLS_TRUST_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_GET_ISSUER_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_UNTRUSTED",
]);

const CODE_HINTS: Record<string, string> = {
  ENOTFOUND: "DNS lookup failed; offline or VPN/DNS trouble?",
  EAI_AGAIN: "DNS lookup failed; offline or VPN/DNS trouble?",
  ECONNREFUSED: "connection refused; proxy or firewall?",
  ECONNRESET: "connection reset; proxy or firewall?",
  ETIMEDOUT: "connection timed out",
  UND_ERR_CONNECT_TIMEOUT: "connection timed out",
};

export const TLS_TRUST_HINT =
  "a TLS-inspecting proxy (Zscaler, Netskope, …) is re-signing HTTPS with a root Node does not trust; " +
  "macsub trusts the OS store on Node ≥22.19 or ≥24.5, otherwise run with NODE_OPTIONS=--use-system-ca " +
  "or NODE_EXTRA_CA_CERTS=<root.pem>";

function codeOf(v: unknown): string | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const code = (v as { code?: unknown }).code;
  if (typeof code === "string") return code;
  // happy-eyeballs failures arrive as an AggregateError of per-address errors
  const errors = (v as { errors?: unknown }).errors;
  if (Array.isArray(errors)) return errors.map(codeOf).find((c) => c !== undefined);
  return undefined;
}

/** Error text for logs: keeps the cause code undici hides behind "fetch failed"
 *  and adds a hint for the usual culprits. */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  const code = codeOf(cause) ?? codeOf(err);
  if (code !== undefined && !err.message.includes(code)) {
    const hint = TLS_TRUST_CODES.has(code) ? TLS_TRUST_HINT : CODE_HINTS[code];
    return `${err.message}: ${code}${hint ? ` (${hint})` : ""}`;
  }
  if (cause instanceof Error && cause.message && !err.message.includes(cause.message)) {
    return `${err.message}: ${cause.message}`;
  }
  return err.message;
}
