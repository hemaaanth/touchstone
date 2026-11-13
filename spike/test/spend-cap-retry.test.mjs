// Two faults from the first live batch, tested offline with fakes.
//
// 1. A total spend cap (SPEND_CAP_USD over the shared ledger) must fail closed:
//    a corrupt ledger, a ledger with no numeric total, or a bad cap value must
//    stop the call, never mean "no limit".
// 2. A retryable provider error must be retried by the harness. The live run
//    died on a mid-stream SSE error whose text was exactly "Stream interrupted".
//    pi-ai's retry classifier only knows "stream was interrupted", so the run
//    ended with no retry. A non-retryable error must still fail fast, and a
//    retry must not double-count spend or pass either budget.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs, { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage as answer, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";

const dir = mkdtempSync(join(tmpdir(), "spend-cap-retry-"));
const LEDGER = join(dir, "spend.json");
// Set before the first import: inference.mjs builds the run budget at load.
process.env.SPEND_LEDGER = LEDGER;
process.env.RUN_BUDGET_USD = "1000";
process.env.SPEND_CAP_USD = "50.85";
const { guard, charge, ledgerCharge, LEDGER_LOCK_MS, LEDGER_LOCKED, runSpend, spent, spendCapUsd, spendCapMessage, DEFAULT_SPEND_CAP_USD } = await import("../lib/inference.mjs");
const { budgetedApi } = await import("../lib/provider.mjs");

const ledger = (totalUsd) => writeFileSync(LEDGER, JSON.stringify({ totalUsd, calls: 0, byModel: {} }));
const total = () => JSON.parse(readFileSync(LEDGER, "utf8")).totalUsd;

beforeEach(() => {
  process.env.SPEND_LEDGER = LEDGER;
  process.env.SPEND_CAP_USD = "50.85";
  ledger(0);
});
after(() => rmSync(dir, { recursive: true, force: true }));

// ---- Fault 1: the total cap fails closed.

test("total cap: a ledger at or above the cap stops the call with a cap reason", () => {
  ledger(50.85);
  assert.throws(() => guard(), /Total spend cap reached/);
  ledger(10);
  assert.doesNotThrow(() => guard());
});

test("total cap: a corrupt ledger stops the call instead of meaning no limit", () => {
  writeFileSync(LEDGER, "{ not json");
  assert.throws(() => guard(), /spend ledger/i);
});

test("total cap: a ledger with no numeric total stops the call", () => {
  writeFileSync(LEDGER, JSON.stringify({ calls: 3, byModel: {} }));
  assert.throws(() => guard(), /spend ledger/i);
  writeFileSync(LEDGER, JSON.stringify({ totalUsd: "12", calls: 3, byModel: {} }));
  assert.throws(() => guard(), /spend ledger/i);
});

test("total cap: an unusable SPEND_CAP_USD stops the call instead of meaning no limit", () => {
  for (const bad of ["abc", "-1", "0", "Infinity"]) {
    process.env.SPEND_CAP_USD = bad;
    assert.throws(() => guard(), /SPEND_CAP_USD/, `cap ${bad}`);
  }
});

test("total cap: charge keeps the ledger format and adds once", () => {
  ledger(1);
  charge("unknown-model", { input: 1_000_000, output: 0 });
  const l = JSON.parse(readFileSync(LEDGER, "utf8"));
  assert.deepEqual(Object.keys(l).sort(), ["byModel", "calls", "totalUsd"]);
  assert.equal(l.calls, 1);
  assert.ok(Math.abs(spent() - 2) < 1e-9); // fallback price $1 per 1M input
});

// ---- Fault 2: retry a retryable provider error, through the real harness.

