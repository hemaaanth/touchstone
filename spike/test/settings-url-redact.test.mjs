// L22 repair: no text from a provider or Daytona call holds a hidden part of
// a configured URL (user name, password, query, #part), and Fetch models
// sends a provider's key only to that provider's saved base URL.
// Settings are read and written in memory, and fetch is mocked where a request
// could leave the machine. A URL with a user name makes Node's fetch throw
// before any request, so those tests use the real fetch.
import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "settings-url-redact-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const TOKEN = "l22-test-token";
process.env.TOUCHSTONE_GRANT_TOKEN = TOKEN;
// Set before the first import: inference.mjs reads these at load.
process.env.SPEND_LEDGER = join(dir, "spend.json");
process.env.RUN_BUDGET_USD = "1000";
process.env.SPEND_CAP_USD = "1000";

const providersUrl = new URL("../lib/providers.mjs", import.meta.url).href;
const realProviders = await import(providersUrl);
let store = {};
const readConfig = () => structuredClone({ default: null, capUsd: null, providers: {}, ...store });
const writeConfig = (cfg) => {
  store = structuredClone(cfg);
};
// allProviders() with no argument reads the config inside providers.mjs, so
// it gets the in-memory one too.
const allProviders = (cfg = readConfig()) => realProviders.allProviders(cfg);
mock.module(providersUrl, { exports: { ...realProviders, readConfig, writeConfig, allProviders } });
const { publicUrl, scrubError, scrubUrl } = await import("../lib/redact-url.mjs");
const { discoverModels, saveProvider } = await import("../../app/server/settings.mjs");
const { handleSettings } = await import("../../app/server/runs-http.mjs");
const { budgetedApi } = await import("../lib/provider.mjs");

const SECRET_URL = "https://usr:pw123@host.example/v1?tok=x";
const SHOWN = "https://host.example/v1";
const SECRETS = ["usr", "pw123", "tok=x"];
const SAVED_KEY = "sk-fake-saved-key-0001";
const TYPED_KEY = "sk-fake-typed-key-0002";
const noSecret = (text, label) => {
  for (const s of SECRETS) assert.ok(!String(text).includes(s), `${label}: "${s}" leaked in: ${text}`);
};

// A fetch stub for one test: records each call, answers with `answer(url)`.
async function withFetch(answer, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), auth: init.headers?.authorization ?? init.headers?.Authorization });
    return answer(String(url));
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}
const modelsOk = () => new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 });

