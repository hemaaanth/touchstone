// E2: the Daytona server URL and region (target) settings, and the saved key
// that goes only to the host it was saved for.
// Settings are read and written in memory here, so the saved file never changes.
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
const { DEFAULT_API_URL, DEFAULT_TARGET, closeRun, daytonaOn, execConfig } = await import("../lib/daytona.mjs");
const { getSettings, saveProvider, setExecution } = await import("../../app/server/settings.mjs");

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

// Run fn with these env vars (undefined deletes one), then put them back. An
// async fn gets them back when its promise settles.
function withEnv(vars, fn) {
  const keep = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const restore = () => {
    for (const [k, v] of Object.entries(keep)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  let r;
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    r = fn();
  } catch (e) {
    restore();
    throw e;
  }
  if (r && typeof r.then === "function") return r.finally(restore);
  restore();
  return r;
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

test("DAYTONA_API_KEY goes only to DAYTONA_API_URL, else the default server, with a reason", () => {
  withEnv({ ...NO_ENV, DAYTONA_API_KEY: KEY }, () => {
    store = { execution: { backend: "local", apiUrl: "https://evil.example/api" } };
    const c = execConfig();
    assert.equal(c.apiKey, "", "the env key must not follow a Settings URL");
    assert.equal(c.keyHeld, "The key from DAYTONA_API_KEY is only sent to app.daytona.io, not evil.example.");
    const s = getSettings();
    assert.equal(s.execution.key.set, false);
    assert.equal(s.execution.key.held, c.keyHeld);
    assert.ok(!JSON.stringify(s).includes(KEY), "the key must not leave the server");
    store = {};
    assert.equal(execConfig().apiKey, KEY, "the default server gets the env key");
  });
  withEnv({ ...NO_ENV, DAYTONA_API_KEY: KEY, DAYTONA_API_URL: "https://env.example/api" }, () => {
    store = { execution: { apiUrl: "https://saved.example/api" } };
    assert.equal(execConfig().apiKey, KEY, "DAYTONA_API_URL gets the env key");
  });
});

test("an env server URL that is not https, or has a user name, query or #part, gets no key", () => {
  for (const url of ["http://app.daytona.io/api", "https://u:p@app.daytona.io/api", "https://app.daytona.io/api?x=1", "https://app.daytona.io/api#x"]) {
    withEnv({ ...NO_ENV, DAYTONA_API_KEY: NEW_KEY, DAYTONA_API_URL: url }, () => {
      store = { execution: { backend: "local", apiKey: KEY, keyHost: "app.daytona.io" } };
      const c = execConfig();
      assert.equal(c.apiKey, "", url);
      assert.match(c.keyHeld, /must be https, with no user name, query or #part/, url);
      assert.ok(!c.keyHeld.includes("u:p"), "the reason never shows a user name or password");
      assert.equal(getSettings().execution.key.set, false, url);
    });
  }
});

test("the REST client calls the configured server, with the key bound to it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daytona-config-"));
  const realFetch = globalThis.fetch;
  const calls = [];
  try {
    await withEnv({ ...NO_ENV, DAYTONA_PENDING: join(dir, "pending.json") }, async () => {
      writeFileSync(join(dir, "pending.json"), JSON.stringify(["sb-test-1"]));
      store = { execution: { backend: "local", apiUrl: "https://saved.example/api", apiKey: KEY, keyHost: "saved.example" } };
      globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), method: init.method, auth: init.headers.Authorization });
        return new Response("", { status: 404 });
      };
      await closeRun(join(dir, "ws"));
    });
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(calls, [{ url: "https://saved.example/api/sandbox/sb-test-1", method: "DELETE", auth: `Bearer ${KEY}` }]);
});

test("a new key is bound to DAYTONA_API_URL's host while it is set", () => {
  withEnv({ ...NO_ENV, DAYTONA_API_URL: "https://env.example/api" }, () => {
    store = { execution: { backend: "local", apiUrl: "https://saved.example/api" } };
    setExecution({ backend: "local", apiKey: NEW_KEY });
    assert.equal(store.execution.keyHost, "env.example");
    assert.equal(execConfig().apiKey, NEW_KEY, "the key is used right after the save");
  });
});

test("a kept key keeps the host it is bound to", () => {
  withEnv({ ...NO_ENV, DAYTONA_API_URL: "https://env.example/api" }, () => {
    store = { execution: { backend: "local", apiKey: KEY, keyHost: "env.example" } };
    setExecution({ backend: "local", target: "eu-1" });
    assert.equal(store.execution.keyHost, "env.example");
    assert.equal(execConfig().apiKey, KEY);
  });
});