const USAGE = { input: 100_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const failure = (errorMessage) => answer([], { stopReason: "error", errorMessage });
const ok = () => answer("Audit complete.");

// One root agent over the budgeted provider. `script` answers call n (0-based).
async function harness(t, script, { errorUsage = USAGE } = {}) {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  const faux = fauxProvider({ tokensPerSecond: 0 });
  let calls = 0;
  faux.setResponses(Array.from({ length: 10 }, () => () => script(calls++)));
  const models = createModels();
  // Faux replaces usage with its own token estimate; pin it so cost is exact.
  const pinned = (inner) => (m, c, o) => (async function* () {
    for await (const e of inner(m, c, o)) {
      if (e.type === "done") e.message.usage = USAGE;
      if (e.type === "error") e.error.usage = errorUsage;
      yield e;
    }
  })();
  const api = { stream: pinned(faux.provider.stream), streamSimple: pinned(faux.provider.streamSimple) };
  models.setProvider({ ...faux.provider, ...budgetedApi(api) });
  // The engine's own retry policy shape (agent-run.mjs), with a tiny delay.
  const h = await Harness.open(new MemoryStorage(), { models, registry: createRegistry(), settings: { retry: { maxRetries: 3, baseDelayMs: 1, maxAgentDelayMs: 5 } } }, ctx);
  t.after(() => h.close(ctx));
  const root = await h.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" }, instructions: "Audit." } });
  const settled = await (await root.submit({ type: "input", content: "start" }, ctx)).wait(ctx);
  return { settled, calls: () => calls };
}

test("retry: the live run's 'Stream interrupted' error is retried and the run finishes", { timeout: 10000 }, async (t) => {
  const r = await harness(t, (n) => (n === 0 ? failure("Stream interrupted") : ok()));
  assert.equal(r.settled.status, "done", `settled ${r.settled.reason}: ${r.settled.detail}`);
  assert.equal(r.calls(), 2);
  // Two provider responses, each charged once: 2 x 100k input tokens at the
  // $1/1M fallback price. A retry must not charge the failed attempt twice.
  assert.ok(Math.abs(total() - 0.2) < 1e-9, `ledger ${total()}`);
});

test("retry: the retry is bounded; a stream that keeps dropping ends after maxRetries", { timeout: 10000 }, async (t) => {
  const r = await harness(t, () => failure("Stream interrupted"));
  assert.equal(r.settled.status, "unanswered");
  assert.equal(r.settled.reason, "model_error");
  assert.equal(r.calls(), 4); // 1 call + maxRetries 3
  assert.ok(Math.abs(total() - 0.4) < 1e-9, `ledger ${total()}`);
});

test("retry: network errors, timeouts, 429 and 5xx are retried", async () => {
  for (const msg of ["Stream interrupted", "read ECONNRESET", "connect ETIMEDOUT 10.0.0.1:443", "Lyber (502): upstream gone", "Premature close", "429 Too Many Requests", "502 Bad Gateway", "Request timed out."]) {
    assert.equal(isRetryableAssistantError(await budgetedForward(msg)), true, msg);
  }
});

test("retry: a 4xx (other than 429) or a bad key is not retried", { timeout: 10000 }, async (t) => {
  for (const msg of ["401 Incorrect API key provided", "400 unsupported_parameter: store", "403 Forbidden", "404 model not found", "400 Stream interrupted", "Lyber (403): Stream interrupted", "status 401: read ECONNRESET"]) {
    assert.equal(isRetryableAssistantError(await budgetedForward(msg)), false, msg);
  }
  const r = await harness(t, () => failure("401 Incorrect API key provided"));
  assert.equal(r.settled.status, "unanswered");
  assert.equal(r.settled.reason, "model_error");
  assert.equal(r.calls(), 1);
});

test("retry: a retry respects the total cap and never calls the provider past it", { timeout: 10000 }, async (t) => {
  // $50.75 spent; the failed attempt costs $0.10 and brings the ledger to the cap.
  ledger(50.75);
  const r = await harness(t, (n) => (n === 0 ? failure("Stream interrupted") : ok()));
  assert.equal(r.settled.status, "unanswered");
  assert.match(r.settled.detail, /Total spend cap reached/);
  assert.equal(r.calls(), 1);
  assert.ok(Math.abs(total() - 50.85) < 1e-9, `ledger ${total()}`);
});

test("retry: the budget stop itself is never retried", () => {
  ledger(60);
  let message;
  try { guard(); } catch (err) { message = err.message; }
  assert.ok(message);
  assert.equal(isRetryableAssistantError({ stopReason: "error", errorMessage: message }), false);
  process.env.SPEND_CAP_USD = "abc";
  try { guard(); } catch (err) { message = err.message; }
  assert.equal(isRetryableAssistantError({ stopReason: "error", errorMessage: message }), false);
});

// What the harness sees after budgetedApi forwards one provider error event.
// `started`: pi-ai sent "start" first, as it does once the provider answered 2xx.
async function budgetedForward(errorMessage, context = { messages: [] }, usage, started = false) {
  const inner = () => (async function* () {
    if (started) yield { type: "start", partial: { role: "assistant", content: [] } };
    yield { type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage, ...(usage ? { usage } : {}) } };
  })();
  const out = budgetedApi({ stream: inner, streamSimple: inner }).stream({ id: "faux-1", api: "faux", provider: "faux" }, context, {});
  let last;
  for await (const e of out) if (e.type === "error") last = e.error;
  return last;
}

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

