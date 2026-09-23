/**
 * The L3 browser auto-login agent (SPEC §6). Attach-only CDP: discovers the
 * debug endpoint, opens its OWN tab at the authorize URL, and drives Anthropic's
 * focus-gated OAuth page with focus emulation + trusted clicks (technique from
 * sblattj/cdp-toolkit focus-emulation.ts — see ../cdp/focus.ts). Every exit path
 * closes the tab it created and disables emulation; never logs tokens.
 */
import http from "node:http";
import type { LoginAgentOptions, LoginAgentResult } from "../types.js";
import { CdpConnection, discoverBase, evalInPage, type CdpSender } from "./connection.js";
import {
  CONTINUE_BUTTON_EXPR,
  EMAIL_FIELD_EXPR,
  PAGE_CLASSIFIER_EXPR,
  PASSWORD_FIELD_EXPR,
  parseClassification,
} from "./classify.js";
import { trustedClick, withFocusEmulation } from "./focus.js";
import { focusAndType } from "./fill.js";
import { redact } from "../util/log.js";

/** Handle to the localhost OAuth callback listener owned by the caller/agent. */
export interface CallbackHandle {
  /** resolves {code,state} once the redirect lands on the local listener */
  done: Promise<{ code: string; state: string }>;
  close(): void;
}

/** What runLoginAgent needs from a connection (CdpConnection or a test stub). */
export interface AgentConn extends CdpSender {
  newTab(url: string): Promise<{ targetId: string; wsUrl: string }>;
  closeTab(targetId: string): Promise<void>;
  close(): void;
}

/** Injection points for tests: conn, discovery, listener, notifications. */
export interface LoginAgentDeps {
  conn?: AgentConn;
  discoverBase?: () => Promise<string | null>;
  startCallbackListener?: () => CallbackHandle | Promise<CallbackHandle>;
  onNotify?: (msg: string) => void;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_MS = 500;
/** Min gap between repeating the same page action (page may lag after a click). */
const ACTION_COOLDOWN_MS = 3_000;

/**
 * Default localhost callback listener: binds 127.0.0.1 on the port named in the
 * authorize URL's redirect_uri (ephemeral if absent/unparseable), resolves
 * {code,state} on GET /callback?code=&state=.
 */
export function startLocalCallbackListener(authorizeUrl: string): CallbackHandle {
  let port = 0;
  try {
    const redirect = new URL(authorizeUrl).searchParams.get("redirect_uri");
    if (redirect) {
      const u = new URL(redirect);
      if (u.hostname === "localhost" || u.hostname === "127.0.0.1") port = Number(u.port) || 0;
    }
  } catch {
    /* fall through to ephemeral */
  }
  let settled = false;
  let resolveDone: (v: { code: string; state: string }) => void = () => {};
  let rejectDone: (e: Error) => void = () => {};
  const done = new Promise<{ code: string; state: string }>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname !== "/callback") {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      "<!doctype html><html><body><h1>macsub: login captured — you can close this tab</h1></body></html>",
    );
    const code = u.searchParams.get("code") ?? "";
    const state = u.searchParams.get("state") ?? "";
    if (!settled && code) {
      settled = true;
      resolveDone({ code, state });
    }
  });
  server.on("error", (e) => {
    if (!settled) {
      settled = true;
      rejectDone(e);
    }
  });
  server.listen(port, "127.0.0.1");
  return { done, close: () => server.close() };
}

function safeDetail(e: unknown): string {
  return redact(e instanceof Error ? e.message : String(e));
}

