import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseClassification,
  PAGE_CLASSIFIER_EXPR,
  EMAIL_FIELD_EXPR,
  PASSWORD_FIELD_EXPR,
  CONTINUE_BUTTON_EXPR,
} from "../src/cdp/classify.js";

test("parseClassification: nullish and primitives -> unknown", () => {
  for (const hostile of [null, undefined, 0, 42, "", "authorize-button", true, Number.NaN]) {
    assert.deepEqual(parseClassification(hostile), { kind: "unknown" }, `input ${String(hostile)}`);
  }
});

test("parseClassification: arrays and functions -> unknown", () => {
  assert.deepEqual(parseClassification([]), { kind: "unknown" });
  assert.deepEqual(parseClassification([{ kind: "email-field" }]), { kind: "unknown" });
  assert.deepEqual(parseClassification(() => {}), { kind: "unknown" });
});

test("parseClassification: empty or kind-less object -> unknown kind (coords kept)", () => {
  assert.deepEqual(parseClassification({}), { kind: "unknown" });
  assert.deepEqual(parseClassification({ x: 1, y: 2 }), { kind: "unknown", x: 1, y: 2 });
});

test("parseClassification: unknown kind string -> unknown kind (coords kept)", () => {
  assert.deepEqual(parseClassification({ kind: "evil", x: 1 }), { kind: "unknown", x: 1 });
  assert.deepEqual(parseClassification({ kind: "Authorize-Button" }), { kind: "unknown" });
});

test("parseClassification: every valid kind passes through", () => {
  const kinds = [
    ["authorize-button", { kind: "authorize-button", x: 10.5, y: 20.5, disabled: true }],
    ["authorize-button enabled", { kind: "authorize-button", x: 1, y: 2, disabled: false }],
    ["email-field", { kind: "email-field", x: 3, y: 4 }],
    ["password-field", { kind: "password-field", x: 5, y: 6 }],
    ["otp-wait", { kind: "otp-wait" }],
    ["unknown", { kind: "unknown" }],
    ["callback", { kind: "callback" }],
  ] as const;
  for (const [, input] of kinds) {
    assert.deepEqual(parseClassification(input), input);
  }
});

test("parseClassification: non-finite or non-number coords are dropped, not coerced", () => {
  const c = parseClassification({ kind: "email-field", x: "12", y: Number.NaN });
  assert.equal(c.kind, "email-field");
  assert.equal("x" in c, false);
  assert.equal("y" in c, false);
  const inf = parseClassification({ kind: "email-field", x: Infinity, y: 8 });
  assert.equal("x" in inf, false);
  assert.equal(inf.y, 8);
});

test("parseClassification: non-boolean disabled is dropped", () => {
  const c = parseClassification({ kind: "authorize-button", x: 1, y: 2, disabled: "true" });
  assert.equal(c.disabled, undefined);
  assert.equal("disabled" in c, false);
  assert.equal(parseClassification({ kind: "authorize-button", disabled: true }).disabled, true);
});

test("parseClassification: null kind value -> unknown kind (valid coords still kept)", () => {
  assert.deepEqual(parseClassification({ kind: null, x: 1, y: 2 }), { kind: "unknown", x: 1, y: 2 });
});