test("retry: transient words in a cap message, a 408 and a content filter are classed right", async () => {
  // "$500.00" or "$429.00" must not read as an HTTP status that is retried.
  for (const cap of [500, 429, 502]) {
    const msg = spendCapMessage(cap - 1, cap);
    assert.equal(isRetryableAssistantError({ stopReason: "error", errorMessage: msg }), false, msg);
    assert.equal(isRetryableAssistantError(await budgetedForward(msg)), false, msg);
  }
  assert.equal(isRetryableAssistantError(await budgetedForward("status 408: ETIMEDOUT")), true);
  // "interrupted" alone is not a dropped stream.
  assert.equal(isRetryableAssistantError(await budgetedForward("Generation interrupted by the content filter")), false);
});

test("retry: the engine's retry bound is small", () => {
  const src = readFileSync(new URL("../agent-run.mjs", import.meta.url), "utf8");
  const m = src.match(/retry:\s*\{\s*maxRetries:\s*([\d_e.]+)/);
  assert.ok(m, "agent-run.mjs sets settings.retry.maxRetries");
  const n = Number(m[1].replaceAll("_", ""));
  assert.ok(Number.isInteger(n) && n >= 1 && n <= 10, `maxRetries ${m[1]}`);
});

// ---- A dropped stream reports zero usage. Its prompt is still billed.

test("drop: a dropped stream with zero usage is charged an estimate of its prompt", async (t) => {
  t.mock.method(console, "warn", () => {});
  // 35,000 chars is about 10k tokens: about $0.01 at the $1/1M fallback price.
  const context = { systemPrompt: "Audit.", messages: [{ role: "user", content: "x".repeat(35_000), timestamp: 0 }] };
  await budgetedForward("Stream interrupted", context, ZERO, true);
  const first = total();
  assert.ok(first > 0.009 && first < 0.012, `ledger ${first}`);
  // A refusal (4xx), our own cap stop, or a host that was never reached billed nothing.
  for (const msg of ["401 Incorrect API key provided", spendCapMessage(50.85, 50.85), "Run budget reached: $5.0000 spent of $5.00.", "getaddrinfo ENOTFOUND api.example.com"]) {
    await budgetedForward(msg, context, ZERO);
    assert.equal(total(), first, msg);
  }
  // Reported usage wins over the estimate.
  await budgetedForward("Stream interrupted", context, { ...ZERO, input: 1_000_000 }, true);
  assert.ok(Math.abs(total() - first - 1) < 1e-9, `ledger ${total()}`);
});

test("drop: a call is charged an estimate only when it reached the provider", async (t) => {
  t.mock.method(console, "warn", () => {});
  const context = { systemPrompt: "Audit.", messages: [{ role: "user", content: "x".repeat(35_000), timestamp: 0 }] };
  // The texts pi-ai gives when no answer came back: a refused or unknown host
  // (openai SDK, undici). No "start" came first, so nothing is charged.
  for (const msg of ["Connection error.", "fetch failed"]) {
    await budgetedForward(msg, context, ZERO);
    assert.equal(total(), 0, msg);
  }
  // The request reached a server: it answered 5xx, or it timed out after the
  // request was sent, or the stream had started and then broke.
  let before = 0;
  for (const [msg, started] of [["502 Bad Gateway", false], ['504: {"message":"upstream timed out"}', false], ["Request timed out.", false], ["terminated", true], ["Connection error.", true]]) {
    await budgetedForward(msg, context, ZERO, started);
    assert.ok(total() - before > 0.009, `${msg}: ledger ${total()}`);
    before = total();
  }
});

test("drop: a stream that keeps dropping with zero usage still charges every attempt", { timeout: 10000 }, async (t) => {
  const r = await harness(t, () => failure("Stream interrupted"), { errorUsage: ZERO });
  assert.equal(r.calls(), 4);
  const l = JSON.parse(readFileSync(LEDGER, "utf8"));
  assert.equal(l.calls, 4);
  assert.ok(l.totalUsd > 0, `ledger ${l.totalUsd}`);
});

// ---- The CLI has a cap too, and outside spend (Strix) goes on the ledger.

test("total cap: with SPEND_CAP_USD unset the config cap or the default applies", () => {
  assert.equal(spendCapUsd({}, undefined), DEFAULT_SPEND_CAP_USD);
  assert.equal(spendCapUsd({}, ""), DEFAULT_SPEND_CAP_USD);
  assert.equal(spendCapUsd({ spendCapUsd: 20 }, undefined), 20);
  assert.equal(spendCapUsd({ spendCapUsd: 20 }, "30"), 20); // the env only lowers it
  assert.equal(spendCapUsd({ spendCapUsd: 20 }, "5"), 5);
  assert.throws(() => spendCapUsd({ spendCapUsd: 0 }, undefined), /spendCapUsd/);
  delete process.env.SPEND_CAP_USD;
  if (spendCapUsd() !== DEFAULT_SPEND_CAP_USD) return; // a local config sets its own cap
  ledger(50.85);
  assert.throws(() => guard(), /Total spend cap reached/);
  ledger(50.8);
  assert.doesNotThrow(() => guard());
});

test("total cap: ledgerCharge puts outside spend on the ledger once, not on the run budget", () => {
  ledger(1);
  const before = runSpend().usd;
  assert.equal(ledgerCharge("m (strix)", 0.25), 0.25);
  assert.equal(ledgerCharge("m (strix)", 0), 0);
  assert.equal(ledgerCharge("m (strix)", Number.NaN), 0);
  assert.equal(runSpend().usd, before);
  const l = JSON.parse(readFileSync(LEDGER, "utf8"));
  assert.ok(Math.abs(l.totalUsd - 1.25) < 1e-9);
  assert.equal(l.calls, 1);
});

// ---- A process that dies while it holds the lock leaves the lock file.

test("ledger lock: a waiter outlasts a dead lock and still writes its charge", (t) => {
  t.mock.method(console, "warn", () => {});
  assert.ok(LEDGER_LOCK_MS.waitMs > LEDGER_LOCK_MS.staleMs, "the wait outlasts the stale time");
  const saved = { ...LEDGER_LOCK_MS };
  t.after(() => Object.assign(LEDGER_LOCK_MS, saved));
  Object.assign(LEDGER_LOCK_MS, { waitMs: 600, staleMs: 150 });
  ledger(1);
  writeFileSync(`${LEDGER}.lock`, ""); // a fresh lock with no holder
  const t0 = Date.now();
  charge("unknown-model", { input: 1_000_000, output: 0 });
  assert.ok(Date.now() - t0 >= 140, "it waited for the lock to go stale");
  assert.ok(Math.abs(total() - 2) < 1e-9, `ledger ${total()}`);
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith("spend.json.")), []);
});