test("a held saved key is marked saved, so it can be removed", () => {
  withEnv({ ...NO_ENV, DAYTONA_API_URL: "https://elsewhere.example/api" }, () => {
    store = { execution: { backend: "local", apiKey: KEY, keyHost: "app.daytona.io" } };
    const held = getSettings().execution.key;
    assert.equal(held.set, false);
    assert.equal(held.saved, true);
    const res = setExecution({ backend: "local", clearKey: true });
    assert.equal(store.execution.apiKey, undefined);
    assert.equal(res.execution.key.saved, false);
  });
});

// L22: GET /api/settings needs no console token, so no URL in it may carry a
// user name, password, query or #part.
const gw = (baseUrl) => ({ providers: { gw: { id: "gw", label: "GW", baseUrl, models: { m: { id: "m", input: 1, output: 1 } } } } });
const gwOf = (s) => s.providers.find((p) => p.id === "gw");

test("settings never return a user name, password, query or #part of a URL", () => {
  const cases = [
    ["https://user:pass@x.example/api?x=1#y", "https://x.example/api"],
    ["https://user:pass@x.example/api", "https://x.example/api"],
    ["https://x.example/api?x=1", "https://x.example/api"],
    ["https://x.example/api#y", "https://x.example/api"],
    ["https://user@x.example:8443/api/", "https://x.example:8443/api"],
  ];
  for (const [raw, shown] of cases) {
    withEnv({ ...NO_ENV, DAYTONA_API_URL: raw }, () => {
      store = gw(raw);
      const s = getSettings();
      assert.equal(s.execution.apiUrl, shown, raw);
      assert.equal(s.execution.apiUrlHidden, true, raw);
      assert.equal(gwOf(s).baseUrl, shown, raw);
      assert.equal(gwOf(s).baseUrlHidden, true, raw);
      const body = JSON.stringify(s);
      for (const bit of ["user", "pass", "x=1", "#y"]) assert.ok(!body.includes(bit), `${bit} leaked for ${raw}`);
    });
  }
});

test("a plain URL comes back unchanged", () => {
  withEnv({ ...NO_ENV, DAYTONA_API_URL: "https://env.example/api" }, () => {
    store = gw("https://gw.example/v1");
    const s = getSettings();
    assert.equal(s.execution.apiUrl, "https://env.example/api");
    assert.equal(s.execution.apiUrlHidden, false);
    assert.equal(gwOf(s).baseUrl, "https://gw.example/v1");
    assert.equal(gwOf(s).baseUrlHidden, false);
  });
});

test("saving a provider with its shown URL keeps the hidden parts; a new URL replaces them", () => {
  withEnv(NO_ENV, () => {
    store = gw("https://user:pass@gw.example/v1?x=1");
    const res = saveProvider({ id: "gw", label: "GW", baseUrl: "https://gw.example/v1" });
    assert.equal(store.providers.gw.baseUrl, "https://user:pass@gw.example/v1?x=1");
    assert.ok(!JSON.stringify(res).includes("pass"), "the response is cut too");
    saveProvider({ id: "gw", label: "GW", baseUrl: "https://gw.example/v2" });
    assert.equal(store.providers.gw.baseUrl, "https://gw.example/v2");
  });
});

test("the saved flag while a key is in use", () => {
  withEnv(NO_ENV, () => {
    store = { execution: { backend: "local", apiKey: KEY } };
    const k = getSettings().execution.key;
    assert.deepEqual([k.set, k.source, k.saved], [true, "settings", true]);
  });
  withEnv({ ...NO_ENV, DAYTONA_API_KEY: NEW_KEY }, () => {
    store = {};
    const k = getSettings().execution.key;
    assert.deepEqual([k.set, k.source, k.saved], [true, "env", false]);
  });
});

test("a saved key on another host, an env key, and the URL back to the default: savable", () => {
  withEnv({ ...NO_ENV, DAYTONA_API_KEY: NEW_KEY }, () => {
    store = { execution: { backend: "daytona", apiUrl: "https://a.example/api", apiKey: KEY, keyHost: "a.example" } };
    const before = getSettings().execution;
    assert.equal(before.envKeyHost, "app.daytona.io", "the page learns where the env key goes");
    assert.equal(before.key.source, "settings");
    const res = setExecution({ backend: "daytona", apiUrl: "" });
    assert.equal(store.execution.apiKey, undefined, "the saved key for a.example is dropped");
    assert.equal(store.execution.apiUrl, undefined);
    const c = execConfig();
    assert.deepEqual([c.apiKey, c.keySource, c.backend], [NEW_KEY, "env", "daytona"]);
    assert.ok(!JSON.stringify(res).includes(NEW_KEY) && !JSON.stringify(res).includes(KEY), "no key in the response");
  });
});
