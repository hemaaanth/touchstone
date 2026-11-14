// Remote-only entry: /opt/touchstone/roam/browser-driver.mjs (Playwright is baked beside it).
// serve: persistent Unix socket. request: one JSON stdin value, one JSON stdout reply.
// Page actions: {action: open|read|click|type|screenshot, url?, selector?, text?}.
// Controls: {action: pause|resume|status|capture|close}. A pause ACK means drained browser
// actions, NOT drained shell commands. The host must gate shell and browser together.
// capture/close are terminal and idempotent. Only context.close() flushes recordHar;
// never use browser.close() first. Raw HAR and PNG files stay remote for I6 policy.
import { createServer, createConnection } from "node:net";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SESSION_DIR = "/var/lib/touchstone/session";
export const DRIVER_PATH = "/opt/touchstone/roam/browser-driver.mjs";
export const REQUEST_BYTES = 32768;
export const RESPONSE_BYTES = 65536;
export const ACTION_MS = 30000;
const PAGE_ACTIONS = ["open", "read", "click", "type", "screenshot"];
const CONTROLS = ["pause", "resume", "status", "capture", "close"];
const fail = (error) => ({ ok: false, error });

export function validateBrowserRequest(value, controls = true) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_REQUEST");
  const { action } = value;
  if (![...PAGE_ACTIONS, ...(controls ? CONTROLS : [])].includes(action)) throw new Error("INVALID_REQUEST");
  const keys = action === "open" ? ["action", "url"] : action === "click" ? ["action", "selector"] : action === "type" ? ["action", "selector", "text"] : ["action"];
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error("INVALID_REQUEST");
  const bounded = (s, max) => typeof s === "string" && s.length <= max && !s.includes("\0");
  if (action === "open") {
    if (!bounded(value.url, 2000)) throw new Error("INVALID_REQUEST");
    let url;
    try { url = new URL(value.url); } catch { throw new Error("INVALID_REQUEST"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("INVALID_REQUEST");
  }
  if (["click", "type"].includes(action) && (!bounded(value.selector, 2000) || !value.selector.trim())) throw new Error("INVALID_REQUEST");
  if (action === "type" && !bounded(value.text, 8000)) throw new Error("INVALID_REQUEST");
  if (Buffer.byteLength(JSON.stringify(value)) > REQUEST_BYTES) throw new Error("INVALID_REQUEST");
  return { ...value };
}

function deadline(promise, ms, expired = () => {}) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => { expired(); reject(new Error("TIMEOUT")); }, ms);
  })]).finally(() => clearTimeout(timer));
}