test("ledger lock: a lock held too long stops the call with its own reason, not retried", (t) => {
  const saved = { ...LEDGER_LOCK_MS };
  t.after(() => Object.assign(LEDGER_LOCK_MS, saved));
  Object.assign(LEDGER_LOCK_MS, { waitMs: 50, staleMs: 10_000 });
  ledger(1);
  writeFileSync(`${LEDGER}.lock`, "");
  t.after(() => rmSync(`${LEDGER}.lock`, { force: true }));
  let message;
  try { charge("unknown-model", { input: 1_000_000, output: 0 }); } catch (err) { message = err.message; }
  assert.ok(message?.includes(LEDGER_LOCKED), message);
  assert.doesNotMatch(message, /spend cap|out of budget/i);
  assert.equal(isRetryableAssistantError({ stopReason: "error", errorMessage: message }), false);
  assert.equal(total(), 1);
});

// A pid that was just in use and is now dead.
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

test("ledger lock: a lock whose holder is dead is removed at once", (t) => {
  const saved = { ...LEDGER_LOCK_MS };
  t.after(() => Object.assign(LEDGER_LOCK_MS, saved));
  Object.assign(LEDGER_LOCK_MS, { waitMs: 5_000, staleMs: 10_000 });
  ledger(1);
  writeFileSync(`${LEDGER}.lock`, String(deadPid())); // fresh, so only the pid says it is stale
  const t0 = Date.now();
  charge("unknown-model", { input: 1_000_000, output: 0 });
  assert.ok(Date.now() - t0 < 1_000, `waited ${Date.now() - t0} ms`);
  assert.ok(Math.abs(total() - 2) < 1e-9, `ledger ${total()}`);
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith("spend.json.")), []);
});

