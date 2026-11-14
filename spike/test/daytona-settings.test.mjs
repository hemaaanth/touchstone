// Settings for the execution backend (app/server/settings.mjs).
// Provider settings and the spend ledger stay in this test's private store.
import { TEST_STORE_DIR } from "./helpers/isolated-env.mjs";
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// A known console token, set before the import, so the guard can be tested.
const TOKEN = "t6-test-token";
process.env.TOUCHSTONE_GRANT_TOKEN = TOKEN;
process.env.SPEND_LEDGER = join(TEST_STORE_DIR, "spend.json");
const providersUrl = new URL("../lib/providers.mjs", import.meta.url).href;
const realProviders = await import(providersUrl);
let store = {};
const readConfig = () => structuredClone({ default: null, capUsd: null, providers: {}, ...store });
const writeConfig = (cfg) => { store = structuredClone(cfg); };
mock.module(providersUrl, { exports: { ...realProviders, readConfig, writeConfig } });
const { getSettings, setExecution, settingsWriteAllowed, settingsWriteRefusal } = await import("../../app/server/settings.mjs");

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

test("getSettings shows the execution backend with a masked key", () => {
  const fake = "dtn_test_key_value_9z8y";
  withEnv({ DAYTONA_API_KEY: fake, TOUCHSTONE_EXEC: "daytona" }, () => {
    const s = getSettings();
    assert.ok(!JSON.stringify(s).includes(fake), "the key must not leave the server");
    assert.equal(s.execution.backend, "daytona");
    assert.equal(s.execution.envOverride, "daytona");
    if (s.execution.key.source === "env") {
      assert.equal(s.execution.key.last4, "9z8y");
    }
    assert.equal(s.execution.key.set, true);
  });
});

test("a saved Daytona configuration cannot leak into the default-local case", () => {
  withEnv({ DAYTONA_API_KEY: undefined, TOUCHSTONE_EXEC: undefined }, () => {
    try {
      store = { execution: { backend: "daytona", apiKey: "dtn_fixture_key_9z8y" } };
      assert.equal(getSettings().execution.backend, "daytona");
    } finally {
      store = {};
    }
    const s = getSettings();
    assert.equal(s.execution.backend, "local");
    assert.equal(s.execution.saved, "local");
    assert.equal(s.execution.key.set, false);
    assert.equal(typeof s.execution.target, "string");
  });
});

test("setExecution rejects a bad backend and Daytona with no key, before any write", () => {
  withEnv({ DAYTONA_API_KEY: undefined, TOUCHSTONE_EXEC: undefined }, () => {
    assert.throws(() => setExecution({ backend: "cloud" }), /backend must be/);
    assert.throws(() => setExecution({ backend: "local", target: "us west; rm" }), /bad characters/);
    assert.throws(() => setExecution({ backend: "daytona" }), /needs an API key/);
  });
});

test("the saved provider config follows TOUCHSTONE_PROVIDERS_FILE, and defaults to spike/data", () => {
  const file = join(TEST_STORE_DIR, "providers.json");
  assert.equal(process.env.TOUCHSTONE_PROVIDERS_FILE, file);
  assert.equal(realProviders.providersFile(), file);
  realProviders.writeConfig({ default: null, capUsd: 7, providers: {}, execution: { backend: "local" } });
  assert.equal(realProviders.readConfig().capUsd, 7);
  assert.equal(realProviders.readConfig().execution.backend, "local");
  // Unset, the path is the one the app has always used. Not read here.
  withEnv({ TOUCHSTONE_PROVIDERS_FILE: undefined }, () => {
    assert.equal(realProviders.providersFile(), fileURLToPath(new URL("../data/providers.json", import.meta.url)));
  });
});