function omitHarBodies(path) {
  // Playwright 1.64.1 still writes form params with content:"omit". Remove the
  // whole request body too. This is payload omission, not I6's secret redactor.
  if (statSync(path).size > 16 * 1024 * 1024) throw new Error("CAPTURE_FAILED");
  const har = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(har?.log?.entries)) throw new Error("CAPTURE_FAILED");
  for (const entry of har.log.entries) {
    if (entry.request) delete entry.request.postData;
    if (entry.response?.content) {
      delete entry.response.content.text;
      delete entry.response.content.encoding;
      delete entry.response.content._file;
    }
  }
  writeFileSync(`${path}.tmp`, JSON.stringify(har), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export function createBrowserDriver({ chromium, directory = SESSION_DIR, timeoutMs = ACTION_MS } = {}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const harPath = join(directory, "browser.har");
  const manifestPath = join(directory, "browser-capture.json");
  const pausePath = join(directory, "browser.paused");
  const startedPath = join(directory, "browser.started");
  let manifest = null;
  if (existsSync(manifestPath)) {
    if (statSync(manifestPath).size > RESPONSE_BYTES) throw new Error("CAPTURE_FAILED");
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  }
  let paused = existsSync(pausePath);
  // Do not silently launch a new context over a crashed context's HAR.
  let failed = !manifest && existsSync(startedPath);
  let closed = Boolean(manifest);
  let closing = false;
  let active = false;
  let pending = 0;
  let tail = Promise.resolve();
  let browser;
  let context;
  let page;
  const screenshots = [];
  const status = () => ({ ok: true, paused, active, closed, failed });
  const expire = () => { failed = true; };
  const wait = (p) => deadline(p, timeoutMs, expire);
  const errorOf = (e) => fail(e?.message === "TIMEOUT" || e?.name === "TimeoutError" ? "TIMEOUT" : "BROWSER_FAILED");

  async function ensurePage() {
    if (page) return;
    writeFileSync(startedPath, "1", { mode: 0o600 });
    const engine = chromium ?? (await import("playwright")).chromium;
    browser = await engine.launch({ headless: false, env: { ...process.env, DISPLAY: ":99" }, timeout: timeoutMs });
    context = await browser.newContext({
      viewport: { width: 1920, height: 1080 }, acceptDownloads: false,
      proxy: { server: "http://127.0.0.1:8899" },
      recordHar: { path: harPath, content: "omit", mode: "full" },
    });
    context.setDefaultTimeout(timeoutMs);
    context.setDefaultNavigationTimeout(timeoutMs);
    page = await context.newPage();
  }

  async function act(request) {
    await ensurePage();
    let responseStatus = null;
    let screenshot;
    if (request.action === "open") {
      const response = await page.goto(request.url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      responseStatus = response?.status() ?? null;
    } else if (request.action === "click") {
      await page.locator(request.selector).click({ timeout: timeoutMs });
    } else if (request.action === "type") {
      await page.locator(request.selector).fill(request.text, { timeout: timeoutMs });
    } else if (request.action === "screenshot") {
      if (screenshots.length >= 12) return fail("SCREENSHOT_LIMIT");
      const path = join(directory, `shot-${screenshots.length + 1}.png`);
      await page.screenshot({ path, type: "png", fullPage: false, timeout: timeoutMs });
      screenshot = { path, bytes: statSync(path).size, t: Date.now(), url: page.url().slice(0, 2000) };
      screenshots.push(screenshot);
    }
    // Bound strings in the page, before they cross the Playwright transport.
    const view = await page.evaluate(() => ({
      title: document.title.slice(0, 512), url: location.href.slice(0, 2000),
      text: (document.body?.innerText ?? "").slice(0, 8000),
    }));
    return { ok: true, ...view, status: responseStatus, ...(screenshot ? { screenshot } : {}) };
  }

  async function capture() {
    if (manifest) return manifest;
    if (failed) return fail("CAPTURE_FAILED");
    closing = true;
    try {
      await wait(tail);
      // Public API contract: await context.close to finish writing the HAR.
      if (context) {
        await wait(context.close());
        omitHarBodies(harPath);
      }
      closed = true;
      const har = context ? { path: harPath, bytes: statSync(harPath).size } : null;
      if (browser) await wait(browser.close());
      const captured = { ok: true, closed: true, har, screenshots: [...screenshots] };
      writeFileSync(`${manifestPath}.tmp`, JSON.stringify(captured), { mode: 0o600 });
      renameSync(`${manifestPath}.tmp`, manifestPath);
      manifest = captured;
      return manifest;
    } catch {
      failed = true;
      return fail("CAPTURE_FAILED");
    }
  }
  let capturing;
  let controls = Promise.resolve();
  let pauseGeneration = 0;

  async function dispatch(input) {
    let request;
    try { request = validateBrowserRequest(input); } catch { return fail("INVALID_REQUEST"); }
    const { action } = request;
    if (action === "status") return status();
    if (action === "pause") {
      pauseGeneration++;
      // Latch before draining: previously queued actions must not run after this.
      paused = true;
      writeFileSync(pausePath, "1", { mode: 0o600 });
      const run = async () => {
        try { await wait(tail); return failed ? fail("BROWSER_FAILED") : status(); } catch (e) { return errorOf(e); }
      };
      return (controls = controls.then(run, run));
    }
    if (action === "resume") {
      const generation = pauseGeneration;
      const run = () => {
        if (failed || closing || closed) return fail("BROWSER_CLOSED");
        if (generation !== pauseGeneration) return fail("BROWSER_PAUSED");
        paused = false;
        if (existsSync(pausePath)) unlinkSync(pausePath);
        return status();
      };
      return (controls = controls.then(run, run));
    }
    if (action === "capture" || action === "close") {
      if (!capturing) capturing = capture();
      return capturing;
    }
    if (closed || closing) return fail("BROWSER_CLOSED");
    if (failed) return fail("BROWSER_FAILED");
    if (paused) return fail("BROWSER_PAUSED");
    if (pending >= 16) return fail("BUSY");
    pending++;
    const run = async () => {
      if (paused) return fail("BROWSER_PAUSED");
      if (failed) return fail("BROWSER_FAILED");
      active = true;
      // Keep the queue tied to the REAL action, not just a timed-out Promise.race.
      // A timeout poisons the driver; pause cannot ACK while that action lives.
      try { return await act(request); } catch (e) {
        if (!page) failed = true;
        return errorOf(e);
      }
      finally { active = false; }
    };
    const job = tail.then(run);
    tail = job.catch(() => {}).finally(() => pending--);
    try { return await wait(job); } catch (e) { return errorOf(e); }
  }
  return { dispatch };
}

// Strict bounded framing. One request per connection; no page/Playwright error logs.
async function readJson(stream, max, ms) {
  return deadline(new Promise((resolveValue, reject) => {
    const chunks = [];
    let bytes = 0;
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > max) { reject(new Error("INVALID_REQUEST")); stream.destroy(); }
      else chunks.push(chunk);
    });
    stream.on("end", () => {
      try { resolveValue(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("INVALID_REQUEST")); }
    });
    stream.on("error", reject);
  }), ms, () => stream.destroy());
}