async function raceCallback(
  done: Promise<{ code: string; state: string }>,
  ms: number,
): Promise<{ code: string; state: string } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      done,
      new Promise<null>((r) => {
        timer = setTimeout(() => r(null), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function clickContinue(conn: CdpSender): Promise<boolean> {
  const raw = await evalInPage(conn, CONTINUE_BUTTON_EXPR);
  if (
    typeof raw !== "object" ||
    raw === null ||
    (raw as Record<string, unknown>).disabled === true
  ) {
    return false;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.x !== "number" || typeof r.y !== "number") return false;
  await trustedClick(conn, { x: r.x, y: r.y });
  return true;
}

async function driveLoop(
  conn: CdpSender,
  listener: CallbackHandle,
  opts: LoginAgentOptions,
  cfg: { timeoutMs: number; pollMs: number; expectedState: string | null; notify: (m: string) => void },
): Promise<LoginAgentResult> {
  const deadline = Date.now() + cfg.timeoutMs;
  const lastActed = new Map<string, number>();
  const canAct = (k: string): boolean => {
    const t = lastActed.get(k);
    return t === undefined || Date.now() - t >= ACTION_COOLDOWN_MS;
  };
  let lastState = "unknown";
  let otpNotified = false;
  let pwNotified = false;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { success: false, stage: "timeout", detail: `no authorization after ${cfg.timeoutMs}ms (last page state: ${lastState})` };
    }
    let cb: { code: string; state: string } | null;
    try {
      cb = await raceCallback(listener.done, Math.min(cfg.pollMs, remaining));
    } catch (e) {
      // keep the page state: it is the only clue to where the login stalled
      return { success: false, stage: "error", detail: `callback listener failed: ${safeDetail(e)} (last page state: ${lastState})` };
    }
    if (cb) {
      if (cfg.expectedState !== null && cb.state !== cfg.expectedState) {
        return { success: false, stage: "error", detail: "callback state mismatch — login aborted without exchanging code" };
      }
      return { success: true, stage: "authorized", callback: { code: cb.code, state: cb.state } };
    }

    const cls = parseClassification(await evalInPage(conn, PAGE_CLASSIFIER_EXPR));
    lastState = cls.where ? `${cls.kind} at ${cls.where}` : cls.kind;
    switch (cls.kind) {
      case "authorize-button": {
        // clickFocusGated semantics: keep polling while disabled; trusted-click once enabled.
        if (cls.disabled !== true && typeof cls.x === "number" && typeof cls.y === "number" && canAct("authorize")) {
          lastActed.set("authorize", Date.now());
          await trustedClick(conn, { x: cls.x, y: cls.y });
        }
        break;
      }
      case "email-field": {
        if (canAct("email")) {
          lastActed.set("email", Date.now());
          await focusAndType(conn, EMAIL_FIELD_EXPR, opts.email);
          await clickContinue(conn);
        }
        break;
      }
      case "password-field": {
        if (opts.password !== undefined && opts.password !== "") {
          if (canAct("password")) {
            lastActed.set("password", Date.now());
            await focusAndType(conn, PASSWORD_FIELD_EXPR, opts.password);
            await clickContinue(conn);
          }
        } else if (!pwNotified) {
          pwNotified = true;
          cfg.notify("macsub: password needed — type it in the browser window (login page is waiting)");
        }
        break;
      }
      case "otp-wait": {
        if (!otpNotified) {
          otpNotified = true;
          cfg.notify("macsub: one-time code required — check your email and enter it in the browser window");
        }
        break;
      }
      default:
        break; // 'callback' → listener will capture it; 'unknown' → keep polling
    }
  }
}

/**
 * Drive the OAuth login in a background tab. Returns {success:false, stage:'no-chrome'}
 * when no debug endpoint is found; always closes its own tab, disables focus
 * emulation, and stops the callback listener — including on error paths.
 */
export async function runLoginAgent(
  authorizeUrl: string,
  opts: LoginAgentOptions,
  deps: LoginAgentDeps = {},
): Promise<LoginAgentResult> {
  const notify = deps.onNotify ?? opts.onNotify ?? (() => {});
  let listener: CallbackHandle;
  try {
    listener = await (deps.startCallbackListener?.() ?? startLocalCallbackListener(authorizeUrl));
  } catch (e) {
    return { success: false, stage: "error", detail: safeDetail(e) };
  }
  try {
    let conn: AgentConn | null = deps.conn ?? null;
    const ownedConn = conn === null;
    if (!conn) {
      const base = await (deps.discoverBase ?? discoverBase)();
      if (base === null) {
        return {
          success: false,
          stage: "no-chrome",
          detail: "no Chrome DevTools endpoint (CDP_BASE unset; probed 127.0.0.1:9222,9223,9224)",
        };
      }
      conn = await CdpConnection.open(base);
    }
    let tab: { targetId: string } | null = null;
    try {
      tab = await conn.newTab(authorizeUrl);
      let expectedState: string | null = null;
      try {
        expectedState = new URL(authorizeUrl).searchParams.get("state");
      } catch {
        expectedState = null;
      }
      return await withFocusEmulation(conn, () =>
        driveLoop(conn!, listener, opts, {
          timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          pollMs: opts.pollMs ?? DEFAULT_POLL_MS,
          expectedState,
          notify,
        }),
      );
    } finally {
      if (tab) {
        try {
          await conn.closeTab(tab.targetId);
        } catch {
          /* cleanup is best-effort; never mask the real result */
        }
      }
      if (ownedConn && conn) conn.close();
    }
  } catch (e) {
    return { success: false, stage: "error", detail: safeDetail(e) };
  } finally {
    try {
      listener.close();
    } catch {
      /* best effort */
    }
  }
}
