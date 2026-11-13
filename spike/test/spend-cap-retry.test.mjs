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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const { guard, charge, spent } = await import("../lib/inference.mjs");
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
async function harness(t, script) {
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
      if (e.type === "error") e.error.usage = USAGE;
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
async function budgetedForward(errorMessage) {
  const inner = () => (async function* () {
    yield { type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage } };
  })();
  const out = budgetedApi({ stream: inner, streamSimple: inner }).stream({ id: "faux-1", api: "faux", provider: "faux" }, { messages: [] }, {});
  let last;
  for await (const e of out) if (e.type === "error") last = e.error;
  return last;
}