export async function serveBrowser({ directory = SESSION_DIR, chromium, timeoutMs = ACTION_MS } = {}) {
  const driver = createBrowserDriver({ directory, chromium, timeoutMs });
  const socketPath = join(directory, "browser.sock");
  // Do not unlink an owned live socket. Host startup probes before starting us.
  const server = createServer({ allowHalfOpen: true }, async (socket) => {
    let reply;
    try { reply = await driver.dispatch(await readJson(socket, REQUEST_BYTES, timeoutMs)); }
    catch { reply = fail("INVALID_REQUEST"); }
    let json = JSON.stringify(reply);
    if (Buffer.byteLength(json) > RESPONSE_BYTES) json = JSON.stringify(fail("RESPONSE_LIMIT"));
    if (!socket.destroyed) socket.end(json);
  });
  await new Promise((yes, no) => { server.once("error", no); server.listen(socketPath, yes); });
  server.maxConnections = 32;
  chmodSync(socketPath, 0o600);
  return { server, driver };
}

export async function requestBrowser(request, { directory = SESSION_DIR, timeoutMs = ACTION_MS + 5000 } = {}) {
  validateBrowserRequest(request);
  const socket = createConnection(join(directory, "browser.sock"));
  socket.on("connect", () => socket.end(JSON.stringify(request)));
  return readJson(socket, RESPONSE_BYTES, timeoutMs);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "serve") await serveBrowser();
    else if (process.argv[2] === "request") {
      const request = await readJson(process.stdin, REQUEST_BYTES, 5000);
      process.stdout.write(JSON.stringify(await requestBrowser(request)) + "\n");
    } else throw new Error();
  } catch {
    process.stdout.write(JSON.stringify(fail("DRIVER_UNAVAILABLE")) + "\n");
    process.exitCode = 1;
  }
}
