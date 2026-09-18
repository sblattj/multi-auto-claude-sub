import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface CallbackCapture {
  code: string;
  state: string;
}

export interface CallbackListener {
  port: number;
  waitForCode(timeoutMs?: number): Promise<CallbackCapture>;
  close(): Promise<void>;
}

export class CallbackTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`callback: no code captured within ${timeoutMs}ms`);
    this.name = "CallbackTimeoutError";
  }
}

const SUCCESS_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>macsub</title></head>' +
  "<body><p>macsub: login captured — you can close this tab.</p></body></html>";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: Error): void;
}

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function startCallbackListener(): Promise<CallbackListener> {
  const captured = makeDeferred<CallbackCapture>();
  const closed = makeDeferred<void>();
  let settled = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const shutdown = (err?: Error): void => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    server.close();
    server.closeIdleConnections();
    if (err !== undefined && !settled) {
      settled = true;
      captured.reject(err);
    }
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.end("method not allowed");
      return;
    }
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    if (code.length === 0 || state.length === 0) {
      res.statusCode = 400;
      res.end("missing code/state");
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(SUCCESS_HTML);
    res.on("finish", () => {
      server.close();
      server.closeIdleConnections();
    });
    if (!settled) {
      settled = true;
      captured.resolve({ code, state });
    }
  });
  server.once("close", () => closed.resolve());

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    shutdown();
    throw new Error("callback: failed to bind 127.0.0.1 ephemeral port");
  }
  const port = (addr as AddressInfo).port;

  const waitForCode = (timeoutMs?: number): Promise<CallbackCapture> => {
    if (timeoutMs === undefined) return captured.promise;
    return new Promise<CallbackCapture>((resolve, reject) => {
      const t = setTimeout(() => {
        timers.delete(t);
        const err = new CallbackTimeoutError(timeoutMs);
        reject(err);
        shutdown(err);
      }, timeoutMs);
      timers.add(t);
      captured.promise.then(
        (cap) => {
          clearTimeout(t);
          timers.delete(t);
          resolve(cap);
        },
        (err) => {
          clearTimeout(t);
          timers.delete(t);
          reject(err);
        },
      );
    });
  };

  return {
    port,
    waitForCode,
    close: async () => {
      shutdown(new Error("callback listener closed before code captured"));
      if (!server.listening) closed.resolve();
      await closed.promise;
    },
  };
}
