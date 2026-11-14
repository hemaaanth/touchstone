import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage as answer, fauxProvider, fauxToolCall as call } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createFleet } from "../lib/fleet.mjs";
import { currentAgent, withAgent } from "../lib/event.mjs";
import { roamError } from "../lib/roam-errors.mjs";
import { createRoamControl } from "../lib/roam-control.mjs";
import { roamTools, pauseRoamShell, resumeRoamShell, closeRoamShell } from "../lib/roam.mjs";
import { roamBrowserTools, pauseRoamBrowser, resumeRoamBrowser, closeRoamBrowser } from "../lib/roam-browser.mjs";
import { candidateTool, recordSession, sessionLookup, SESSION_DESCRIPTION, SESSION_POC } from "../lib/candidate.mjs";
import { captureSessionArtifacts, listSessionArtifacts } from "../lib/session-artifacts.mjs";
import { askHumanTool, answerAsk } from "../lib/ask.mjs";
import { createRoamControlApi } from "../../app/server/roam-control.mjs";

const source = readFileSync(new URL("../agent-run.mjs", import.meta.url), "utf8");
const body = source.slice(source.indexOf("function createRuntimeRoam("), source.indexOf("async function openHarness("));
const text = (m) => typeof m?.content === "string" ? m.content : (m?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
function latch() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
const pending = async (promise) => assert.equal(await Promise.race([promise.then(() => "settled"), delay(20, "pending")]), "pending");
const submission = (poc) => ({ poc, title: "An exposed administrative export leaks customer records", severity: "high", explanation: "An unauthenticated caller can retrieve private customer records from the administrative export endpoint. The captured response shows the records. No deterministic proof checks cover this remote session.\nFix: Require authorization before returning the export.", evidence_lines: ["private customer records exposed"] });

function runtime(t, { hooks = {}, isAgent = (id) => id === "a-1" } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "runner-roam-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = { found: [], candidates: [] }, events = [], steps = [], uploads = new Map();
  const machine = { id: `fake-${randomUUID()}`, fresh: true,
    upload: async (file, bytes) => { if (file.endsWith(".json")) uploads.set(file, JSON.parse(bytes)); },
    exec: async (command) => {
      const shell = /^node \/tmp\/touchstone-shell-control\.mjs ([a-f0-9-]+)$/.exec(command);
      if (shell) {
        const q = uploads.get(`/tmp/touchstone-shell-${shell[1]}.json`);
        steps.push(`shell:${q.op}`);
        const override = await hooks[`shell:${q.op}`]?.(q);
        return { exitCode: 0, result: JSON.stringify(override ?? { ok: true, id: q.id, generation: "fake-generation", epoch: q.epoch ?? 0,
          ...(q.op === "run" ? { exitCode: 0, result: "private customer records exposed" } : { ack: true, scope: "managed-shell", state: q.op === "pause" ? "paused" : q.op === "close" ? "closed" : "active" }),
        }) };
      }
      const file = command.match(/\/var\/lib\/touchstone\/session\/request-[a-f0-9]+\.json/)?.[0];
      if (!file) {
        assert.match(command, /nohup node \/opt\/touchstone\/roam\/browser-driver\.mjs serve/);
        return { exitCode: 0, result: "" }; // fixed driver readiness command, never executed
      }
      const q = uploads.get(file);
      steps.push(`browser:${q.action}`);
      const override = await hooks[`browser:${q.action}`]?.(q);
      return { exitCode: 0, result: JSON.stringify(override ?? (q.action === "close"
        ? { ok: true, closed: true, har: null, screenshots: [] }
        : ["pause", "resume", "status"].includes(q.action)
          ? { ok: true, paused: q.action === "pause", active: false, closed: false, failed: false }
          : { ok: true, title: "Export", url: "https://example.test/export", text: "private customer records exposed", status: 200 })) };
    },
  };
  const env = { ROAM_CONTROL_EPOCH: "worker-test", SESSION_ARTIFACT_DIR: root };
  const create = runInNewContext(`${body}; createRuntimeRoam`, {
    process: { env }, path, randomUUID, currentAgent, roamError,
    createRoamControl, roamTools, roamBrowserTools, pauseRoamShell, resumeRoamShell, closeRoamShell,
    pauseRoamBrowser, resumeRoamBrowser, closeRoamBrowser, candidateTool, recordSession, sessionLookup,
    SESSION_DESCRIPTION, SESSION_POC, captureSessionArtifacts,
    EGRESS_ENV: "", startEgressLog: async () => {}, pullEgressLog: async () => [],
    roamMachine: async () => { steps.push("machine"); await hooks.machine?.(); return machine; },
    event: (ev, data) => { const e = { ev, ...data }; events.push(e); hooks.event?.(e); },
  });
  const r = create("run-fixture.v4.sqlite", "unused-workspace", state, { pack: "web", isAgent });
  t.after(() => r.control.dispose());
  const execute = (name, args = {}, agent = "a-1") => withAgent(agent, () => r.tools.find((tool) => tool.name === name).execute(args, {}, ctx));
  return { ...r, root, state, events, steps, execute, env };
}

test("pause before the first action blocks all roam tools but not shared Ask", async (t) => {
  const r = runtime(t);
  assert.deepEqual(r.steps, []);
  await r.control.pause("a-1", "lease");
  for (const name of ["shell", "browse", "submit_session_candidate"]) await assert.rejects(r.execute(name), /ROAM_PAUSED/);
  const asks = [];
  t.mock.method(console, "log", (line) => { if (line.startsWith("EVENT ")) asks.push(JSON.parse(line.slice(6))); });
  const asking = withAgent("a-1", () => askHumanTool.execute({ kind: "question", question: "Continue the audit?" }, { conversationId: 1 }, ctx));
  const ask = asks.find((e) => e.ev === "ask-human");
  assert.ok(ask);
  await r.control.resume("a-1", "lease");
  await r.control.pause("a-1", "lease-2");
  await pending(asking);
  assert.equal(answerAsk({ ask: ask.id, done: true }), true);
  await asking;
  await r.control.resume("a-1", "lease-2");
  const output = await r.execute("browse", { action: "read" });
  assert.match(output.output[0].text, /private customer records exposed/);
  assert.equal(r.steps.filter((s) => s === "machine").length, 1);
});

for (const name of ["shell", "browse"]) test(`pause waits for active ${name}, rejects queued work, and waits for both remote acks`, async (t) => {
  const active = latch(), release = latch(), shellPause = latch(), finishPause = latch();
  t.after(() => { release.resolve(); finishPause.resolve(); });
  const r = runtime(t, { hooks: {
    [name === "shell" ? "shell:run" : "browser:read"]: async () => { active.resolve(); await release.promise; },
    "shell:pause": async () => { shellPause.resolve(); await finishPause.promise; },
  } });
  const running = r.execute(name, name === "shell" ? { command: "fake" } : { action: "read" });
  await active.promise;
  const queuedBrowser = assert.rejects(r.execute("browse", { action: "read" }), /ROAM_PAUSED/);
  const queuedSubmit = assert.rejects(r.execute("submit_session_candidate", submission("session:a-1:1")), /ROAM_PAUSED/);
  const pausing = r.control.handle({ roamControl: { id: "pause-1", epoch: "worker-test", agent: "a-1", op: "pause", lease: "lease" } });
  await Promise.all([queuedBrowser, queuedSubmit]);
  await assert.rejects(r.execute("shell", { command: "new" }), /ROAM_PAUSED/);
  await pending(pausing);
  assert.ok(!r.steps.includes("browser:pause"));
  release.resolve();
  await running;
  await shellPause.promise;
  await pending(pausing);
  assert.deepEqual(r.events, []);
  finishPause.resolve();
  await pausing;
  assert.equal(r.events[0].state, "paused");
  assert.equal(r.events[0].ok, true);
  assert.equal(r.steps.filter((s) => s === "browser:read").length, name === "browse" ? 1 : 0);
  assert.deepEqual(r.state.candidates, []);
});

for (const bad of ["browser", "shell"]) test(`${bad} pause uncertainty remains latched`, async (t) => {
  const r = runtime(t, { hooks: { [`${bad}:pause`]: async () => bad === "browser"
    ? { ok: true, paused: true, active: true, closed: false, failed: false }
    : { ok: false, error: "private failure must not escape" } } });
  await assert.rejects(r.control.pause("a-1", "lease"), /ROAM_PAUSE_FAILED/);
  await assert.rejects(r.control.resume("a-1", "lease"), /ROAM_NOT_PAUSED/);
  await assert.rejects(r.execute("browse", { action: "read" }), /ROAM_PAUSED/);
  await r.control.handle({ roamControl: { id: "status", epoch: "worker-test", agent: "a-1", op: "status" } });
  assert.equal(r.events.at(-1).state, "failed");
  assert.ok(!JSON.stringify(r.events).includes("private failure"));
});

for (const action of ["dispose", "cancel"]) test(`${action} fences an in-flight resume and closes remote automation before resolving`, { timeout: 5000 }, async (t) => {
  const resuming = latch(), release = latch();
  t.after(() => release.resolve());
  const r = runtime(t, { hooks: { "browser:resume": async () => { resuming.resolve(); await release.promise; } } });
  await r.control.pause("a-1", "lease");
  const error = action === "dispose" ? /ROAM_DISPOSED/ : /ROAM_CLOSED/;
  const resumed = assert.rejects(r.control.resume("a-1", "lease"), error);
  await resuming.promise;
  const disposing = action === "dispose" ? r.control.dispose() : r.control.cancel("a-1", "lease");
  await resumed;
  await assert.rejects(r.execute("shell", { command: "new" }), error);
  await pending(disposing);
  release.resolve();
  await disposing;
  assert.ok(r.steps.indexOf("browser:close") > r.steps.indexOf("browser:resume"));
  assert.ok(r.steps.indexOf("shell:close") > r.steps.indexOf("shell:resume"));
  assert.equal(r.steps.filter((s) => s === "browser:resume").length, 1);
});

test("uncertain remote close never acknowledges successful cancellation", async (t) => {
  const r = runtime(t, { hooks: { "browser:close": async () => ({ ok: false, error: "BROWSER_FAILED" }) } });
  await r.control.pause("a-1", "lease");
  await r.control.handle({ roamControl: { id: "cancel", epoch: "worker-test", agent: "a-1", op: "cancel", lease: "lease" } });
  assert.equal(r.events.at(-1).ok, false);
  assert.equal(r.events.at(-1).error, "ROAM_CANCEL_FAILED");
  await assert.rejects(r.control.resume("a-1", "lease"), /ROAM_CLOSED/);
  await assert.rejects(r.execute("browse", { action: "read" }), /ROAM_CLOSED/);
  const cleanup = await r.control.dispose();
  assert.equal(cleanup[0].status, "rejected", "disposal does not establish physical cleanup success");
});

test("session submission snapshots under the gate and rejection does not close browsing", async (t) => {
  const r = runtime(t);
  await r.execute("browse", { action: "read" });
  const poc = "session:a-1:1";
  const rejected = await r.execute("submit_session_candidate", { ...submission(poc), evidence_lines: ["not captured"] });
  assert.match(rejected.output[0].text, /refus|not|match/i);
  assert.equal(r.state.candidates.length, 0);
  await r.execute("browse", { action: "read" });
  assert.ok(!r.steps.includes("browser:close"));
  const accepted = await r.execute("submit_session_candidate", submission("session:a-1:2"));
  assert.match(accepted.output[0].text, /Recorded candidate/);
  assert.equal(r.state.candidates.length, 1);
  assert.equal(r.state.candidates[0].proven, false);
  const manifest = listSessionArtifacts(r.root, { run: "fixture.v4", agent: "a-1", poc: "session:a-1:2" });
  assert.deepEqual(manifest.files.map((f) => f.kind), ["transcript"]);
  assert.equal(r.state.candidates[0].evidence.artifacts.poc, "session:a-1:2");
});

test("real fleet grants browse only to its trusted free-roam child", async (t) => {
  const env = { FLEET: "1", FREE_ROAM: "1", ROAM_OPTIONS: "[]", TOUCHSTONE_EXEC: "daytona", DAYTONA_API_KEY: "made-up-runtime-test-key", EVENTS_FILE: undefined };
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  const set = (values) => { for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  set(env); t.after(() => set(old));
  let fleet;
  const r = runtime(t, { isAgent: (id) => fleet?.isRoamAgent(id) === true });
  fleet = createFleet({ system: "Audit only the fake target.", costOf: () => 0, required: false, roamTools: r.tools, sharedTools: [askHumanTool] });
  const lists = new Map(), faux = fauxProvider({ tokensPerSecond: 100000 });
  faux.setResponses(Array.from({ length: 30 }, () => (request) => {
    const systems = request.messages.filter((m) => m.role === "system");
    const instructions = systems.map((m) => text(m) + Object.values(m.sections ?? {}).join("\n")).join("\n");
    const who = /You are (?:trusted|free-roam) child (\w+)/.exec(instructions)?.[1] ?? "coordinator";
    const names = new Set();
    for (const m of systems) { for (const tool of m.toolsRemoved ?? []) names.delete(tool.name); for (const tool of m.toolsAdded ?? []) names.add(tool.name); }
    lists.set(who, names);
    const last = request.messages.findLast((m) => m.role !== "system");
    if (who === "coordinator" && text(last) === "start") return answer([call("spawn_agent", { name: "Confined", task: "Read local evidence", area: "source" })], { stopReason: "toolUse" });
    if (who === "FreeRoam" && last.role === "user") return answer([call("browse", { action: "read" })], { stopReason: "toolUse" });
    return answer("Done.");
  }));
  const models = createModels(); models.setProvider(faux.provider);
  const registry = createRegistry(); registry.install(defineExtension({ name: "pack", tools: fleet.wrapTools([]) })); registry.install(fleet.extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry, settings: { retry: { maxRetries: 0 } } }, ctx);
  t.after(async () => { await r.control.dispose(); await fleet.close(); await harness.close(ctx); });
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" }, instructions: fleet.instructions, tools: { remove: [...r.tools] } } });
  await fleet.attach(harness, ctx);
  await (await root.submit({ type: "input", content: "start" }, ctx)).wait(ctx);
  await fleet.drain(ctx);
  assert.equal(lists.get("coordinator").has("browse"), false);
  assert.equal(lists.get("Confined").has("browse"), false);
  assert.equal(lists.get("FreeRoam").has("browse"), true);
  assert.equal(r.steps.filter((s) => s === "browser:read").length, 1);
  await assert.rejects(r.execute("browse", { action: "read" }, "a-unknown"), /ROAM_AGENT/);
  await assert.rejects(r.execute("browse", { action: "read" }, null), /ROAM_AGENT/);
});

test("shell, browse, and session submission share one ordered gate", async (t) => {
  const started = latch(), release = latch();
  t.after(() => release.resolve());
  const r = runtime(t, { hooks: { "shell:run": async () => { started.resolve(); await release.promise; } } });
  const shell = r.execute("shell", { command: "fake" });
  await started.promise;
  const browse = r.execute("browse", { action: "read" });
  const submit = r.execute("submit_session_candidate", submission("session:a-1:2"));
  await pending(browse);
  assert.equal(r.state.candidates.length, 0);
  assert.ok(!r.steps.includes("browser:read"));
  release.resolve();
  await Promise.all([shell, browse, submit]);
  assert.equal(r.state.candidates.length, 1);
  assert.equal(r.state.candidates[0].proven, false);
});

test("missing session artifact root refuses submission without accepting a candidate", async (t) => {
  const r = runtime(t);
  await r.execute("browse", { action: "read" });
  delete r.env.SESSION_ARTIFACT_DIR;
  await assert.rejects(r.execute("submit_session_candidate", submission("session:a-1:1")), /ROAM_SESSION_SNAPSHOT_UNAVAILABLE/);
  assert.equal(r.state.candidates.length, 0);
  r.env.SESSION_ARTIFACT_DIR = r.root;
  await r.execute("submit_session_candidate", submission("session:a-1:1"));
  assert.equal(r.state.candidates.length, 1);
});

test("failed resume cannot be retried into running automation", async (t) => {
  const r = runtime(t, { hooks: { "browser:resume": async () => ({ ok: false, error: "unknown state" }) } });
  await r.control.pause("a-1", "lease");
  await assert.rejects(r.control.resume("a-1", "lease"), /ROAM_RESUME_FAILED/);
  await assert.rejects(r.control.resume("a-1", "lease"), /ROAM_RESUME_FAILED/);
  await assert.rejects(r.execute("shell", { command: "new" }), /ROAM_PAUSED/);
  assert.equal(r.steps.filter((s) => s === "browser:resume").length, 1);
});

for (const outcome of ["resume", "revoke-fails", "worker-loss"]) test(`APP viewer cleanup precedes runtime resume: ${outcome}`, async (t) => {
  let api, cleanup = false;
  const revoked = latch(), release = latch(), order = [];
  t.after(() => release.resolve());
  const run = { id: "fixture", owner: true, status: "running", ws: "fake", roamEpoch: "worker-test", events: [{ ev: "subagent-spawned", id: "a-1", loadout: "free-roam", t: 1 }] };
  const r = runtime(t, { hooks: { event: (e) => api.consume(run, run.child, run.roamEpoch, e), "browser:resume": () => { order.push("resume"); } } });
  run.child = { stdin: { writable: true, write(line, callback) { void r.control.handle(JSON.parse(line)); callback?.(); } } };
  const expires = Date.now() + 60000;
  const machine = {
    request: async (bytes) => {
      const q = JSON.parse(bytes);
      if (q.action === "configure") return { kind: "configured", port: 6080, expires };
      if (q.action === "open") return { kind: "open", port: 6080, viewOnly: q.viewOnly, expires };
      assert.equal(q.action, "close"); order.push("viewer-close"); return { kind: "closed" };
    },
    previewGrant: async () => ({ url: "https://preview.example.test/", expires, revokeToken: "fake-revoke" }),
    expirePreview: async () => {
      if (cleanup) { revoked.resolve(); await release.promise; if (outcome === "revoke-fails") throw new Error("fake revocation failure"); }
      order.push("revoked");
    },
  };
  api = createRoamControlApi({ getRun: () => run, emit: () => {}, machine: async () => machine });
  api.begin(run, run.child, run.roamEpoch);
  t.after(() => api.invalidate(run).catch(() => {}));
  await api.desktop(run.id, "a-1", true, "https://console.example.test", { id: "desktop-test" });
  await api.desktop(run.id, "a-1", false, "https://console.example.test", { id: "desktop-test" });
  order.length = 0; cleanup = true;
  const closing = outcome === "worker-loss" ? api.invalidate(run) : api.close(run.id, "a-1", { id: "desktop-test" });
  const checked = outcome === "revoke-fails" ? assert.rejects(closing, /cleanup failed/) : closing;
  await revoked.promise;
  assert.ok(order.includes("viewer-close"));
  assert.ok(!order.includes("resume"));
  await assert.rejects(r.execute("browse", { action: "read" }), /ROAM_PAUSED/);
  release.resolve();
  await checked;
  if (outcome === "resume") {
    assert.ok(order.indexOf("resume") > order.indexOf("revoked"));
    await r.execute("browse", { action: "read" });
  } else {
    assert.ok(!order.includes("resume"));
    await assert.rejects(r.execute("browse", { action: "read" }), /ROAM_PAUSED/);
  }
});


test("a failed initial machine open can be retried by the same child", async (t) => {
  let opens = 0;
  const r = runtime(t, { hooks: { machine: () => { if (++opens === 1) throw new Error("private provider detail"); } } });
  await assert.rejects(r.execute("shell", { command: "true" }), /ROAM_MACHINE_UNAVAILABLE/);
  assert.match((await r.execute("shell", { command: "true" })).output[0].text, /exit 0/);
  assert.equal(opens, 2);
});

test("each action resolves the machine again so provider health checks are not bypassed", async (t) => {
  const r = runtime(t);
  await r.execute("shell", { command: "true" });
  await r.execute("shell", { command: "true" });
  assert.equal(r.steps.filter((s) => s === "machine").length, 2);
});