test("ledger lock: a lock with this process's own pid is removed at once", (t) => {
  const saved = { ...LEDGER_LOCK_MS };
  t.after(() => Object.assign(LEDGER_LOCK_MS, saved));
  Object.assign(LEDGER_LOCK_MS, { waitMs: 5_000, staleMs: 10_000 });
  ledger(1);
  writeFileSync(`${LEDGER}.lock`, String(process.pid)); // left by an earlier process with this pid
  const t0 = Date.now();
  charge("unknown-model", { input: 1_000_000, output: 0 });
  assert.ok(Date.now() - t0 < 1_000, `waited ${Date.now() - t0} ms`);
  assert.ok(Math.abs(total() - 2) < 1e-9, `ledger ${total()}`);
});

test("ledger lock: a fresh lock whose holder is alive is kept", (t) => {
  const saved = { ...LEDGER_LOCK_MS };
  t.after(() => Object.assign(LEDGER_LOCK_MS, saved));
  Object.assign(LEDGER_LOCK_MS, { waitMs: 100, staleMs: 10_000 });
  ledger(1);
  const lock = `${LEDGER}.lock`;
  writeFileSync(lock, String(process.ppid)); // the test runner: alive
  t.after(() => rmSync(lock, { force: true }));
  assert.throws(() => charge("unknown-model", { input: 1_000_000, output: 0 }), (err) => err.message.includes(LEDGER_LOCKED));
  assert.equal(readFileSync(lock, "utf8"), String(process.ppid));
  assert.equal(total(), 1);
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith("spend.json.") && f !== "spend.json.lock"), []);
});

