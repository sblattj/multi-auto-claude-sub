import test from "node:test";
import assert from "node:assert/strict";
import { describeError, trustSystemCAs, type CaApi } from "../src/util/net.js";

function fakeTls(current: string[], system: string[]): CaApi & { set?: string[] } {
  const api: CaApi & { set?: string[] } = {
    getCACertificates: (type) => (type === "system" ? system : current),
    setDefaultCACertificates: (certs) => {
      api.set = certs;
    },
  };
  return api;
}

test("trustSystemCAs: adds OS roots missing from the defaults", () => {
  const api = fakeTls(["bundled-1", "bundled-2"], ["bundled-2", "zscaler-root"]);
  assert.deepEqual(trustSystemCAs(api, {}), { mode: "added", count: 1 });
  assert.deepEqual(api.set, ["bundled-1", "bundled-2", "zscaler-root"]);
});

test("trustSystemCAs: nothing to add, unsupported Node, opt-out, failure", () => {
  const same = fakeTls(["a"], ["a"]);
  assert.deepEqual(trustSystemCAs(same, {}), { mode: "none-needed" });
  assert.equal(same.set, undefined);
  assert.deepEqual(trustSystemCAs({}, {}), { mode: "unsupported" });
  const optOut = fakeTls(["a"], ["b"]);
  assert.deepEqual(trustSystemCAs(optOut, { MACSUB_SYSTEM_CA: "0" }), { mode: "disabled" });
  assert.equal(optOut.set, undefined);
  const broken: CaApi = {
    getCACertificates: () => {
      throw new Error("keychain locked");
    },
    setDefaultCACertificates: () => {},
  };
  assert.deepEqual(trustSystemCAs(broken, {}), { mode: "failed", detail: "keychain locked" });
});

function fetchFailed(cause: unknown): TypeError {
  return new TypeError("fetch failed", { cause });
}

test("describeError: TLS trust failures name the code and the proxy fix", () => {
  const cause = Object.assign(new Error("unable to get local issuer certificate"), {
    code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  });
  const text = describeError(fetchFailed(cause));
  assert.match(text, /^fetch failed: UNABLE_TO_GET_ISSUER_CERT_LOCALLY \(a TLS-inspecting proxy/);
  assert.match(text, /NODE_OPTIONS=--use-system-ca/);
});

test("describeError: network codes, AggregateError causes, plain errors", () => {
  const dns = Object.assign(new Error("getaddrinfo ENOTFOUND x"), { code: "ENOTFOUND" });
  assert.equal(describeError(fetchFailed(dns)), "fetch failed: ENOTFOUND (DNS lookup failed; offline or VPN/DNS trouble?)");
  const agg = new AggregateError([Object.assign(new Error("refused"), { code: "ECONNREFUSED" })], "");
  assert.equal(describeError(fetchFailed(agg)), "fetch failed: ECONNREFUSED (connection refused; proxy or firewall?)");
  assert.equal(describeError(fetchFailed(new Error("other side closed"))), "fetch failed: other side closed");
  assert.equal(describeError(new Error("oauth error invalid_grant (HTTP 400)")), "oauth error invalid_grant (HTTP 400)");
  assert.equal(describeError("boom"), "boom");
});
