/**
 * Minimal zero-dependency CDP client for the macsub login agent (SPEC §6).
 * Adapted from sblattj/cdp-toolkit (src/client.ts + src/tools/focus-emulation.ts):
 * id-correlated JSON commands over Node's global WebSocket (Node ≥22) with
 * per-command timeouts so a wedged renderer can never hang the agent. Differences
 * from the reference: no lease machinery and no event fan-out (macsub only drives
 * a tab it created, using Runtime/Input/Emulation), plus multi-port discovery.
 * Reference implementation: https://github.com/sblattj/cdp-toolkit
 */

const DEFAULT_TIMEOUT_MS = 15_000;

/** Probe order from SPEC §6 — never assume 9222 silently. */
const PROBE_PORTS = [9222, 9223, 9224] as const;

export class CdpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "CdpError";
  }
}

/** Anything that can send CDP commands — CdpConnection or a test stub. */
export interface CdpSender {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
}

async function fetchJson<T>(base: string, path: string, timeoutMs: number): Promise<T> {
  const res = await fetch(base + path, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new CdpError(`${base}${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** $CDP_BASE when it answers /json/version, else first probing port that does; null if none. */
export async function discoverBase(): Promise<string | null> {
  const candidates: string[] = [];
  if (process.env.CDP_BASE) candidates.push(process.env.CDP_BASE.replace(/\/+$/, ""));
  for (const port of PROBE_PORTS) candidates.push(`http://127.0.0.1:${port}`);
  for (const base of candidates) {
    try {
      await fetchJson(base, "/json/version", 1500);
      return base;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

interface CdpResponse {
  result?: unknown;
  error?: { message: string; code?: number; data?: unknown };
}

interface Pending {
  resolve: (r: CdpResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One connection to a Chrome debug endpoint: a browser-level WebSocket plus one
 * WebSocket per tab it opened. `send` routes to the active tab socket (set by
 * newTab) so Runtime/Input/Emulation commands land in OUR tab, never a
 * pre-existing one.
 */
export class CdpConnection implements CdpSender {
  private browserWs?: WebSocket;
  private readonly tabSockets = new Map<string, WebSocket>();
  private activeTargetId: string | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private readonly timeoutMs: number;

  private constructor(readonly base: string, timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }

  /** Validate the base via /json/version and connect the browser-level WebSocket. */
  static async open(base: string): Promise<CdpConnection> {
    const norm = base.replace(/\/+$/, "");
    const ver = await fetchJson<{ webSocketDebuggerUrl?: string }>(norm, "/json/version", 5000);
    if (!ver.webSocketDebuggerUrl) {
      throw new CdpError(`${norm}: /json/version returned no webSocketDebuggerUrl`);
    }
    const conn = new CdpConnection(norm, Number(process.env.CDP_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS));
    conn.browserWs = await conn.connectSocket(ver.webSocketDebuggerUrl, "browser");
    return conn;
  }

  private connectSocket(url: string, label: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(
        () => reject(new CdpError(`connect timeout (${label}): ${url}`)),
        this.timeoutMs,
      );
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(ws);
      };
      ws.onerror = (ev) => {
        clearTimeout(timer);
        const msg = (ev as { message?: string }).message ?? "websocket error";
        this.failAll(new CdpError(msg));
        reject(new CdpError(msg));
      };
      ws.onclose = () => this.failAll(new CdpError("connection closed"));
      ws.onmessage = (ev) => this.onMessage(String(ev.data));
    });
  }

  private onMessage(raw: string): void {
    let msg: { id?: number } & CdpResponse;
    try {
      msg = JSON.parse(raw) as { id?: number } & CdpResponse;
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return; // events are ignored — no subscribers here
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.error) {
      p.reject(new CdpError(`command #${msg.id}: ${msg.error.message}`, msg.error.code, msg.error.data));
    } else {
      p.resolve({ result: msg.result });
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private route(): WebSocket | undefined {
    const tab = this.activeTargetId ? this.tabSockets.get(this.activeTargetId) : undefined;
    return tab ?? this.browserWs;
  }

  /** Send a CDP command and await its result. Rejects on CDP error or timeout. */
  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError("connection not open"));
    const ws = this.route();
    if (!ws) return Promise.reject(new CdpError("connection not open"));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`'${method}' timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (r) => {
          if (r.error) reject(new CdpError(`${method}: ${r.error.message}`, r.error.code, r.error.data));
          else resolve((r.result ?? {}) as T);
        },
        reject,
        timer,
      });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CdpError(`send failed (${method}): ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  }

  /**
   * Open our OWN tab via HTTP /json/new (Chrome ≥111 requires PUT; older builds
   * answer GET — 405 triggers the fallback), connect its WebSocket, and make it
   * the active route for send(). Never touches pre-existing tabs.
   */
  async newTab(url: string): Promise<{ targetId: string; wsUrl: string }> {
    const targetUrl = `${this.base}/json/new?${new URLSearchParams({ url })}`;
    let res = await fetch(targetUrl, { method: "PUT", signal: AbortSignal.timeout(this.timeoutMs) });
    if (res.status === 405) {
      res = await fetch(targetUrl, { signal: AbortSignal.timeout(this.timeoutMs) });
    }
    if (!res.ok) throw new CdpError(`/json/new -> HTTP ${res.status}`);
    const target = (await res.json()) as { id?: string; webSocketDebuggerUrl?: string };
    if (!target.id || !target.webSocketDebuggerUrl) {
      throw new CdpError("/json/new returned no target id / webSocketDebuggerUrl");
    }
    this.tabSockets.set(target.id, await this.connectSocket(target.webSocketDebuggerUrl, `tab ${target.id}`));
    this.activeTargetId = target.id;
    return { targetId: target.id, wsUrl: target.webSocketDebuggerUrl };
  }

  /** Close the tab's WebSocket then the tab itself via HTTP /json/close. */
  async closeTab(targetId: string): Promise<void> {
    const ws = this.tabSockets.get(targetId);
    if (ws) {
      try {
        ws.close();
      } catch {
        /* best effort */
      }
      this.tabSockets.delete(targetId);
    }
    if (this.activeTargetId === targetId) this.activeTargetId = null;
    const res = await fetch(`${this.base}/json/close/${encodeURIComponent(targetId)}`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new CdpError(`/json/close/${targetId} -> HTTP ${res.status}`);
  }

  close(): void {
    this.closed = true;
    this.failAll(new CdpError("closed by caller"));
    for (const ws of [this.browserWs, ...this.tabSockets.values()]) {
      try {
        ws?.close();
      } catch {
        /* best effort */
      }
    }
    this.tabSockets.clear();
  }
}

/**
 * Evaluate a self-contained expression in the active page (returnByValue:true)
 * and return its JSON value. Throws CdpError if the page threw.
 */
export async function evalInPage(ws: CdpSender, expression: string): Promise<unknown> {
  const res = await ws.send<{
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  }>("Runtime.evaluate", { expression, returnByValue: true });
  const ex = res.exceptionDetails;
  if (ex) {
    throw new CdpError(`Runtime.evaluate threw: ${ex.exception?.description ?? ex.text ?? "unknown page error"}`);
  }
  return res.result?.value;
}
