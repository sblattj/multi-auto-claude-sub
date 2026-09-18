/**
 * OPTIONAL live test — exercises PAGE_CLASSIFIER_EXPR / focus emulation / trusted
 * click / focusAndType against a real Chrome on the local debug port, using a
 * data: URL fixture (loopback only, no external network). Skipped unless
 * MACSUB_CDP_LIVE=1; auto-skips when no debug endpoint is discoverable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CdpConnection, discoverBase, evalInPage } from "../src/cdp/connection.js";
import { EMAIL_FIELD_EXPR, PAGE_CLASSIFIER_EXPR } from "../src/cdp/classify.js";
import { pollForActionable, trustedClick, withFocusEmulation } from "../src/cdp/focus.js";
import { focusAndType } from "../src/cdp/fill.js";

const LIVE = process.env.MACSUB_CDP_LIVE === "1";

const fixture = `<!doctype html><html><body>
  <input type="email" placeholder="email">
  <button id="b" disabled>Authorize</button>
  <script>
    setTimeout(() => { document.getElementById("b").disabled = false; }, 300);
  </script>
</body></html>`;

test(
  "live: classify + trusted-click focus-gated Authorize + email fill on data: fixture",
  { skip: LIVE ? false : "set MACSUB_CDP_LIVE=1 to run" },
  async () => {
    const base = await discoverBase();
    assert.ok(base, "no Chrome DevTools endpoint discovered");
    const conn = await CdpConnection.open(base);
    let targetId = "";
    try {
      // Chrome refuses top-level data: URLs via /json/new (tab stays about:blank),
      // so open our own blank tab and navigate it over our WebSocket instead.
      const tab = await conn.newTab("about:blank");
      targetId = tab.targetId;
      await conn.send("Page.navigate", { url: "data:text/html;charset=utf-8," + encodeURIComponent(fixture) });

      const result = await withFocusEmulation(conn, async () => {
        // wait for the data: page to parse (fresh tab starts as about:blank/unknown)
        const deadline = Date.now() + 5000;
        let first: unknown = null;
        while (Date.now() < deadline) {
          first = await evalInPage(conn, PAGE_CLASSIFIER_EXPR);
          if ((first as { kind?: string })?.kind !== "unknown") break;
          await new Promise((r) => setTimeout(r, 100));
        }
        // classifier precedence: authorize-button (disabled) beats the email field
        assert.equal((first as { kind?: string })?.kind, "authorize-button");
        assert.equal((first as { disabled?: boolean })?.disabled, true);

        await focusAndType(conn, EMAIL_FIELD_EXPR, "macsub-live@example.com");

        // button enables after 300ms — pollForActionable must wait it out
        const hit = await pollForActionable(conn, {
          timeoutMs: 5000,
          pollMs: 50,
          kinds: ["authorize-button"],
        });
        assert.equal(hit.disabled, false);
        await trustedClick(conn, { x: hit.x, y: hit.y });

        return evalInPage(conn, `document.querySelector("input[type=email]").value`);
      });
      assert.equal(result, "macsub-live@example.com");
    } finally {
      if (targetId) await conn.closeTab(targetId).catch(() => {});
      conn.close();
    }
  },
);