// The guarded settings route, as the page calls it.
async function post(path, body) {
  const HOST = "127.0.0.1:5173";
  const headers = { host: HOST, origin: `http://${HOST}`, "content-type": "application/json", "x-touchstone-grant-token": TOKEN };
  const r = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", url: path, headers });
  const res = { statusCode: 0, headers: {}, body: "", setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
  assert.equal(await handleSettings(r, res), true);
  return res;
}

test("publicUrl shows nothing for a scheme that is not http or https", () => {
  for (const raw of ["foo:u:pw123@h", "mailto:pw123@h?x", "ftp://u:pw123@h/x"]) {
    assert.deepEqual(publicUrl(raw), { url: "", cut: true }, raw);
  }
  assert.deepEqual(publicUrl(SECRET_URL), { url: SHOWN, cut: true });
  assert.deepEqual(publicUrl("https://host.example/v1"), { url: "https://host.example/v1", cut: false });
});

test("Fetch models by the cut URL or by the id only: the 400 text holds no hidden part", async () => {
  store = {};
  saveProvider({ label: "GW", baseUrl: SECRET_URL, apiKey: SAVED_KEY, models: [{ id: "m1", input: "", output: "", context: null }] });
  assert.equal(store.providers.gw.baseUrl, SECRET_URL, "the stored URL keeps its parts");
  // The real fetch refuses a URL with a user name, and names it in its error.
  for (const body of [{ id: "gw", baseUrl: SHOWN }, { id: "gw" }]) {
    await assert.rejects(discoverModels(body), (err) => {
      assert.match(err.message, /could not reach https:\/\/host\.example\/v1\/models/);
      noSecret(err.message, JSON.stringify(body));
      noSecret(err.stack, "stack");
      return true;
    });
    const res = await post("/api/settings/discover", body);
    assert.equal(res.statusCode, 400, res.body);
    noSecret(res.body, `route ${JSON.stringify(body)}`);
  }
});

test("a URL echoed in a fetch cause or a response body is scrubbed", async () => {
  store = {};
  saveProvider({ label: "GQ", baseUrl: "https://host.example/v1?tok=x", apiKey: SAVED_KEY, models: [{ id: "m1", input: "", output: "", context: null }] });
  await withFetch(
    (url) => {
      throw new TypeError("fetch failed", { cause: new Error(`getaddrinfo ENOTFOUND for ${url}`) });
    },
    async () => {
      await assert.rejects(discoverModels({ id: "gq", baseUrl: SHOWN }), (err) => {
        assert.match(err.message, /getaddrinfo ENOTFOUND/, "the cause is kept, scrubbed");
        noSecret(err.message, "cause");
        return true;
      });
    },
  );
  await withFetch(
    () => new Response("Cannot GET /v1?tok=x/models", { status: 404 }),
    async () => {
      await assert.rejects(discoverModels({ id: "gq" }), (err) => {
        assert.match(err.message, /returned 404/);
        noSecret(err.message, "echoed body");
        return true;
      });
    },
  );
});

test("Fetch models: the saved key and another host send no Authorization, and say why", async () => {
  store = {};
  saveProvider({ label: "GK", baseUrl: "https://gw.example/v1", apiKey: SAVED_KEY, models: [{ id: "m1", input: "", output: "", context: null }] });
  await withFetch(modelsOk, async (calls) => {
    const r = await discoverModels({ id: "gk", baseUrl: "https://evil.example/v1" });
    assert.equal(calls[0].url, "https://evil.example/v1/models");
    assert.equal(calls[0].auth, undefined, "no key to another host");
    assert.equal(r.keyUsed, false);
    assert.equal(r.keyNote, "The provider's key was not sent: it goes only to https://gw.example.");
  });
  for (const other of ["https://gw.example:8443/v1", "http://gw.example/v1"]) {
    await withFetch(modelsOk, async (calls) => {
      await discoverModels({ id: "gk", baseUrl: other });
      assert.equal(calls[0].auth, undefined, `${other}: another port or scheme is another origin`);
    });
  }
  // With no key, a gateway answers 401: the error says why no key went.
  await withFetch(
    () => new Response("unauthorized", { status: 401 }),
    async () => {
      await assert.rejects(discoverModels({ id: "gk", baseUrl: "https://evil.example/v1" }), /returned 401.*The provider's key was not sent/);
    },
  );
});

test("Fetch models: the saved key and the saved URL send the saved key", async () => {
  store = {};
  saveProvider({ label: "GK", baseUrl: "https://gw.example/v1", apiKey: SAVED_KEY, models: [{ id: "m1", input: "", output: "", context: null }] });
  for (const body of [{ id: "gk" }, { id: "gk", baseUrl: "https://gw.example/v1" }, { id: "gk", baseUrl: "https://GW.example/v2" }]) {
    await withFetch(modelsOk, async (calls) => {
      const r = await discoverModels(body);
      assert.equal(calls[0].auth, `Bearer ${SAVED_KEY}`, JSON.stringify(body));
      assert.equal(r.keyUsed, true);
      assert.equal(r.keyNote, null);
    });
  }
});

test("Fetch models: a typed key and another host send the typed key only", async () => {
  store = {};
  saveProvider({ label: "GK", baseUrl: "https://gw.example/v1", apiKey: SAVED_KEY, models: [{ id: "m1", input: "", output: "", context: null }] });
  await withFetch(modelsOk, async (calls) => {
    const r = await discoverModels({ id: "gk", baseUrl: "https://other.example/v1", apiKey: TYPED_KEY });
    assert.deepEqual(calls.map((c) => c.auth), [`Bearer ${TYPED_KEY}`]);
    assert.equal(r.keyNote, null);
  });
});

test("an agent's model error text holds no hidden part of the base URL", async () => {
  const model = { id: "m1", api: "openai-completions", provider: "gw", baseUrl: SECRET_URL };
  const raw = `Request cannot be constructed from a URL that includes credentials: ${SECRET_URL}/chat/completions`;
  const errorEvent = {
    type: "error",
    reason: "error",
    error: { role: "assistant", content: [], stopReason: "error", errorMessage: raw, usage: { input: 0, output: 0 }, timestamp: 0 },
  };
  const yields = { stream: () => (async function* () { yield errorEvent; })() };
  const throws = {
    stream: () => {
      throw new TypeError(raw);
    },
  };
  for (const [label, api] of [["error event", yields], ["thrown error", throws]]) {
    const seen = [];
    for await (const e of budgetedApi(api).stream(model, { messages: [] }, {})) seen.push(e);
    const err = seen.find((e) => e.type === "error");
    assert.ok(err, label);
    assert.match(err.error.errorMessage, /https:\/\/host\.example\/v1\/chat\/completions/, label);
    noSecret(err.error.errorMessage, label);
  }
});

test("scrubError cleans message, stack and cause, and keeps the error's fields", () => {
  const err = new TypeError(`fetch failed for ${SECRET_URL}/sandbox`, { cause: new Error(`connect ${SECRET_URL}`) });
  err.status = 503;
  const out = scrubError(err, SECRET_URL);
  assert.equal(out, err);
  assert.equal(out.name, "TypeError");
  assert.equal(out.status, 503);
  noSecret(out.message, "message");
  noSecret(out.stack, "stack");
  noSecret(out.cause.message, "cause");
  assert.equal(scrubUrl("plain text, no URL", SECRET_URL), "plain text, no URL");
});