// A lock older than staleMs is stuck whatever its pid says: pid 1 is always
// alive, a dead pid can be reused, and a .break can be left by a process that
// died while it held it. Each is broken once staleMs has passed. Age is ctime,
// which a test cannot set back, so these wait for a short staleMs.
for (const [kind, setup] of [
  ["pid 1", (lock) => writeFileSync(lock, "1")],
  ["a live pid", (lock) => writeFileSync(lock, String(process.ppid))],
  ["a dead pid and an orphan .break", (lock) => { writeFileSync(lock, String(deadPid())); writeFileSync(`${lock}.break`, String(deadPid())); }],
]) {
  test(`ledger lock: a lock with ${kind} is broken after staleMs`, (t) => {
    const saved = { ...LEDGER_LOCK_MS };
    t.after(() => Object.assign(LEDGER_LOCK_MS, saved));
    Object.assign(LEDGER_LOCK_MS, { waitMs: 2_000, staleMs: 150 });
    ledger(1);
    const lock = `${LEDGER}.lock`;
    t.after(() => { rmSync(lock, { force: true }); rmSync(`${lock}.break`, { force: true }); });
    setup(lock);
    const t0 = Date.now();
    charge("unknown-model", { input: 1_000_000, output: 0 });
    const waited = Date.now() - t0;
    assert.ok(waited >= 140 && waited < 1_500, `waited ${waited} ms`);
    assert.ok(Math.abs(total() - 2) < 1e-9, `ledger ${total()}`);
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith("spend.json.")), []);
  });
}

// The race in a fixed order. Process B sees a dead holder's lock. Before B can
// remove it, process A removes it and takes the lock. B must then keep A's lock.
test("ledger lock: a stale lock that another process replaced is not removed", (t) => {
  const saved = { ...LEDGER_LOCK_MS };
  Object.assign(LEDGER_LOCK_MS, { waitMs: 100, staleMs: 10_000 });
  ledger(1);
  const lock = `${LEDGER}.lock`;
  writeFileSync(lock, String(deadPid()));
  const real = fs.readFileSync;
  let swapped = false;
  fs.readFileSync = function (path, ...rest) {
    const out = real.call(this, path, ...rest);
    if (!swapped && path === lock) {
      swapped = true;
      rmSync(lock);
      writeFileSync(lock, String(process.ppid)); // A, alive, now holds the lock
    }
    return out;
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.readFileSync = real;
    syncBuiltinESMExports();
    Object.assign(LEDGER_LOCK_MS, saved);
    rmSync(lock, { force: true });
  });
  assert.throws(() => charge("unknown-model", { input: 1_000_000, output: 0 }), (err) => err.message.includes(LEDGER_LOCKED));
  assert.ok(swapped);
  assert.equal(real(lock, "utf8"), String(process.ppid), "A's lock is still there");
});

// ---- Many processes share one ledger. No charge is lost and the file never
// tears. Each worker loops guard() then charge() at $0.01.

