// E2: the Daytona server URL and region (target) settings, and the saved key
// that goes only to the host it was saved for.
// Settings are read and written in memory here, so the saved file never changes.
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

const TOKEN = "e2-test-token";
process.env.TOUCHSTONE_GRANT_TOKEN = TOKEN;
const providersUrl = new URL("../lib/providers.mjs", import.meta.url).href;
const realProviders = await import(providersUrl);
let store = {};
const readConfig = () => structuredClone({ default: null, capUsd: null, providers: {}, ...store });
const writeConfig = (cfg) => {
  store = structuredClone(cfg);
};
mock.module(providersUrl, { exports: { ...realProviders, readConfig, writeConfig } });
const { DEFAULT_API_URL, DEFAULT_TARGET, daytonaOn, execConfig } = await import("../lib/daytona.mjs");
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

// Run fn with these env vars (undefined deletes one), then put them back.
function withEnv(vars, fn) {
  const keep = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(keep)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
const NO_ENV = { DAYTONA_API_KEY: undefined, DAYTONA_API_URL: undefined, DAYTONA_TARGET: undefined, TOUCHSTONE_EXEC: undefined };
const KEY = "dtn_saved_key_value_9z9z";
const NEW_KEY = "dtn_new_key_value_7y7y";

test("a new server host drops the saved key, and the key is never in a response", () => {
  withEnv(NO_ENV, () => {
    for (const apiUrl of ["https://other.example/api", "https://app.daytona.io:8443/api"]) {
      store = { execution: { backend: "local", apiKey: KEY } };
      const res = setExecution({ backend: "local", apiUrl });
      assert.equal(store.execution.apiKey, undefined, apiUrl);
      assert.equal(res.execution.key.set, false, apiUrl);
      assert.ok(!JSON.stringify(res).includes(KEY), "the key must not leave the server");
    }
  });
});

test("a new server host with a new key keeps the new key, bound to that host", () => {
  withEnv(NO_ENV, () => {
    store = { execution: { backend: "local", apiKey: KEY } };
    const res = setExecution({ backend: "local", apiUrl: "https://other.example/api", apiKey: NEW_KEY });
    assert.equal(store.execution.apiKey, NEW_KEY);
    assert.equal(store.execution.keyHost, "other.example");
    assert.equal(res.execution.key.set, true);
    assert.equal(res.execution.key.last4, "7y7y");
    assert.ok(!JSON.stringify(res).includes(NEW_KEY), "the key must not leave the server");
  });
});

test("a new path, case or default port on the same host keeps the saved key", () => {
  withEnv(NO_ENV, () => {
    for (const apiUrl of ["https://app.daytona.io/v2/api", "https://APP.Daytona.io:443/api"]) {
      store = { execution: { backend: "local", apiKey: KEY, apiUrl: "https://app.daytona.io/api" } };
      const res = setExecution({ backend: "local", apiUrl });
      assert.equal(store.execution.apiKey, KEY, apiUrl);
      assert.equal(res.execution.key.set, true, apiUrl);
      assert.ok(!JSON.stringify(res).includes(KEY), "the key must not leave the server");
    }
  });
});

test("a server URL from the env on another host gets no saved key, with a reason", () => {
  withEnv({ ...NO_ENV, DAYTONA_API_URL: "https://elsewhere.example/api", TOUCHSTONE_EXEC: "daytona" }, () => {
    store = { execution: { backend: "daytona", apiKey: KEY, keyHost: "app.daytona.io" } };
    const c = execConfig();
    assert.equal(c.apiKey, "");
    assert.match(c.keyHeld, /saved key is for app\.daytona\.io, not elsewhere\.example/);
    assert.equal(daytonaOn(), false, "no key means local Docker");
    const s = getSettings();
    assert.equal(s.execution.key.set, false);
    assert.match(s.execution.key.held, /Enter the key again/);
    assert.ok(!JSON.stringify(s).includes(KEY), "the key must not leave the server");
  });
  withEnv({ ...NO_ENV, DAYTONA_API_URL: "https://app.daytona.io/other" }, () => {
    store = { execution: { backend: "local", apiKey: KEY, keyHost: "app.daytona.io" } };
    assert.equal(execConfig().apiKey, KEY, "the same host keeps the key");
  });
});
