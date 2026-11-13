// E2: the Daytona server URL and region (target) settings.
// These tests only read config, or fail before a write, so the saved file
// never changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

const TOKEN = "e2-test-token";
process.env.TOUCHSTONE_GRANT_TOKEN = TOKEN;
const { DEFAULT_API_URL, DEFAULT_TARGET, execConfig } = await import("../lib/daytona.mjs");
const { getSettings, setExecution } = await import("../../app/server/settings.mjs");

test("execConfig: server URL and region come from env, then Settings, then the default", () => {
  const saved = { execution: { apiUrl: "https://saved.example/api/", target: "eu-1" } };
  const env = { DAYTONA_API_URL: "https://env.example/api", DAYTONA_TARGET: "us-2" };

  const e = execConfig(env, saved);
  assert.equal(e.apiUrl, "https://env.example/api");
  assert.equal(e.target, "us-2");

  const s = execConfig({}, saved);
  assert.equal(s.apiUrl, "https://saved.example/api", "a trailing slash is removed");
  assert.equal(s.target, "eu-1");

  const d = execConfig({}, {});
  assert.equal(d.apiUrl, DEFAULT_API_URL);
  assert.equal(d.apiUrl, "https://app.daytona.io/api");
  assert.equal(d.target, DEFAULT_TARGET);
});

test("setExecution refuses a bad Daytona server URL, before any write", () => {
  const cases = [
    ["not a url", /not a valid URL/],
    ["app.daytona.io/api", /not a valid URL/],
    ["http://app.daytona.io/api", /must start with https:\/\//],
    ["ftp://app.daytona.io/api", /must start with https:\/\//],
    ["https://user:pw@app.daytona.io/api", /no user name/],
    ["https://app.daytona.io/api?x=1", /no user name, password, query/],
  ];
  for (const [apiUrl, err] of cases) {
    assert.throws(() => setExecution({ backend: "local", apiUrl }), err, apiUrl);
  }
});

test("getSettings shows the server URL and its default, and never the key", () => {
  const fake = "dtn_e2_key_value_4q4q";
  const keep = { ...process.env };
  try {
    process.env.DAYTONA_API_KEY = fake;
    process.env.DAYTONA_API_URL = "https://env.example/api";
    delete process.env.DAYTONA_TARGET;
    const s = getSettings().execution;
    assert.ok(!JSON.stringify(getSettings()).includes(fake), "the key must not leave the server");
    assert.equal(s.apiUrl, "https://env.example/api");
    assert.equal(s.envNames.apiUrl, "DAYTONA_API_URL");
    assert.equal(s.envNames.target, null);
    assert.equal(s.defaults.apiUrl, DEFAULT_API_URL);
    assert.equal(s.defaults.target, DEFAULT_TARGET);
  } finally {
    for (const k of ["DAYTONA_API_KEY", "DAYTONA_API_URL", "DAYTONA_TARGET"]) {
      if (keep[k] === undefined) delete process.env[k];
      else process.env[k] = keep[k];
    }
  }
});

test("a bad server URL through the guarded settings write gets 400 with the message", async () => {
  const { handleSettings } = await import("../../app/server/runs-http.mjs");
  const HOST = "127.0.0.1:5173";
  const headers = { host: HOST, origin: `http://${HOST}`, "content-type": "application/json", "x-touchstone-grant-token": TOKEN };
  const body = JSON.stringify({ backend: "local", apiUrl: "http://app.daytona.io/api" });
  const r = Object.assign(Readable.from([Buffer.from(body)]), { method: "POST", url: "/api/settings/execution", headers });
  const res = { statusCode: 0, headers: {}, body: "", setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
  assert.equal(await handleSettings(r, res), true);
  assert.equal(res.statusCode, 400, res.body);
  assert.match(res.body, /must start with https:\/\//);
});
