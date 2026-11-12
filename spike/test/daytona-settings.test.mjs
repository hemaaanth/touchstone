// Settings for the execution backend (app/server/settings.mjs). These tests
// only read Settings, or fail before a write, so the saved file never changes.
import { test } from "node:test";
import assert from "node:assert/strict";

const { getSettings, setExecution, settingsWriteAllowed } = await import("../../app/server/settings.mjs");

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

test("getSettings defaults to local Docker", () => {
  withEnv({ DAYTONA_API_KEY: undefined, TOUCHSTONE_EXEC: undefined }, () => {
    const s = getSettings();
    if (!s.execution.key.set) assert.equal(s.execution.backend, "local");
    assert.equal(typeof s.execution.target, "string");
  });
});

test("setExecution rejects a bad backend and Daytona with no key, before any write", () => {
  withEnv({ DAYTONA_API_KEY: undefined, TOUCHSTONE_EXEC: undefined }, () => {
    assert.throws(() => setExecution({ backend: "cloud" }), /backend must be/);
    assert.throws(() => setExecution({ backend: "local", target: "us west; rm" }), /bad characters/);
    if (!getSettings().execution.key.set) assert.throws(() => setExecution({ backend: "daytona" }), /needs an API key/);
  });
});

test("settingsWriteAllowed refuses a cross-site write", () => {
  const req = (method, headers) => ({ method, headers });
  const json = { "content-type": "application/json", host: "127.0.0.1:5173" };
  // The console itself, locally and through a bb connect share.
  assert.equal(settingsWriteAllowed(req("POST", { ...json, origin: "http://127.0.0.1:5173", "sec-fetch-site": "same-origin" })), true);
  assert.equal(settingsWriteAllowed(req("POST", { ...json, host: "x.getbb.app", origin: "https://x.getbb.app" })), true);
  assert.equal(settingsWriteAllowed(req("POST", { ...json, "x-forwarded-host": "x.getbb.app", origin: "https://x.getbb.app" })), true);
  assert.equal(settingsWriteAllowed(req("POST", json)), true); // curl: no Origin
  // A drive-by page: text/plain, a foreign Origin, or a cross-site fetch.
  assert.equal(settingsWriteAllowed(req("POST", { host: json.host, "content-type": "text/plain", origin: "http://127.0.0.1:5173" })), false);
  assert.equal(settingsWriteAllowed(req("POST", { host: json.host })), false);
  assert.equal(settingsWriteAllowed(req("POST", { ...json, origin: "https://evil.example" })), false);
  assert.equal(settingsWriteAllowed(req("POST", { ...json, origin: "null" })), false);
  assert.equal(settingsWriteAllowed(req("DELETE", { host: json.host, origin: "https://evil.example" })), false);
  assert.equal(settingsWriteAllowed(req("DELETE", { host: json.host, "sec-fetch-site": "cross-site" })), false);
  assert.equal(settingsWriteAllowed(req("DELETE", { host: json.host, origin: "http://127.0.0.1:5173" })), true);
});

test("handleSettings answers 403 to a cross-site execution POST", async () => {
  const { handleSettings } = await import("../../app/server/runs-http.mjs");
  const res = { statusCode: 0, headers: {}, body: "", setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
  const req = { method: "POST", url: "/api/settings/execution", headers: { host: "127.0.0.1:5173", "content-type": "text/plain", origin: "https://evil.example" } };
  assert.equal(await handleSettings(req, res), true);
  assert.equal(res.statusCode, 403);
  const prov = { ...req, url: "/api/settings/providers" };
  const res2 = { ...res, statusCode: 0 };
  assert.equal(await handleSettings(prov, res2), true);
  assert.equal(res2.statusCode, 403);
});