const WORKER = `
const { guard, charge, LEDGER_LOCK_MS } = await import(process.argv[2]);
Object.assign(LEDGER_LOCK_MS, JSON.parse(process.env.TEST_LOCK_MS ?? "{}"));
const n = Number(process.argv[3]);
console.warn = () => {};
let corrupt = 0, capped = 0, charged = 0, other = [];
for (let i = 0; i < n; i++) {
  try { guard(); } catch (e) { if (/corrupt/.test(e.message)) { corrupt++; continue; } if (/cap reached/.test(e.message)) { capped++; continue; } other.push(e.message); continue; }
  try { charge("unknown-model-x", { input: 10_000, output: 0 }); charged++; } catch (e) { if (/corrupt/.test(e.message)) corrupt++; else other.push(e.message); }
}
console.log(JSON.stringify({ corrupt, capped, charged, other }));
`;
// `lock` is the text of a stale lock file left before the workers start.
// `lockMs` overrides the workers' lock times.
async function race(name, workers, rounds, cap, lock, lockMs = {}) {
  const d = join(dir, name);
  mkdirSync(d);
  const file = join(d, "spend.json");
  writeFileSync(file, JSON.stringify({ totalUsd: 0, calls: 0, byModel: {} }));
  if (lock !== undefined) {
    writeFileSync(`${file}.lock`, lock);
    // Age is ctime, which cannot be set back: wait until the lock is stale.
    if (lockMs.staleMs) await new Promise((r) => setTimeout(r, lockMs.staleMs + 50));
  }
  const worker = join(d, "worker.mjs");
  writeFileSync(worker, WORKER);
  const env = { ...process.env, SPEND_LEDGER: file, SPEND_CAP_USD: String(cap), RUN_BUDGET_USD: "1000", TEST_LOCK_MS: JSON.stringify(lockMs) };
  const lib = new URL("../lib/inference.mjs", import.meta.url).href;
  const one = () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [worker, lib, String(rounds)], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`worker exit ${code}: ${err}`))));
  });
  const results = await Promise.all(Array.from({ length: workers }, one));
  const l = JSON.parse(readFileSync(file, "utf8")); // throws if the file tore
  return { results, l, leftover: readdirSync(d).filter((f) => f !== "spend.json" && f !== "worker.mjs") };
}

for (const workers of [2, 4]) {
  test(`ledger race: ${workers} processes lose no charge and never tear the file`, { timeout: 60000 }, async () => {
    const { results, l, leftover } = await race(`race-${workers}`, workers, 150, 1000);
    const charged = results.reduce((a, r) => a + r.charged, 0);
    assert.deepEqual(results.flatMap((r) => r.other), []);
    assert.equal(results.reduce((a, r) => a + r.corrupt, 0), 0);
    assert.equal(charged, workers * 150);
    assert.equal(l.calls, charged);
    assert.ok(Math.abs(l.totalUsd - charged * 0.01) < 1e-6, `ledger ${l.totalUsd} for ${charged} charges`);
    assert.deepEqual(leftover, []);
  });
}

test("ledger race: 4 processes at a $2 cap record every charge and stop near the cap", { timeout: 60000 }, async () => {
  const { results, l, leftover } = await race("race-cap", 4, 150, 2);
  const charged = results.reduce((a, r) => a + r.charged, 0);
  assert.deepEqual(results.flatMap((r) => r.other), []);
  assert.equal(results.reduce((a, r) => a + r.corrupt, 0), 0);
  assert.equal(l.calls, charged);
  assert.ok(Math.abs(l.totalUsd - charged * 0.01) < 1e-6);
  // guard() and charge() are separate steps, so each worker can pass guard()
  // once more while another is charging: at most one $0.01 call over per worker.
  assert.ok(l.totalUsd >= 2 - 1e-9 && l.totalUsd <= 2 + 4 * 0.01 + 1e-9, `ledger ${l.totalUsd}`);
  assert.ok(results.some((r) => r.capped > 0));
  assert.deepEqual(leftover, []);
});

// Two processes must not both remove one stale lock: the second would remove
// the first one's new lock, and both would write at once.
// staleMs is 1 s, far longer than any charge holds the lock.
for (const [kind, lock, lockMs] of [["dead holder", () => String(deadPid()), {}], ["no pid, older than staleMs", () => "", { staleMs: 1_000 }]]) {
  test(`ledger race: 8 processes start on a stale lock (${kind}) and lose no charge`, { timeout: 120000 }, async () => {
    for (let round = 0; round < 10; round++) {
      const { results, l, leftover } = await race(`stale-${kind.replace(/\W+/g, "-")}-${round}`, 8, 20, 1000, lock(), lockMs);
      const charged = results.reduce((a, r) => a + r.charged, 0);
      assert.deepEqual(results.flatMap((r) => r.other), []);
      assert.equal(charged, 160);
      assert.equal(l.calls, charged, `round ${round}`);
      assert.deepEqual(leftover, []);
    }
  });
}
