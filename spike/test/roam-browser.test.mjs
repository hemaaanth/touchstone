// No install, network, Daytona or Chromium. Playwright is a fake; IPC uses a
// private Unix socket. Package hooks stand in for absent integration imports.
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withAgent } from "../lib/event.mjs";
import { createBrowserDriver, serveBrowser, requestBrowser, SESSION_DIR, DRIVER_PATH, RESPONSE_BYTES } from "../roam/browser-driver.mjs";

const stub = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "@earendil-works/pi-durable") return { url: stub("export const defineTool=x=>x"), shortCircuit: true };
  if (specifier === "@earendil-works/pi-schema") return { url: stub("export const obj=x=>x, oneOf=x=>x, opt=x=>x, str=()=>({type:'string'})"), shortCircuit: true };
  if (specifier === "./daytona.mjs" && context.parentURL.endsWith("/roam-browser.mjs")) return { url: stub("export async function roamMachine(){throw Error('default machine called')}"), shortCircuit: true };
  return next(specifier, context);
} });
const { roamBrowserTools, remoteBrowserRequest, pauseRoamBrowser, resumeRoamBrowser, roamBrowserStatus, captureRoamBrowser, closeRoamBrowser } = await import("../lib/roam-browser.mjs");
hooks.deregister();

const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise((r) => setImmediate(r));
const as = (tool, request, agent = "a-1") => withAgent(agent, () => tool.execute(request));
const text = (result) => result.output[0].text;
let ids = 0;
function hostFakes(options = {}) {
  const steps = [], entries = [], calls = [], uploads = new Map();
  const m = {
    id: `fake-${++ids}`, fresh: false, replaced: options.replaced ?? false,
    upload: async (path, bytes) => { steps.push(path === DRIVER_PATH ? "driver" : "payload"); uploads.set(path, Buffer.from(bytes)); },
    exec: async (command, seconds) => {
      calls.push({ command, seconds });
      if (command.includes("nohup")) { steps.push("start-driver"); return { exitCode: options.startCode ?? 0, result: "" }; }
      steps.push("action");
      const path = command.match(/\/var\/lib\/touchstone\/session\/request-[a-f0-9]+\.json/)[0];
      const request = JSON.parse(uploads.get(path));
      if (options.exec) return options.exec(request);
      return { exitCode: 0, result: JSON.stringify(options.reply ?? { ok: true, title: "title", url: "https://example.test/?token=raw-secret", text: "raw-secret", status: 200 }) };
    },
  };
  const f = { m, steps, entries, calls, uploads,
    machine: async (ws, agent) => { steps.push(`machine:${agent}`); return m; },
    record: (entry) => { entries.push(entry); steps.push(`record:${entry.kind}`); return { poc: `session:${entry.agent}:1`, output: "scrubbed text" }; },
    egress: { start: async () => { steps.push("egress-start"); if (options.logFail) throw Error("raw-secret"); }, pull: async () => { steps.push("egress-pull"); if (options.pullFail) throw Error("raw-secret"); return [{ t: 1, method: "GET", url: "https://example.test/", status: 200 }]; } },
  };
  f.tool = roamBrowserTools("/fake/run", f)[0];
  return f;
}

function engine(directory, options = {}) {
  const calls = [];
  let contextOptions, pageCount = 0, url = "about:blank";
  const page = {
    goto: async (value) => { calls.push(["open", value]); url = value; if (options.block) await options.block.promise; return { status: () => 201 }; },
    locator: (selector) => ({ click: async () => { calls.push(["click", selector]); }, fill: async (value) => { calls.push(["type", selector, value]); } }),
    url: () => url,
    screenshot: async ({ path, fullPage }) => { calls.push(["screenshot", fullPage]); writeFileSync(path, "fake-png"); },
    evaluate: async (fn) => {
      // Run the actual page projection with a fake DOM, not a canned capped string.
      const saved = [globalThis.document, globalThis.location];
      globalThis.document = { title: "t".repeat(900), body: { innerText: "v".repeat(10000) } };
      globalThis.location = { href: url };
      try { return fn(); } finally { [globalThis.document, globalThis.location] = saved; }
    },
  };
  const context = {
    setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {},
    newPage: async () => { pageCount++; return page; },
    close: async () => {
      calls.push(["context-close"]);
      if (options.closeFail) throw Error("raw-secret");
      writeFileSync(contextOptions.recordHar.path, JSON.stringify({ log: { entries: [{
        request: { url: "https://example.test/", headers: [{ name: "Cookie", value: "sensitive-cookie" }], postData: { text: "raw-body", params: [{ name: "password", value: "raw-body" }] } },
        response: { content: { text: "raw-response", encoding: "base64", _file: "body.txt", size: 10, mimeType: "text/html" } },
      }] } }));
    },
  };
  const browser = { newContext: async (value) => { calls.push(["context"]); contextOptions = value; return context; }, close: async () => { calls.push(["browser-close"]); } };
  const chromium = { launch: async (value) => { calls.push(["launch", value]); return browser; } };
  return { chromium, calls, get contextOptions() { return contextOptions; }, get pageCount() { return pageCount; } };
}
function local(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "roam-browser-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fake = engine(directory, options);
  return { directory, fake, driver: createBrowserDriver({ directory, chromium: fake.chromium, timeoutMs: options.timeoutMs ?? 500 }) };
}

