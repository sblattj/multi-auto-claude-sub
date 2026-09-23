/**
 * Page classification for the macsub login agent (SPEC §6 step 5) — PURE module,
 * zero CDP imports, unit-testable. PAGE_CLASSIFIER_EXPR is a single
 * self-contained expression string for Runtime.evaluate(returnByValue:true);
 * parseClassification defensively converts whatever comes back into a PageClass.
 * Element-location rules (visible = non-zero rect; text match over
 * button/[role=button]/input[submit]; disabled = el.disabled || aria-disabled)
 * adapted from sblattj/cdp-toolkit focus-emulation.ts FIND_BUTTON.
 */

export interface PageClass {
  kind: "authorize-button" | "email-field" | "password-field" | "otp-wait" | "unknown" | "callback";
  /** center of the actionable element's getBoundingClientRect, when it has one */
  x?: number;
  y?: number;
  /** authorize-button only: el.disabled || aria-disabled === 'true' */
  disabled?: boolean;
  /** host + path of the page (never the query, which can carry codes/state) */
  where?: string;
}

export type PageKind = PageClass["kind"];

const KINDS: ReadonlySet<string> = new Set([
  "authorize-button",
  "email-field",
  "password-field",
  "otp-wait",
  "unknown",
  "callback",
]);

/** First VISIBLE input of the given type, as a standalone expression (null if none). */
const visibleField = (type: string): string =>
  `(Array.from(document.querySelectorAll("input[type='${type}']")).find(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }) || null)`;

/** Locate the visible email field — same rule the classifier uses. */
export const EMAIL_FIELD_EXPR = visibleField("email");

/** Locate the visible password field — same rule the classifier uses. */
export const PASSWORD_FIELD_EXPR = visibleField("password");

/**
 * Center + disabled state of the button that submits the visible email/password
 * field (null if none). Prefers the submit button of that field's own form; the
 * text fallback skips third-party sign-in buttons. Login pages list "Continue with
 * Google" before "Continue with email", so a first-match /continue/ clicks Google.
 */
export const CONTINUE_BUTTON_EXPR = `(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const label = (b) => (b.textContent || b.value || "").trim();
  const thirdParty = /google|apple|sso|microsoft|github|passkey/i;
  const field = Array.from(document.querySelectorAll("input[type='email'],input[type='password']")).find(visible);
  const inForm = field && field.form
    ? Array.from(field.form.querySelectorAll("button,input[type=submit]")).find(b => b.type === "submit" && visible(b) && !thirdParty.test(label(b)))
    : null;
  const rx = /continue|next|log ?in|sign ?in/i;
  const btn = inForm || Array.from(document.querySelectorAll("button,[role=button],input[type=submit]"))
    .find(b => visible(b) && rx.test(label(b)) && !thirdParty.test(label(b)));
  if (!btn) return null;
  const r = btn.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: !!(btn.disabled || btn.getAttribute("aria-disabled") === "true") };
})()`;

/**
 * Classify the login page. Precedence: localhost callback > enabled-or-disabled
 * Authorize button > email field > password field > OTP text > unknown.
 */
export const PAGE_CLASSIFIER_EXPR = `(() => {
  const where = (location.host + location.pathname).slice(0, 120);
  const center = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  const classify = () => {
    if (location.host.indexOf("localhost") === 0) return { kind: "callback" };
    const authorize = Array.from(document.querySelectorAll("button,[role=button],input[type=submit]"))
      .find(b => { const r = b.getBoundingClientRect(); if (r.width === 0 || r.height === 0) return false; return (b.textContent || b.value || "").trim().toLowerCase() === "authorize"; });
    if (authorize) return { kind: "authorize-button", x: center(authorize).x, y: center(authorize).y, disabled: !!(authorize.disabled || authorize.getAttribute("aria-disabled") === "true") };
    const email = ${EMAIL_FIELD_EXPR};
    if (email) return { kind: "email-field", x: center(email).x, y: center(email).y };
    const password = ${PASSWORD_FIELD_EXPR};
    if (password) return { kind: "password-field", x: center(password).x, y: center(password).y };
    if (/check your email|verification code|one-time/i.test(document.body ? document.body.innerText : "")) return { kind: "otp-wait" };
    return { kind: "unknown" };
  };
  return Object.assign(classify(), { where });
})()`;

/** Defensive parse of a classifier result (or anything else) into a PageClass. */
export function parseClassification(raw: unknown): PageClass {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { kind: "unknown" };
  const r = raw as Record<string, unknown>;
  const out: PageClass = { kind: KINDS.has(r.kind as string) ? (r.kind as PageKind) : "unknown" };
  if (typeof r.x === "number" && Number.isFinite(r.x)) out.x = r.x;
  if (typeof r.y === "number" && Number.isFinite(r.y)) out.y = r.y;
  if (typeof r.disabled === "boolean") out.disabled = r.disabled;
  if (typeof r.where === "string" && r.where.length > 0) out.where = r.where.slice(0, 120);
  return out;
}
