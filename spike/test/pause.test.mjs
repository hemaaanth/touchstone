// The model-call pause gate: it must hold a call, release every waiter on
// resume, nest safely, and never hang a run when nobody resumes.
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOUCHSTONE_PAUSE_CAP_MS = "300";
const gate = await import("../lib/pause.mjs");

test("a paused gate holds the call and resume releases it", async () => {
  assert.equal(gate.isPaused(), false);
  gate.pause();
  assert.equal(gate.isPaused(), true);
  let released = false;
  const waiting = gate.waitIfPaused().then(() => { released = true; });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(released, false, "the call waits");
  gate.resume();
  await waiting;
  assert.equal(released, true);
  assert.equal(gate.isPaused(), false);
});

test("nesting needs both resumes, and an extra resume is harmless", async () => {
  gate.pause();
  gate.pause();
  gate.resume();
  assert.equal(gate.isPaused(), true);
  gate.resume();
  gate.resume(); // one too many
  assert.equal(gate.isPaused(), false);
});

test("a pause nobody lifts expires instead of hanging", async () => {
  gate.pause();
  const started = Date.now();
  await gate.waitIfPaused();
  assert.ok(Date.now() - started >= 250, "waited for the cap");
  assert.equal(gate.isPaused(), true, "the pause itself stays (a waiter gave up, not the pause)");
  gate.resume();
});

// The gate is wired where model calls are made: budgetedApi must not reach the
// provider while paused.
test("a model call waits behind the gate", async () => {
  const { budgetedApi } = await import("../lib/provider.mjs");
  let called = 0;
  const api = { stream: async function* () { called++; } };
  const model = { id: "m", api: "openai-completions", provider: "p", baseUrl: "http://x", context: 1000 };
  gate.pause();
  const stream = budgetedApi(api).stream(model, {}, {});
  const pump = (async () => { for await (const _ of stream) void _; })();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(called, 0, "the provider is not called while paused");
  gate.resume();
  await pump;
  assert.equal(called, 1, "it goes through once resumed");
});

test("a pause cuts a live call and records that it did", async () => {
  gate.clearCut();
  let cut = 0;
  const off = gate.onCut(() => { cut += 1; });
  gate.pause();
  assert.equal(cut, 1, "the live call is cut");
  assert.equal(gate.wasCutByPause(), true);
  gate.resume();
  assert.equal(gate.wasCutByPause(), true, "the resume path can still see it");
  gate.clearCut();
  assert.equal(gate.wasCutByPause(), false);
  off();
});

test("an aborted provider call ends the stream instead of hanging", async () => {
  const { budgetedApi } = await import("../lib/provider.mjs");
  const api = {
    stream: async function* (_m, _c, options) {
      await new Promise((resolve) => { options.signal.addEventListener("abort", resolve, { once: true }); });
      yield { type: "error", reason: "aborted", error: { role: "assistant", content: [], errorMessage: "aborted", timestamp: Date.now() } };
    },
  };
  const model = { id: "m", api: "openai-completions", provider: "p", baseUrl: "http://x", context: 1000 };
  gate.clearCut();
  const stream = budgetedApi(api).stream(model, {}, {});
  const seen = [];
  const pump = (async () => { for await (const e of stream) seen.push(e.type); })();
  await new Promise((r) => setTimeout(r, 40));
  gate.pause();            // cuts the in-flight call
  await Promise.race([pump, new Promise((_, no) => setTimeout(() => no(new Error("hung")), 1500))]);
  assert.deepEqual(seen, ["error"], "the stream ended through the abort");
  gate.resume();
});