test("classifier expression sanity (structure only — live eval is the optional live test)", () => {
  assert.equal(typeof PAGE_CLASSIFIER_EXPR, "string");
  assert.match(PAGE_CLASSIFIER_EXPR, /localhost/);
  assert.match(PAGE_CLASSIFIER_EXPR, /authorize-button/);
  assert.match(PAGE_CLASSIFIER_EXPR, /input\[type=['"]?email['"]?\]/);
  assert.match(PAGE_CLASSIFIER_EXPR, /verification code|one-time/);
  assert.equal(PAGE_CLASSIFIER_EXPR.startsWith("(() => {"), true);
  assert.equal(PAGE_CLASSIFIER_EXPR.endsWith("})()"), true);
  assert.match(EMAIL_FIELD_EXPR, /input\[type=['"]?email['"]?\]/);
  assert.match(PAGE_CLASSIFIER_EXPR, new RegExp(EMAIL_FIELD_EXPR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(PASSWORD_FIELD_EXPR, /input\[type=['"]?password['"]?\]/);
  assert.match(CONTINUE_BUTTON_EXPR, /continue|next|log/);
});

// ---- behavior against a minimal fake DOM (layout mirrors the real login pages) ----

interface FakeEl {
  tag: string;
  typeAttr?: string;
  role?: string;
  text?: string;
  value?: string;
  form?: FakeForm | null;
  disabled?: boolean;
  visible?: boolean;
  y: number;
  readonly type: string;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  getAttribute(name: string): string | null;
  textContent: string;
}

interface FakeForm {
  els: FakeEl[];
  querySelectorAll(sel: string): FakeEl[];
}

function matches(el: FakeEl, selector: string): boolean {
  return selector.split(",").some((one) => {
    const m = /^([a-z]*)(?:\[([a-z]+)(?:=['"]?([a-z]+)['"]?)?\])?$/.exec(one.trim());
    if (!m) throw new Error(`fake DOM cannot parse selector ${one}`);
    const [, tag, attr, val] = m;
    if (tag && el.tag !== tag) return false;
    if (attr) {
      const v = attr === "type" ? el.typeAttr : attr === "role" ? el.role : undefined;
      if (val !== undefined ? v !== val : v === undefined) return false;
    }
    return true;
  });
}

function el(tag: string, props: Partial<FakeEl> & { y: number }): FakeEl {
  const e = {
    form: null,
    visible: true,
    ...props,
    tag,
    get type(): string {
      return this.typeAttr ?? (tag === "button" ? "submit" : "text");
    },
    get textContent(): string {
      return this.text ?? "";
    },
    getBoundingClientRect() {
      return this.visible ? { left: 0, top: this.y, width: 100, height: 20 } : { left: 0, top: 0, width: 0, height: 0 };
    },
    getAttribute(_name: string): string | null {
      return null;
    },
  } as FakeEl;
  return e;
}

function page(els: FakeEl[], where = { host: "claude.ai", pathname: "/login" }, bodyText = "") {
  const document = {
    body: { innerText: bodyText },
    querySelectorAll: (sel: string) => els.filter((e) => matches(e, sel)),
  };
  return {
    run: (expr: string): unknown => new Function("document", "location", `return ${expr}`)(document, where),
  };
}

function form(): FakeForm {
  const f: FakeForm = { els: [], querySelectorAll: (sel) => f.els.filter((e) => matches(e, sel)) };
  return f;
}

/** claude.ai / Console login: provider buttons first, then the email form. */
function loginPage(): { els: FakeEl[] } {
  const f = form();
  const email = el("input", { typeAttr: "email", value: "me@example.com", form: f, y: 300 });
  const submit = el("button", { typeAttr: "submit", text: "Continue with email", form: f, y: 340 });
  const sso = el("button", { typeAttr: "button", text: "Continue with SSO", form: f, y: 380 });
  f.els.push(email, submit, sso);
  return {
    els: [
      el("button", { typeAttr: "button", text: "Continue with Google", y: 100 }),
      el("button", { typeAttr: "button", text: "Continue with Apple", y: 140 }),
      email,
      submit,
      sso,
    ],
  };
}

test("CONTINUE_BUTTON_EXPR: login page -> the email form's submit, never Continue with Google", () => {
  const hit = page(loginPage().els).run(CONTINUE_BUTTON_EXPR) as { y: number; disabled: boolean };
  assert.equal(hit.y, 350, "center of 'Continue with email' (top 340 + 10)");
  assert.equal(hit.disabled, false);
});

test("CONTINUE_BUTTON_EXPR: no form -> first text match that is not a third-party provider", () => {
  const els = [
    el("input", { typeAttr: "email", y: 10 }),
    el("button", { text: "Continue with Google", y: 100 }),
    el("button", { text: "Log in with SSO", y: 140 }),
    el("button", { text: "Continue", y: 180 }),
  ];
  const hit = page(els).run(CONTINUE_BUTTON_EXPR) as { y: number };
  assert.equal(hit.y, 190);
});

test("CONTINUE_BUTTON_EXPR: only provider buttons -> null (nothing safe to click)", () => {
  const els = [
    el("input", { typeAttr: "email", y: 10 }),
    el("button", { text: "Continue with Google", y: 100 }),
    el("button", { text: "Continue with Apple", y: 140 }),
  ];
  assert.equal(page(els).run(CONTINUE_BUTTON_EXPR), null);
});

test("PAGE_CLASSIFIER_EXPR: reports where it is (host + path, no query)", () => {
  const cls = parseClassification(page(loginPage().els).run(PAGE_CLASSIFIER_EXPR));
  assert.equal(cls.kind, "email-field");
  assert.equal(cls.where, "claude.ai/login");

  const google = parseClassification(
    page([], { host: "accounts.google.com", pathname: "/v3/signin/identifier" }).run(PAGE_CLASSIFIER_EXPR),
  );
  assert.deepEqual(google, { kind: "unknown", where: "accounts.google.com/v3/signin/identifier" });
});

test("parseClassification: where must be a non-empty string, capped at 120 chars", () => {
  assert.equal(parseClassification({ kind: "unknown", where: 5 }).where, undefined);
  assert.equal(parseClassification({ kind: "unknown", where: "" }).where, undefined);
  assert.equal(parseClassification({ kind: "unknown", where: "x".repeat(500) }).where?.length, 120);
});
