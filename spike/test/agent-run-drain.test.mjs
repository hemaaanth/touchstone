import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage as answer, fauxProvider, fauxToolCall as call } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, LiveDoc, MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { createFleet } from "../lib/fleet.mjs";
import { currentAgent } from "../lib/event.mjs";
import { afterNudge } from "../lib/nudge.mjs";

// Execute the exact worker, without importing provider/bootstrap or real stores.
const source = readFileSync(new URL("../agent-run.mjs", import.meta.url), "utf8");
const child = source.slice(source.indexOf("async function child("), source.indexOf("// Spawn a worker"));
const text = (m) => typeof m?.content === "string" ? m.content : (m?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
const spawn = (name) => answer([call("spawn_agent", { name, task: `Task of ${name}`, area: "source" })], { stopReason: "toolUse" });
function latch() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function worker(t, route, { nudge = () => null, onDrain = () => {} } = {}) {
  const env = { FLEET: "1", FREE_ROAM: "1", ROAM_OPTIONS: "[]", TOUCHSTONE_EXEC: "daytona", DAYTONA_API_KEY: "made-up-test-key", DAYTONA_API_URL: undefined, EVENTS_FILE: undefined };
  const prior = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  const set = (values) => { for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  set(env);
  t.after(() => set(prior));
  const events = [], evidence = [], reports = [], failures = [];
  let drains = 0, defaults = 0, exitCode;
  t.mock.method(console, "log", (line) => { if (line.startsWith("EVENT ")) events.push(JSON.parse(line.slice(6))); });
  const faux = fauxProvider({ tokensPerSecond: 100000 });
  faux.setResponses(Array.from({ length: 100 }, () => (request) => {
    const instructions = request.messages.filter((m) => m.role === "system").map((m) => text(m) + Object.values(m.sections ?? {}).join("\n")).join("\n");
    const who = /You are (?:trusted|free-roam) child (\w+)/.exec(instructions)?.[1] ?? "coordinator";
    if (/^FreeRoam_*$/.test(who)) { defaults++; return answer("Default child done."); }
    return route({ who, last: request.messages.findLast((m) => m.role !== "system") });
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  const fleet = createFleet({ system: "Audit the lab only.", costOf: () => 0, required: false, roamTools: [defineTool({
    name: "shell", description: "Unavailable fake shell.", parameters: obj({}), replay: "safe",
    execute: async () => assert.fail("no remote execution"),
  })] });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "pack", tools: fleet.wrapTools([defineTool({
    name: "read_source", description: "Record fake evidence.", parameters: obj({}), replay: "safe",
    execute: async () => { evidence.push(currentAgent()); return { output: [{ type: "text", text: "Child evidence recorded." }] }; },
  })]) }));
  registry.install(fleet.extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry, settings: { retry: { maxRetries: 0 } }, onReport: (r) => reports.push(r) }, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" }, instructions: fleet.instructions } });
  await fleet.attach(harness, ctx);
  t.after(async () => { await fleet.close(); await harness.close(ctx); });
  const observedFleet = { ...fleet, drain: async (...args) => {
    drains++;
    const pending = fleet.drain(...args);
    onDrain(drains);
    const settled = await pending;
    failures.push((await harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, ctx))?.runFailure);
    return settled;
  } };
  const proc = Object.assign(new EventEmitter(), { env: {}, stdin: new EventEmitter(), exit: () => assert.fail("unexpected process exit") });
  const run = runInNewContext(`${child}; child`, {
    process: proc, ctx, afterNudge,
    auditState: () => ({ found: [], candidates: [], leads: 0 }),
    openHarness: async () => ({ harness, root, fleet: observedFleet, reports, pack: { kickoff: () => "start", nudge } }),
    event: (ev, data) => events.push({ ev, ...data }), disposeAsks: () => {},
    streamCognition: async () => {}, readSteers: () => {},
    summarize: async () => ({ final: { text: "Summary." } }), flushFinal: () => {}, chargeUsage: async () => ({}),
    exitAfterEvents: (code) => { exitCode = code; },
  });
  return { events, evidence, failures, run: () => run([null, null, null, "run", "unused-db", "unused-workspace"]),
    check: () => { assert.equal(exitCode, 0); assert.deepEqual(reports, []); return { drains, defaults }; } };
}

for (const reportFails of [false, true]) test(`runner keeps original failure with held child; reportFails=${reportFails}`, { timeout: 15000 }, async (t) => {
  const started = latch(), held = latch(), draining = latch();
  t.after(() => held.resolve());
  const r = await worker(t, async ({ who, last }) => {
    if (who === "coordinator") {
      if (text(last) === "start") return spawn("Alpha");
      if (last.toolName === "spawn_agent") {
        await started.promise;
        return answer([], { stopReason: "error", errorMessage: "Original coordinator failure" });
      }
      return reportFails ? answer([], { stopReason: "error", errorMessage: "Later report failure" }) : answer("Report received.");
    }
    if (last.role === "user") {
      started.resolve();
      await held.promise;
      return answer([call("read_source", {})], { stopReason: "toolUse" });
    }
    return answer("Child evidence complete.");
  }, { nudge: () => assert.fail("failed run must not nudge"), onDrain: () => draining.resolve() });
  const running = r.run();
  await draining.promise;
  assert.equal(await Promise.race([running.then(() => "settled"), delay(20, "pending")]), "pending");
  held.resolve();
  await running;
  const settled = r.events.find((e) => e.ev === "settled");
  assert.equal(settled.status, "unanswered");
  assert.match(settled.detail, /Original coordinator failure/);
  const counts = r.check();
  assert.equal(counts.defaults, 0, "failure must not start a default child");
  assert.equal(counts.drains, 1, "no new turn means no second drain");
  if (reportFails) assert.match(r.failures[0]?.detail, /Later report failure/);
  else assert.ok(!r.failures[0], "successful report cleared the stored failure");
  const alpha = r.events.find((e) => e.ev === "subagent-spawned" && e.name === "Alpha");
  assert.deepEqual(r.evidence, [alpha.id]);
  assert.ok(r.events.some((e) => e.ev === "subagent-done" && e.id === alpha.id && e.status === "done"));
  assert.equal(r.events.filter((e) => e.ev === "subagent-spawned").length, 1);
});

test("runner drains a held child created by the normal nudge", { timeout: 15000 }, async (t) => {
  const held = latch(), draining = latch();
  t.after(() => held.resolve());
  let nudges = 0;
  const r = await worker(t, async ({ who, last }) => {
    if (who === "coordinator") return text(last) === "Continue" ? spawn("Beta") : answer("Coverage complete.");
    if (last.role === "user") {
      await held.promise;
      return answer([call("read_source", {})], { stopReason: "toolUse" });
    }
    return answer("Nudge child complete.");
  }, { nudge: () => { nudges++; return "Continue"; }, onDrain: (count) => { if (count === 2) draining.resolve(); } });
  const running = r.run();
  await draining.promise;
  assert.equal(await Promise.race([running.then(() => "settled"), delay(20, "pending")]), "pending", "nudge drain waits for its child");
  held.resolve();
  await running;
  assert.equal(nudges, 1);
  assert.deepEqual(r.check(), { drains: 2, defaults: 1 });
  const beta = r.events.find((e) => e.ev === "subagent-spawned" && e.name === "Beta");
  assert.deepEqual(r.evidence, [beta.id]);
  const done = r.events.findIndex((e) => e.ev === "subagent-done" && e.id === beta.id && e.status === "done");
  const settled = r.events.findIndex((e) => e.ev === "settled");
  assert.ok(done >= 0 && done < settled, "nudge child completes before settled is emitted");
  assert.equal(r.events[settled].status, "done");
});
