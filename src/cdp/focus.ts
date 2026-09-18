/**
 * Focus emulation + trusted input for the macsub login agent (SPEC §6 steps 4-5).
 * Ports the technique from sblattj/cdp-toolkit focus-emulation.ts: a background
 * tab believes it is focused via Emulation.setFocusEmulationEnabled, then
 * Input.dispatchMouseEvent produces a TRUSTED (isTrusted:true) click no content
 * script can synthesize — the pair that defeats Anthropic's hasFocus()-gated
 * Authorize button without stealing OS window focus.
 */
import { evalInPage, type CdpSender } from "./connection.js";
import { PAGE_CLASSIFIER_EXPR, parseClassification, type PageClass, type PageKind } from "./classify.js";

/** pollForActionable timeout — carries the last classification seen. */
export class PollTimeoutError extends Error {
  constructor(
    message: string,
    readonly last: PageClass,
  ) {
    super(message);
    this.name = "PollTimeoutError";
  }
}

/**
 * Enable focus emulation, run fn, ALWAYS restore {enabled:false} in finally —
 * a thrown body never strands the page in a fake-focused state. The restore
 * failure is swallowed so it can't mask the original error.
 */
export async function withFocusEmulation<T>(conn: CdpSender, fn: () => Promise<T>): Promise<T> {
  await conn.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  try {
    return await fn();
  } finally {
    await conn.send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
  }
}

/** Trusted click: mouseMoved → mousePressed → mouseReleased at viewport coords. */
export async function trustedClick(conn: CdpSender, at: { x: number; y: number }): Promise<void> {
  const base = { x: at.x, y: at.y, button: "left", buttons: 1, clickCount: 1 };
  await conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
  await conn.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
  await conn.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
}

function actionable(c: PageClass, kinds: readonly PageKind[]): c is PageClass & { x: number; y: number } {
  if (!kinds.includes(c.kind)) return false;
  if (c.kind === "authorize-button" && c.disabled === true) return false;
  return typeof c.x === "number" && typeof c.y === "number" && Number.isFinite(c.x) && Number.isFinite(c.y);
}

/**
 * Poll the classifier until one of `kinds` is actionable (authorize-button that
 * is not disabled, or a field with coordinates) or the deadline passes.
 * Timeout throws PollTimeoutError carrying the last classification.
 */
export async function pollForActionable(
  conn: CdpSender,
  opts: { timeoutMs: number; pollMs: number; kinds: readonly PageKind[] },
): Promise<PageClass & { x: number; y: number }> {
  const start = Date.now();
  let last: PageClass = { kind: "unknown" };
  for (;;) {
    last = parseClassification(await evalInPage(conn, PAGE_CLASSIFIER_EXPR));
    if (actionable(last, opts.kinds)) return { ...last, x: last.x!, y: last.y! };
    if (Date.now() - start >= opts.timeoutMs) {
      throw new PollTimeoutError(
        `pollForActionable: no actionable [${opts.kinds.join(", ")}] within ${opts.timeoutMs}ms (last: ${last.kind})`,
        last,
      );
    }
    await new Promise((r) => setTimeout(r, opts.pollMs));
  }
}
