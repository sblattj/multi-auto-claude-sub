/**
 * Field filling for the macsub login agent (SPEC §6 fill-safety rules, burned
 * recipes from sblattj/cdp-toolkit): Input.insertText delivers to WHATEVER is
 * focused, so focus must be proven landed (document.activeElement === el) before
 * inserting — the two-gate rule — and the field value verified after, with an
 * input+change event dispatched for React controlled inputs.
 */
import { evalInPage, type CdpSender } from "./connection.js";

export class FillError extends Error {
  constructor(
    message: string,
    readonly gate: "locate" | "focus" | "verify-value",
  ) {
    super(message);
    this.name = "FillError";
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Focus the element located by `selectorExpr` (a self-contained JS expression
 * evaluating to the element or null — same location rules as the classifier),
 * prove focus landed, insertText `text`, then verify the value contains it and
 * fire input+change. Throws FillError at the first failed gate; never inserts
 * text unless the activeElement gate passed.
 */
export async function focusAndType(conn: CdpSender, selectorExpr: string, text: string): Promise<void> {
  const focus = await evalInPage(
    conn,
    `(() => { const el = ${selectorExpr}; if (!el) return { ok: false, reason: "element not found" }; el.focus(); return { ok: true }; })()`,
  );
  if (!isObj(focus) || focus.ok !== true) {
    throw new FillError(`focusAndType: field not located/focusable (${selectorExpr.slice(0, 60)}…)`, "locate");
  }

  // TWO-GATE RULE: insertText goes to whatever has focus — prove it is OUR field first.
  const verify = await evalInPage(
    conn,
    `(() => { const el = ${selectorExpr}; if (!el) return { focused: false }; return { focused: document.activeElement === el }; })()`,
  );
  if (!isObj(verify) || verify.focused !== true) {
    throw new FillError("focusAndType: focus did not land on the field (two-gate) — insertText skipped", "focus");
  }

  await conn.send("Input.insertText", { text });

  const after = await evalInPage(
    conn,
    `(() => { const el = ${selectorExpr}; if (!el) return { ok: false }; const ok = String(el.value ?? "").includes(${JSON.stringify(text)}); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return { ok }; })()`,
  );
  if (!isObj(after) || after.ok !== true) {
    throw new FillError("focusAndType: field value did not contain the inserted text", "verify-value");
  }
}