test("construction needs no machine, key, browser, or agent", async () => {
  const [tool] = roamBrowserTools("/unused", {});
  assert.equal(tool.name, "browse");
  await assert.rejects(tool.execute({ action: "read" }), /no agent/);
});

test("all five actions cross as upload bytes, never interpolated text; only record output returns", async () => {
  const f = hostFakes({ replaced: true });
  const injection = "input[name=\"x\"]; $(touch /tmp/no) ' `id`\n";
  const requests = [{ action: "open", url: "https://example.test/" }, { action: "read" }, { action: "click", selector: injection }, { action: "type", selector: injection, text: injection }, { action: "screenshot" }];
  for (const request of requests) {
    const output = text(await as(f.tool, request));
    assert.ok(output.endsWith("session session:a-1:1\nscrubbed text"));
    assert.ok(!output.includes("raw-secret"));
  }
  assert.deepEqual(f.steps.slice(0, 9), ["machine:a-1", "egress-start", "driver", "start-driver", "payload", "action", "record:browser", "egress-pull", "record:egress"]);
  assert.equal(f.steps.filter((s) => s === "driver").length, 1);
  assert.equal(f.steps.filter((s) => s === "egress-start").length, 1);
  assert.deepEqual([...f.uploads].filter(([p]) => p !== DRIVER_PATH).map(([, bytes]) => JSON.parse(bytes)), requests);
  assert.ok(f.calls.every(({ command }) => !command.includes(injection) && !command.includes("raw-secret")));
  assert.deepEqual(f.calls.map((v) => v.seconds), [60, 40, 40, 40, 40, 40]);
  assert.equal(f.entries[0].sandbox, f.m.id);
  assert.equal(f.entries[0].output.includes("raw-secret"), true, "record, not this tool, owns redaction");
});

test("invalid inputs are rejected before acquiring a machine", async () => {
  const f = hostFakes();
  for (const request of [{ action: "open", url: "file:///etc/passwd" }, { action: "open", url: "https://u:p@a.test" }, { action: "open", url: "javascript:alert(1)" }, { action: "click", selector: "" }, { action: "type", selector: "x", text: "x".repeat(8001) }, { action: "read", extra: "x" }, { action: "pause" }]) await assert.rejects(as(f.tool, request), /INVALID_REQUEST/);
  assert.deepEqual(f.steps, []);
});

test("no egress log means no driver or action", async () => {
  const f = hostFakes({ logFail: true });
  await assert.rejects(as(f.tool, { action: "read" }), /No log, no browser/);
  assert.deepEqual(f.steps, ["machine:a-1", "egress-start"]);
});

test("untrusted malformed, oversized and failed transport responses have fixed errors and empty records", async () => {
  for (const result of [{ exitCode: 1, result: "raw-secret" }, { exitCode: 0, result: "raw-secret" }, { exitCode: 0, result: "x".repeat(RESPONSE_BYTES + 1) }, { exitCode: 0, result: JSON.stringify({ ok: false, error: "raw-secret" }) }, { exitCode: 0, result: JSON.stringify({ ok: true, title: "", url: "", text: "x".repeat(8001), status: null }) }]) {
    const f = hostFakes({ exec: async () => result });
    await assert.rejects(as(f.tool, { action: "read" }), { message: "The remote browser did not answer. The action may have run." });
    assert.equal(f.entries[0].output, "");
    assert.equal(f.steps.filter((s) => s === "action").length, 1, "unsafe actions never retry");
  }
});

test("pull failure retains scrubbed output and rechecks the log on the next call", async () => {
  const f = hostFakes({ pullFail: true });
  assert.match(text(await as(f.tool, { action: "read" })), /scrubbed text\nThe request log could not be read/);
  await as(f.tool, { action: "read" });
  assert.equal(f.steps.filter((s) => s === "egress-start").length, 2);
});

