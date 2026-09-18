import { createHash, randomBytes } from "node:crypto";

const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** PKCS S256 code_verifier: 43 chars of the RFC 7636 unreserved set. */
export function generateVerifier(): string {
  return base64url(randomBytes(32));
}

/** S256 challenge: base64url(sha256(verifier)), no padding. */
export function challenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "ascii").digest());
}

export function randomState(): string {
  return base64url(randomBytes(24));
}

export function isVerifierShaped(v: string): boolean {
  return VERIFIER_RE.test(v);
}
