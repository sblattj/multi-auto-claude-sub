import test from "node:test";
import assert from "node:assert/strict";
import { CallbackTimeoutError, startCallbackListener } from "../src/oauth/callback.js";

test("callback: captures code+state over real loopback and serves success HTML", async () => {
  const listener = await startCallbackListener();
  assert.ok(listener.port > 0 && listener.port < 65536);

  const res = await fetch(`http://127.0.0.1:${listener.port}/callback?code=CODE123&state=st-xyz`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("macsub: login captured — you can close this tab."));

  const cap = await listener.waitForCode(1000);
  assert.deepEqual(cap, { code: "CODE123", state: "st-xyz" });

  // repeat calls return the same settled capture
  assert.deepEqual(await listener.waitForCode(), cap);
});

test("callback: rejects malformed requests, keeps waiting, then captures a good one", async () => {
  const listener = await startCallbackListener();

  const bad = await fetch(`http://127.0.0.1:${listener.port}/callback?code=ONLY_CODE`);
  assert.equal(bad.status, 400);

  const notFound = await fetch(`http://127.0.0.1:${listener.port}/other`);
  assert.equal(notFound.status, 404);

  await fetch(`http://127.0.0.1:${listener.port}/callback?code=C2&state=S2`);
  const cap = await listener.waitForCode(500);
  assert.deepEqual(cap, { code: "C2", state: "S2" });
});

test("callback: waitForCode timeout rejects cleanly and shuts the server down", async () => {
  const listener = await startCallbackListener();

  await assert.rejects(listener.waitForCode(80), CallbackTimeoutError);

  // server must be shut down: connections now refuse
  let refused = false;
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${listener.port}/callback?code=x&state=y`);
      await new Promise((r) => setTimeout(r, 40));
    } catch {
      refused = true;
      break;
    }
  }
  assert.ok(refused, "server still accepting connections after timeout");
});

test("callback: waitForCode without timeout still honors later close()", async () => {
  const listener = await startCallbackListener();
  const waiting = listener.waitForCode();
  const verdict = assert.rejects(waiting, /closed before code captured/);
  await listener.close();
  await verdict;
});