test("host calls from one child are serialized", async () => {
  const block = defer(), entered = defer();
  let active = 0, peak = 0;
  const f = hostFakes({ exec: async () => {
    peak = Math.max(peak, ++active); entered.resolve(); await block.promise; active--;
    return { exitCode: 0, result: JSON.stringify({ ok: true, title: "", url: "", text: "", status: null }) };
  } });
  const a = as(f.tool, { action: "read" }), b = as(f.tool, { action: "read" });
  await entered.promise;
  assert.equal(f.steps.filter((s) => s === "action").length, 1);
  block.resolve(); await Promise.all([a, b]);
  assert.equal(peak, 1);
});

test("capture/close expose only validated remote metadata; controls are not model tools", async () => {
  const control = { ok: true, paused: true, active: false, closed: false, failed: false };
  for (const fn of [pauseRoamBrowser, resumeRoamBrowser, roamBrowserStatus]) assert.deepEqual(await fn(hostFakes({ reply: control }).m), control);
  const metadata = { ok: true, closed: true, har: { path: `${SESSION_DIR}/browser.har`, bytes: 200 }, screenshots: [{ path: `${SESSION_DIR}/shot-12.png`, bytes: 20, t: 1, url: "https://a.test" }] };
  for (const fn of [captureRoamBrowser, closeRoamBrowser]) assert.deepEqual(await fn(hostFakes({ reply: { ...metadata, raw: "do not ship" } }).m), metadata);
  const bad = structuredClone(metadata); bad.screenshots[0].path = "/etc/passwd";
  await assert.rejects(captureRoamBrowser(hostFakes({ reply: bad }).m), /did not answer/);
});

test("headed :99 context is persistent and page output is capped before transport", async (t) => {
  const { driver, fake } = local(t);
  const open = await driver.dispatch({ action: "open", url: "https://example.test" });
  await driver.dispatch({ action: "click", selector: "button" });
  await driver.dispatch({ action: "type", selector: "input", text: "hello" });
  const read = await driver.dispatch({ action: "read" });
  assert.equal(open.status, 201);
  assert.equal(read.title.length, 512);
  assert.equal(read.text.length, 8000);
  assert.equal(fake.pageCount, 1);
  assert.equal(fake.calls.filter(([name]) => name === "launch").length, 1);
  assert.equal(fake.calls[0][1].headless, false);
  assert.equal(fake.calls[0][1].env.DISPLAY, ":99");
  assert.deepEqual(fake.contextOptions.proxy, { server: "http://127.0.0.1:8899" });
  assert.equal(fake.contextOptions.recordHar.content, "omit");
  assert.deepEqual(fake.calls.filter(([name]) => ["click", "type"].includes(name)), [["click", "button"], ["type", "input", "hello"]]);
});

test("pause latches, rejects queued/new actions and ACKs only after active action drains", async (t) => {
  const block = defer();
  const { driver, fake } = local(t, { block });
  const a = driver.dispatch({ action: "open", url: "https://example.test" });
  await turn();
  const queued = driver.dispatch({ action: "click", selector: "button" });
  let acknowledged = false;
  const pause = driver.dispatch({ action: "pause" }).then((v) => { acknowledged = true; return v; });
  await turn();
  assert.equal(acknowledged, false);
  assert.deepEqual(await driver.dispatch({ action: "read" }), { ok: false, error: "BROWSER_PAUSED" });
  assert.equal((await driver.dispatch({ action: "status" })).active, true);
  block.resolve(); await a;
  assert.deepEqual(await queued, { ok: false, error: "BROWSER_PAUSED" });
  assert.deepEqual(await pause, { ok: true, paused: true, active: false, closed: false, failed: false });
  assert.equal(fake.calls.some(([name]) => name === "click"), false);
  assert.equal((await driver.dispatch({ action: "resume" })).paused, false);
  assert.equal((await driver.dispatch({ action: "read" })).ok, true);
});

test("pause before browser use persists without launching Chromium", async (t) => {
  const { directory, driver, fake } = local(t);
  await driver.dispatch({ action: "pause" });
  const restarted = createBrowserDriver({ directory, chromium: fake.chromium });
  assert.equal((await restarted.dispatch({ action: "status" })).paused, true);
  assert.deepEqual(await restarted.dispatch({ action: "read" }), { ok: false, error: "BROWSER_PAUSED" });
  assert.deepEqual(fake.calls, []);
});

test("deadline never releases the real action queue or grants takeover on timeout", async (t) => {
  const block = defer();
  const { driver } = local(t, { block, timeoutMs: 20 });
  assert.deepEqual(await driver.dispatch({ action: "open", url: "https://example.test" }), { ok: false, error: "TIMEOUT" });
  assert.equal((await driver.dispatch({ action: "status" })).active, true);
  assert.deepEqual(await driver.dispatch({ action: "pause" }), { ok: false, error: "TIMEOUT" });
  assert.deepEqual(await driver.dispatch({ action: "resume" }), { ok: false, error: "BROWSER_CLOSED" });
  block.resolve(); await turn();
  assert.equal((await driver.dispatch({ action: "status" })).failed, true);
});

