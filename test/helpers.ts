/** Shared scripted-connection stubs for cdp tests (never touches a network). */
import type { CdpSender } from "../src/cdp/connection.js";
import type { CallbackHandle } from "../src/cdp/agent.js";

export interface ScriptedOpts {
  /** queue of Runtime.evaluate return VALUES (consumed in order) */
  script?: unknown[];
  /** when the queue empties, keep returning the last value */
  repeatLast?: boolean;
  /** reject any send whose method matches */
  throwOn?: Record<string, Error>;
  onSend?: (method: string, params: Record<string, unknown>) => void;
}

export class ScriptedConn implements CdpSender {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly evals: string[] = [];
  private readonly script: unknown[];
  private last: unknown;

  constructor(private readonly opts: ScriptedOpts = {}) {
    this.script = [...(opts.script ?? [])];
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    this.opts.onSend?.(method, params);
    const boom = this.opts.throwOn?.[method];
    if (boom) return Promise.reject(boom);
    if (method === "Runtime.evaluate") {
      this.evals.push(String(params.expression));
      const next = this.script.length > 0 ? this.script.shift() : this.opts.repeatLast ? this.last : undefined;
      this.last = next;
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve({ result: { value: next } } as T);
    }
    return Promise.resolve({} as T);
  }

  sendsOf(method: string): Array<Record<string, unknown>> {
    return this.calls.filter((c) => c.method === method).map((c) => c.params);
  }

  focusToggles(): Array<boolean | undefined> {
    return this.sendsOf("Emulation.setFocusEmulationEnabled").map((p) => p.enabled as boolean);
  }
}

export class ScriptedAgentConn extends ScriptedConn {
  readonly newTabs: string[] = [];
  readonly closedTabs: string[] = [];

  async newTab(url: string): Promise<{ targetId: string; wsUrl: string }> {
    this.newTabs.push(url);
    return { targetId: "T1", wsUrl: "ws://127.0.0.1:9222/devtools/page/T1" };
  }

  async closeTab(targetId: string): Promise<void> {
    this.closedTabs.push(targetId);
  }

  close(): void {
    /* noop */
  }
}

export function deferredCallback(): {
  handle: CallbackHandle;
  resolve: (v: { code: string; state: string }) => void;
  isClosed: () => boolean;
} {
  let resolve!: (v: { code: string; state: string }) => void;
  let closed = false;
  const done = new Promise<{ code: string; state: string }>((r) => {
    resolve = r;
  });
  return { handle: { done, close: () => (closed = true) }, resolve, isClosed: () => closed };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