// B: the guard fails closed. One DENY test per reason, and one ALLOW test.
const HOST = "127.0.0.1:5173";
const good = { host: HOST, origin: `http://${HOST}`, "content-type": "application/json", "x-touchstone-grant-token": TOKEN };
const req = (method, headers) => ({ method, headers });
const without = (k) => Object.fromEntries(Object.entries(good).filter(([key]) => key !== k));

test("B: settings write with no Origin is refused", () => {
  assert.equal(settingsWriteRefusal(req("POST", without("origin")))?.status, 403);
  assert.equal(settingsWriteRefusal(req("DELETE", without("origin")))?.status, 403);
  assert.equal(settingsWriteAllowed(req("POST", without("origin"))), false);
});

test("B: settings write from a foreign Origin is refused", () => {
  for (const origin of ["https://evil.example", "http://127.0.0.1:3000", "http://localhost:5173", "null", "not a url"]) {
    assert.equal(settingsWriteRefusal(req("POST", { ...good, origin }))?.status, 403, origin);
  }
  // X-Forwarded-Host is not trusted: any client can set it.
  assert.equal(settingsWriteRefusal(req("POST", { ...good, origin: "https://x.getbb.app", "x-forwarded-host": "x.getbb.app" }))?.status, 403);
  assert.equal(settingsWriteRefusal(req("POST", without("host")))?.status, 403);
});

test("B: settings POST that is not application/json is refused", () => {
  for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", undefined]) {
    const h = ct === undefined ? without("content-type") : { ...good, "content-type": ct };
    assert.equal(settingsWriteRefusal(req("POST", h))?.status, 415, String(ct));
  }
});

test("B: settings write with a missing or wrong token is refused", () => {
  assert.equal(settingsWriteRefusal(req("POST", without("x-touchstone-grant-token")))?.status, 403);
  assert.equal(settingsWriteRefusal(req("POST", { ...good, "x-touchstone-grant-token": "guess" }))?.status, 403);
  assert.equal(settingsWriteRefusal(req("DELETE", { host: HOST, origin: `http://${HOST}` }))?.status, 403);
});

test("B: a same-origin JSON write with the token is allowed", () => {
  assert.equal(settingsWriteRefusal(req("POST", good)), null);
  assert.equal(settingsWriteAllowed(req("POST", good)), true);
  // A DELETE has no body, so it needs no content-type.
  assert.equal(settingsWriteAllowed(req("DELETE", without("content-type"))), true);
  // Through a bb connect share, the browser's Host and Origin agree.
  assert.equal(settingsWriteAllowed(req("POST", { ...good, host: "x.getbb.app", origin: "https://x.getbb.app" })), true);
});

function fakeRes() {
  return { statusCode: 0, headers: {}, body: "", setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
}

test("B: handleSettings refuses each bad write before it reaches Settings", async () => {
  const { handleSettings } = await import("../../app/server/runs-http.mjs");
  const cases = [
    [without("origin"), 403],
    [{ ...good, origin: "https://evil.example" }, 403],
    [{ ...good, "content-type": "text/plain" }, 415],
    [without("x-touchstone-grant-token"), 403],
  ];
  for (const url of ["/api/settings/execution", "/api/settings/providers"]) {
    for (const [headers, status] of cases) {
      const res = fakeRes();
      assert.equal(await handleSettings({ method: "POST", url, headers }, res), true);
      assert.equal(res.statusCode, status, `${url} ${JSON.stringify(headers)}`);
    }
  }
});

test("B: handleSettings lets a good write through to Settings", async () => {
  const { handleSettings } = await import("../../app/server/runs-http.mjs");
  // A good request with a bad body: the guard passes, and setExecution then
  // refuses it with 400. So nothing is written.
  const body = JSON.stringify({ backend: "cloud" });
  const r = Object.assign(Readable.from([Buffer.from(body)]), { method: "POST", url: "/api/settings/execution", headers: good });
  const res = fakeRes();
  assert.equal(await handleSettings(r, res), true);
  assert.equal(res.statusCode, 400, res.body);
  assert.match(res.body, /backend must be/);
});