test("capture flushes context before browser close, omits both bodies, persists terminal manifest", async (t) => {
  const { directory, driver, fake } = local(t);
  await driver.dispatch({ action: "open", url: "https://example.test" });
  for (let i = 0; i < 12; i++) assert.equal((await driver.dispatch({ action: "screenshot" })).screenshot.path, join(directory, `shot-${i + 1}.png`));
  assert.deepEqual(await driver.dispatch({ action: "screenshot" }), { ok: false, error: "SCREENSHOT_LIMIT" });
  const captured = await driver.dispatch({ action: "capture" });
  assert.equal(captured.ok, true);
  assert.equal(captured.screenshots.length, 12);
  assert.equal(captured.har.bytes, statSync(join(directory, "browser.har")).size);
  assert.deepEqual(fake.calls.slice(-2), [["context-close"], ["browser-close"]]);
  const har = JSON.parse(readFileSync(captured.har.path, "utf8"));
  assert.equal(har.log.entries[0].request.postData, undefined);
  assert.deepEqual(har.log.entries[0].response.content, { size: 10, mimeType: "text/html" });
  assert.equal(har.log.entries[0].request.headers[0].value, "sensitive-cookie", "I6, not this driver, owns secret redaction");
  assert.deepEqual(await driver.dispatch({ action: "close" }), captured);
  assert.deepEqual(await driver.dispatch({ action: "read" }), { ok: false, error: "BROWSER_CLOSED" });
  assert.deepEqual(await createBrowserDriver({ directory, chromium: fake.chromium }).dispatch({ action: "capture" }), captured);
});

test("an older queued resume cannot clear a newer pause", async (t) => {
  const block = defer();
  const { driver } = local(t, { block });
  const open = driver.dispatch({ action: "open", url: "https://example.test" });
  await turn();
  const firstPause = driver.dispatch({ action: "pause" });
  const staleResume = driver.dispatch({ action: "resume" });
  const latestPause = driver.dispatch({ action: "pause" });
  block.resolve(); await open; await firstPause;
  assert.deepEqual(await staleResume, { ok: false, error: "BROWSER_PAUSED" });
  assert.equal((await latestPause).paused, true);
  assert.deepEqual(await driver.dispatch({ action: "read" }), { ok: false, error: "BROWSER_PAUSED" });
});

test("the remote page queue is bounded", async (t) => {
  const block = defer();
  const { driver } = local(t, { block });
  const requests = [driver.dispatch({ action: "open", url: "https://example.test" })];
  for (let i = 1; i < 16; i++) requests.push(driver.dispatch({ action: "read" }));
  assert.deepEqual(await driver.dispatch({ action: "read" }), { ok: false, error: "BUSY" });
  block.resolve();
  assert.ok((await Promise.all(requests)).every((r) => r.ok));
});

test("failed context close never claims a flushed HAR", async (t) => {
  const { driver } = local(t, { closeFail: true });
  await driver.dispatch({ action: "read" });
  assert.deepEqual(await driver.dispatch({ action: "capture" }), { ok: false, error: "CAPTURE_FAILED" });
});

test("driver restart refuses silent context replacement after an interrupted session", async (t) => {
  const { directory, driver, fake } = local(t);
  await driver.dispatch({ action: "read" });
  const restarted = createBrowserDriver({ directory, chromium: fake.chromium });
  assert.equal((await restarted.dispatch({ action: "status" })).failed, true);
  assert.deepEqual(await restarted.dispatch({ action: "read" }), { ok: false, error: "BROWSER_FAILED" });
  assert.equal(fake.calls.filter(([name]) => name === "launch").length, 1);
});

test("persistent Unix driver shares one fake context across separate request connections", async (t) => {
  const { directory, fake } = local(t);
  const { server } = await serveBrowser({ directory, chromium: fake.chromium, timeoutMs: 500 });
  t.after(() => new Promise((yes) => server.close(yes)));
  await requestBrowser({ action: "open", url: "https://example.test" }, { directory });
  await requestBrowser({ action: "type", selector: "input", text: "literal ' $(echo nope)" }, { directory });
  assert.equal(fake.pageCount, 1);
  assert.equal((await requestBrowser({ action: "pause" }, { directory })).paused, true);
  assert.deepEqual(await requestBrowser({ action: "click", selector: "button" }, { directory }), { ok: false, error: "BROWSER_PAUSED" });
  assert.equal((await requestBrowser({ action: "close" }, { directory })).closed, true);
});
