import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage as answer, fauxProvider, fauxToolCall as call } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineDoc, defineExtension, defineTool, Harness, LiveDoc, MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { createFleet, FREE_ROAM_INSTRUCTIONS } from "../lib/fleet.mjs";
import { currentAgent } from "../lib/event.mjs";
import { askHumanTool, answerAsk } from "../lib/ask.mjs";
import { createRoamControl } from "../lib/roam-control.mjs";
import { roamTools } from "../lib/roam.mjs";
import { EGRESS_ENV, startEgressLog, pullEgressLog } from "../lib/roam-egress.mjs";
import { candidateTool, recordSession, sessionLookup, SESSION_DESCRIPTION, SESSION_POC } from "../lib/candidate.mjs";

// Per-agent loadouts (I7a). Fake tools or a fake machine: no Daytona call, no
// network, no real key. "Daytona on" is two env values with a made-up key.
const ON = { FLEET: undefined, FLEET_MAX: undefined, ROAM_OPTIONS: undefined, FREE_ROAM: "1", TOUCHSTONE_EXEC: "daytona", DAYTONA_API_KEY: "made-up-test-key", DAYTONA_API_URL: undefined };
const PACK = ["read_source", "submit_finding_web", "submit_finding_contracts"]; // a joined run of two modules
const ROAM = ["shell", "submit_session_candidate"];
const ORIGINAL = Object.fromEntries(Object.keys(ON).map((k) => [k, process.env[k]]));
const Roster = defineDoc({ kind: "touchstone.fleet", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ agents: [], jobs: {}, bulletin: [] }), checkpointWhen: () => false });

const result = (blocks) => answer(blocks, { stopReason: "toolUse" });
const text = (message) => typeof message?.content === "string" ? message.content : (message?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
const spawnCall = (name, loadout) => call("spawn_agent", { name, task: `Task of ${name}`, area: name.toLowerCase(), ...(loadout ? { loadout } : {}) });

// What one model request holds: the last message, the instructions, and the
// names of the tools the model may call.
function seen(request) {
  const system = request.messages.filter((m) => m.role === "system");
  const tools = new Set();
  for (const m of system) {
    for (const t of m.toolsRemoved ?? []) tools.delete(t.name);
    for (const t of m.toolsAdded ?? []) tools.add(t.name);
  }
  const instructions = system.map((m) => text(m) + Object.values(m.sections ?? {}).join("\n")).join("\n");
  const child = /You are (?:trusted|free-roam) child (\w+)/.exec(instructions)?.[1];
  return { last: request.messages.findLast((m) => m.role !== "system"), instructions, tools: [...tools], who: child ?? "coordinator" };
}

// One worker of a run. `storage` and `pack` let a case open a second worker on
// the same run, with another environment or another pack tool list.
async function runtime(t, route, { env = ON, required = false, survey, hooks = {}, storage = new MemoryStorage(), pack = PACK, offered, sharedTools = [], max, defaultRoute = () => answer("Default child done.") } = {}) {
  const set = (values) => { for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  set(env);
  t.after(() => set(ORIGINAL));
  const events = [], reports = [], ran = [], lists = {};
  t.mock.method(console, "log", (line) => { if (line.startsWith("EVENT ")) { const e = JSON.parse(line.slice(6)); events.push(e); hooks.event?.(e); } });
  // Each fake records who ran it. `hooks[name]` lets one case hold a call open.
  const fake = (name) => defineTool({
    name, description: `Fake ${name}.`, parameters: obj({}), replay: "safe",
    execute: async (args, api, c) => { ran.push(`${currentAgent() ?? "coordinator"}:${name}`); await hooks[name]?.(args, api, c); return { output: [{ type: "text", text: `${name} ran.` }] }; },
  });
  const packTools = pack.map(fake), roamTools = offered ?? ROAM.map(fake);
  const faux = fauxProvider({ tokensPerSecond: 100000 });
  faux.setResponses(Array.from({ length: 150 }, () => (request) => { const s = seen(request); lists[s.who] = s.tools; return /^FreeRoam_*$/.test(s.who) ? defaultRoute(s) : route(s); }));
  const models = createModels();
  models.setProvider(faux.provider);
  const fleet = createFleet({ system: "Audit the lab only.", costOf: () => 0, max, required, survey, roamTools, sharedTools });
  const registry = createRegistry();
  // The same wiring as agent-run.mjs: the pack extension, then the fleet's own.
  registry.install(defineExtension({ name: "pack", tools: fleet ? fleet.wrapTools(packTools) : packTools }));
  if (fleet) registry.install(fleet.extension);
  else registry.install(defineExtension({ name: "shared", tools: sharedTools }));
  const harness = await Harness.open(storage, { models, registry, settings: { retry: { maxRetries: 0 } }, onReport: (r) => reports.push(r) }, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" }, instructions: fleet ? fleet.instructions : "Audit the lab only." } });
  await fleet?.attach(harness, ctx);
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await fleet?.close(); await harness.close(ctx); };
  t.after(close);
  async function run(content) {
    let settled = await (await root.submit({ type: "input", content }, ctx)).wait(ctx);
    settled = await fleet?.drain(ctx) ?? settled;
    assert.deepEqual(reports, []);
    return settled;
  }
  const results = async (conv, tool) => (await (conv === undefined ? root : await harness.conversation(Number(conv), ctx)).context(ctx)).messages.filter((m) => m.role === "toolResult" && m.toolName === tool);
  const spawned = (name) => events.find((e) => e.ev === "subagent-spawned" && e.name === name);
  // The wrapped roam tool, called with no model in between, as conversation `conv`.
  const direct = (name, conv) => fleet.extension.tools.find((tool) => tool.name === name).execute({}, { conversationId: conv, snapshot: (doc, id, c) => harness.snapshot(doc, id, c) }, ctx);
  return { events, fleet, harness, run, ran, lists, results, spawned, direct, close };
}

// A run that a second worker continues: one SQLite file for both.
async function shared(t) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-loadout-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
  return () => openNodeSqliteStorage(join(dir, "session.sqlite"));
}
// For two workers: "start" spawns the child, "go on" sends it one more message.
const twoWorkers = (name, loadout, childCalls) => (s) => {
  if (s.who === "coordinator") {
    if (text(s.last) === "start") return result([spawnCall(name, loadout)]);
    if (text(s.last) === "go on") return result([call("message_agent", { to: name, text: "Go on." })]);
    return answer("Coverage complete.");
  }
  return s.last.role === "user" && text(s.last).includes("Go on.") ? result(childCalls.map((n) => call(n, {}))) : answer("Done.");
};

// A coordinator that spawns the given children on "start", then ends.
const coordinator = (s, children) => text(s.last) === "start" ? result(children) : answer("Coverage complete.");

test("the default admits fifty lifetime children across loadouts, refuses the fifty-first, and reuses a failed identity", { timeout: 60000 }, async (t) => {
  const r = await runtime(t, (s) => {
    if (s.who === "coordinator") {
      if (text(s.last) === "start") return result(Array.from({ length: 51 }, (_, i) => spawnCall(`Child${i}`, i % 2 ? "confined" : "free-roam")));
      if (text(s.last) === "overflow") return result([spawnCall("Overflow", "free-roam")]);
      if (text(s.last) === "retry") return result([call("message_agent", { to: "Child3", text: "retry the assigned task" })]);
      return answer("Report received.");
    }
    if (s.who === "Child3" && !text(s.last).includes("retry")) return answer([], { stopReason: "error", errorMessage: "Synthetic child failure" });
    return answer("Child done.");
  });
  await r.run("start");
  const board = await r.harness.snapshot(Roster, ROOT_CONVERSATION_ID, ctx);
  assert.equal(board.agents.length, 50);
  assert.equal(board.agents.filter((a) => a.loadout === "free-roam").length, 25);
  assert.equal(board.agents.filter((a) => a.loadout === "confined").length, 25);
  assert.equal(board.agents.filter((a) => a.status === "done").length, 49);
  assert.equal(board.agents.find((a) => a.name === "Child3").status, "failed");
  assert.deepEqual((await r.results(undefined, "spawn_agent")).map((m) => !!m.isError), [...Array(50).fill(false), true]);
  assert.match(text((await r.results(undefined, "spawn_agent")).at(-1)), /Fleet limit reached \(50\)/);
  assert.equal(r.spawned("FreeRoam"), undefined, "explicit free-roam children suppress the fallback");
  await r.run("overflow");
  assert.match(text((await r.results(undefined, "spawn_agent")).at(-1)), /Fleet limit reached \(50\)/, "finished and failed children still occupy their slots");
  await r.run("retry");
  const retried = await r.harness.snapshot(Roster, ROOT_CONVERSATION_ID, ctx);
  assert.deepEqual(retried.agents.map((a) => a.id), board.agents.map((a) => a.id));
  assert.equal(retried.agents.find((a) => a.name === "Child3").status, "done");
  assert.equal(r.events.filter((e) => e.ev === "subagent-spawned").length, 50);
});

test("environment and explicit maximum keep their admission precedence", async (t) => {
  for (const [label, envMax, max, admitted] of [
    ["environment", "3", undefined, 3],
    ["explicit beats environment", "3", 2, 2],
    ["explicit beats invalid environment", "invalid", "2", 2],
  ]) await t.test(label, async (t) => {
    const r = await runtime(t, (s) => s.who === "coordinator"
      ? coordinator(s, Array.from({ length: admitted + 1 }, (_, i) => spawnCall(`Child${i}`, i % 2 ? "confined" : "free-roam")))
      : answer("Done."), { env: { ...ON, FLEET_MAX: envMax }, max });
    await r.run("start");
    assert.equal((await r.harness.snapshot(Roster, ROOT_CONVERSATION_ID, ctx)).agents.length, admitted);
    const results = await r.results(undefined, "spawn_agent");
    assert.deepEqual(results.map((m) => !!m.isError), [...Array(admitted).fill(false), true]);
    assert.match(text(results.at(-1)), new RegExp(`Fleet limit reached \\(${admitted}\\)`));
  });
});

test("invalid explicit and environment maxima fail before any provider or machine call", async (t) => {
  for (const value of [0, -1, 1.5, "", "invalid", "Infinity"]) {
    for (const source of ["explicit", "environment"]) await t.test(`${source}: ${JSON.stringify(value)}`, async (t) => {
      await assert.rejects(runtime(t, () => assert.fail("no provider call"), {
        env: { ...ON, ...(source === "environment" ? { FLEET_MAX: String(value) } : {}) },
        ...(source === "explicit" ? { max: value } : {}),
        offered: [defineTool({ name: "shell", description: "Never run.", parameters: obj({}), replay: "safe", execute: () => assert.fail("no machine call") })],
      }), /FLEET_MAX must be a positive integer/);
    });
  }
});

test("a confined child has no roam tool, and it cannot call one", { timeout: 15000 }, async (t) => {
  const r = await runtime(t, (s) => {
    if (s.who === "coordinator") return coordinator(s, [spawnCall("Alpha")]);
    // The model asks for a tool it was not given.
    if (s.last.role === "user") return result([call("shell", {}), call("read_source", {})]);
    return answer("Done.");
  });
  assert.equal((await r.run("start")).status, "done");
  assert.deepEqual(r.lists.Alpha.filter((n) => ROAM.includes(n)), []);
  assert.deepEqual(PACK.filter((n) => !r.lists.Alpha.includes(n)), [], "a confined child keeps every pack tool");
  const alpha = r.spawned("Alpha");
  assert.deepEqual([alpha.loadout, alpha.tier], ["confined", "T1"], "the default loadout is confined");
  const shell = await r.results(alpha.conv, "shell");
  assert.equal(shell.length, 1);
  assert.ok(shell[0].isError);
  assert.match(text(shell[0]), /not available/);
  assert.deepEqual(r.ran, [`${alpha.id}:read_source`], "the fake shell never ran");
  // The second guard, with the tool removal out of the way.
  await assert.rejects(r.direct("shell", Number(alpha.conv)), /only for a free-roam child/);
  await assert.rejects(r.direct("submit_session_candidate", Number(alpha.conv)), /only for a free-roam child/);
  assert.deepEqual(r.ran, [`${alpha.id}:read_source`]);
});

test("the coordinator cannot call a roam tool, and a refused call is not a survey call", { timeout: 15000 }, async (t) => {
  const r = await runtime(t, (s) => {
    if (s.who !== "coordinator") return answer("Done.");
    if (text(s.last) === "start") return result([call("shell", {}), call("shell", {})]);
    if (s.last.toolName === "shell") return result([call("read_source", {})]);
    if (s.last.toolName === "read_source") return result([spawnCall("Alpha")]);
    return answer("Coverage complete.");
  }, { required: true, survey: 1 });
  assert.equal((await r.run("start")).status, "done");
  const shell = await r.results(undefined, "shell");
  assert.equal(shell.length, 2);
  assert.ok(shell.every((m) => m.isError && /only for a free-roam child/.test(text(m))));
  // Two refused roam calls did not use up the survey limit of one pack call.
  assert.deepEqual((await r.results(undefined, "read_source")).map((m) => !!m.isError), [false]);
  assert.deepEqual(r.ran, ["coordinator:read_source"], "the fake shell never ran");
  await assert.rejects(r.direct("shell", ROOT_CONVERSATION_ID), /only for a free-roam child/);
  assert.deepEqual(r.ran, ["coordinator:read_source"]);
});

// The fleet is not told the pack tool list: the child's tools are an allow list.
test("a free-roam child has no pack tool, so no submit_finding in any form, and it cannot call one", { timeout: 15000 }, async (t) => {
  const r = await runtime(t, (s) => {
    if (s.who === "coordinator") return coordinator(s, [spawnCall("Beta", "free-roam")]);
    if (s.last.role === "user") return result([call("submit_finding_web", {}), call("submit_finding_contracts", {}), call("read_source", {}), call("shell", {}), call("submit_session_candidate", {})]);
    return answer("Done.");
  });
  assert.equal((await r.run("start")).status, "done");
  assert.deepEqual(r.lists.Beta.toSorted(), ["bulletin_post", "bulletin_read", "message_agent", "shell", "submit_session_candidate"]);
  assert.deepEqual(r.lists.Beta.filter((n) => PACK.includes(n) || n.startsWith("submit_finding")), []);
  const beta = r.spawned("Beta");
  for (const name of PACK) {
    const refused = await r.results(beta.conv, name);
    assert.equal(refused.length, 1, name);
    assert.ok(refused[0].isError && /not available/.test(text(refused[0])), name);
  }
  // Only its own tools ran, and each one as this child.
  assert.deepEqual(r.ran, [`${beta.id}:shell`, `${beta.id}:submit_session_candidate`]);
  assert.deepEqual((await r.results(beta.conv, "shell")).map((m) => !!m.isError), [false]);
  // The coordinator's list has the roam tools, but the guard refuses it (the case above).
  assert.ok(ROAM.every((n) => r.lists.coordinator.includes(n)));
  assert.ok(r.fleet.instructions.endsWith(FREE_ROAM_INSTRUCTIONS));
});

test("free-roam is refused without FREE_ROAM=1", { timeout: 15000 }, async (t) => {
  for (const [label, env] of [["no FREE_ROAM", { ...ON, FREE_ROAM: undefined }], ["FREE_ROAM=0", { ...ON, FREE_ROAM: "0" }]]) {
    await t.test(label, async (t) => {
      const r = await runtime(t, (s) => s.who === "coordinator" ? coordinator(s, [spawnCall("Beta", "free-roam")]) : answer("Done."), { env });
      assert.equal((await r.run("start")).status, "done");
      const spawn = await r.results(undefined, "spawn_agent");
      assert.equal(spawn.length, 1);
      assert.ok(spawn[0].isError);
      assert.match(text(spawn[0]), /Free-roam is off/);
      // Nothing was spawned, and no roam tool was installed for anyone.
      assert.equal(r.spawned("Beta"), undefined);
      assert.deepEqual((await r.harness.snapshot(Roster, ROOT_CONVERSATION_ID, ctx))?.agents ?? [], []);
      assert.deepEqual(r.lists.coordinator.filter((n) => ROAM.includes(n)), []);
      assert.ok(!r.fleet.instructions.includes(FREE_ROAM_INSTRUCTIONS));
      assert.deepEqual(r.ran, []);
    });
  }
});

test("with FLEET=0 and FREE_ROAM=0 the tool list has no shell", { timeout: 15000 }, async (t) => {
  const r = await runtime(t, (s) => s.last.role === "user" ? result([call("shell", {})]) : answer("Single agent done."), { env: { ...ON, FLEET: "0", FREE_ROAM: "0" } });
  assert.equal(r.fleet, undefined);
  assert.equal((await r.run("start")).status, "done");
  assert.deepEqual(r.lists.coordinator, PACK);
  assert.ok((await r.results(undefined, "shell")).every((m) => m.isError));
  assert.deepEqual(r.ran, []);
  // agent-run.mjs runs on import, so its wiring is pinned by its source: only
  // the shared solo tool is installed separately from the pack.
  const src = readFileSync(new URL("../agent-run.mjs", import.meta.url), "utf8");
  assert.deepEqual(src.match(/registry\.install\([^\n]*/g), [
    "registry.install(defineExtension({ name: pack.id, tools: fleet ? fleet.wrapTools(tools) : tools }));",
    "registry.install(fleet.extension);",
    'registry.install(defineExtension({ name: "shared", tools: [askHumanTool, ideaTool(state)] }));',
  ]);
});

test("a free-roam child cannot run a pack tool that a later worker adds", { timeout: 20000 }, async (t) => {
  const open = await shared(t);
  const route = twoWorkers("Beta", "free-roam", ["submit_finding_review", "submit_finding_web", "shell"]);
  let w = await runtime(t, route, { storage: await open() });
  await w.run("start");
  const beta = w.spawned("Beta");
  await w.close();
  // The next worker of the run has one more pack tool.
  w = await runtime(t, route, { storage: await open(), pack: [...PACK, "submit_finding_review"] });
  await w.run("go on");
  assert.ok(w.lists.coordinator.includes("submit_finding_review"), "the new pack tool is installed in this worker");
  assert.deepEqual(w.lists.Beta.toSorted(), ["bulletin_post", "bulletin_read", "message_agent", "shell", "submit_session_candidate"]);
  for (const name of ["submit_finding_review", "submit_finding_web"]) {
    const refused = await w.results(beta.conv, name);
    assert.equal(refused.length, 1, name);
    assert.ok(refused[0].isError && /not available/.test(text(refused[0])), name);
  }
  assert.deepEqual(w.ran, [`${beta.id}:shell`]);
});

test("a confined child does not see a roam tool when a later worker has FREE_ROAM=1", { timeout: 20000 }, async (t) => {
  const open = await shared(t);
  const route = twoWorkers("Alpha", undefined, ["shell", "submit_session_candidate", "read_source"]);
  // Free-roam is off in the worker that spawns the child.
  let w = await runtime(t, route, { storage: await open(), env: { ...ON, FREE_ROAM: undefined } });
  await w.run("start");
  const alpha = w.spawned("Alpha");
  assert.deepEqual(w.lists.coordinator.filter((n) => ROAM.includes(n)), []);
  await w.close();
  w = await runtime(t, route, { storage: await open() });
  await w.run("go on");
  assert.ok(ROAM.every((n) => w.lists.coordinator.includes(n)), "the roam tools are installed in this worker");
  assert.deepEqual(w.lists.Alpha.filter((n) => ROAM.includes(n)), []);
  // Refused as a tool it does not have, before the board guard.
  for (const name of ROAM) {
    const refused = await w.results(alpha.conv, name);
    assert.equal(refused.length, 1, name);
    assert.ok(refused[0].isError && /not available/.test(text(refused[0])), name);
  }
  assert.deepEqual(w.ran, [`${alpha.id}:read_source`]);
});

test("a roam tool call does not wait for a pack tool call that is held open", { timeout: 15000 }, async (t) => {
  // read_source stays open until shell has run. shell waits until read_source is
  // open. If shell were in the pack queue, each would wait for the other; the
  // two-second limit then ends both, in the wrong order, and the run does not hang.
  const limit = () => delay(2000, undefined, { ref: false });
  let open, shut, order = [];
  const opened = new Promise((resolve) => { open = resolve; });
  const closed = new Promise((resolve) => { shut = resolve; });
  const hooks = {
    read_source: async () => { order.push("read open"); open(); await Promise.race([closed, limit()]); order.push("read done"); },
    shell: async () => { await Promise.race([opened, limit()]); order.push("shell ran"); shut(); },
  };
  const r = await runtime(t, (s) => {
    if (s.who === "coordinator") return coordinator(s, [spawnCall("Alpha"), spawnCall("Beta", "free-roam")]);
    if (s.last.role === "user") return result([call(s.who === "Alpha" ? "read_source" : "shell", {})]);
    return answer("Done.");
  }, { hooks });
  assert.equal((await r.run("start")).status, "done");
  assert.deepEqual(order, ["read open", "shell ran", "read done"]);
});

test("the spawn event carries the loadout and tier T2, and a free-roam post is evidence", { timeout: 15000 }, async (t) => {
  const told = {};
  const r = await runtime(t, (s) => {
    if (s.who === "coordinator") return coordinator(s, [spawnCall("Alpha", "confined"), spawnCall("Beta", "free-roam")]);
    told[s.who] = s.instructions;
    if (s.last.role === "user") return result([call("bulletin_post", { text: `Note of ${s.who}`, kind: "note" })]);
    return answer("Done.");
  });
  assert.equal((await r.run("start")).status, "done");
  const alpha = r.spawned("Alpha"), beta = r.spawned("Beta");
  assert.deepEqual([alpha.loadout, alpha.tier], ["confined", "T1"]);
  assert.deepEqual([beta.loadout, beta.tier], ["free-roam", "T2"]);
  const posts = r.events.filter((e) => e.ev === "bulletin-post");
  assert.deepEqual(posts.map((p) => [p.author, p.lane]).toSorted(), [[alpha.id, "trusted"], [beta.id, "evidence"]].toSorted());
  // The board is the source of truth for both.
  const board = await r.harness.snapshot(Roster, ROOT_CONVERSATION_ID, ctx);
  assert.deepEqual(board.agents.map((a) => [a.name, a.loadout]), [["Alpha", "confined"], ["Beta", "free-roam"]]);
  assert.deepEqual(board.bulletin.map((n) => [n.author, n.lane]).toSorted(), [[alpha.id, "trusted"], [beta.id, "evidence"]].toSorted());
  // A free-roam child is not told that it is trusted.
  assert.match(told.Alpha, /You are trusted child Alpha/);
  assert.match(told.Beta, /You are free-roam child Beta/);
  assert.ok(!/trusted/i.test(told.Beta));
  assert.match(told.Beta, /Your only tools are: shell, submit_session_candidate, message_agent, bulletin_post, bulletin_read\./);
});

// agent-run executes on import. Pin its composition, then exercise those same
// exports below with only the machine replaced. No extra production export.
test("agent-run always offers the slice tools and uses the session contracts", () => {
  const src = readFileSync(new URL("../agent-run.mjs", import.meta.url), "utf8");
  assert.match(src, /import \{ roamTools, pauseRoamShell, resumeRoamShell, closeRoamShell \} from "\.\/lib\/roam\.mjs"/);
  assert.match(src, /import \{ roamBrowserTools, pauseRoamBrowser, resumeRoamBrowser, closeRoamBrowser \} from "\.\/lib\/roam-browser\.mjs"/);
  assert.match(src, /import \{ EGRESS_ENV, startEgressLog, pullEgressLog \} from "\.\/lib\/roam-egress\.mjs"/);
  assert.match(src, /import \{ [^}]*candidateTool, recordSession, sessionLookup, SESSION_DESCRIPTION, SESSION_POC, [^}]+\} from "\.\/lib\/candidate\.mjs"/);
  assert.ok(src.includes('const session = candidateTool({ name: "submit_session_candidate", description: SESSION_DESCRIPTION, pack, state, lookup: sessionLookup(state), poc: SESSION_POC });'));
  assert.ok(src.includes('const record = (entry) => recordSession(state, entry);'));
  assert.ok(src.includes('const egress = { env: EGRESS_ENV, start: startEgressLog, pull: pullEgressLog };'));
  assert.ok(src.includes('const tools = [...roamTools(ws, { record, egress, machine }), ...roamBrowserTools(ws, { record, egress, machine }), session].map((tool) => ({'));
  assert.ok(src.includes('execute: (args, api, context) => gate.run(currentAgent(), async () => {'));
  assert.ok(src.includes('const { tools: offered, control } = createRuntimeRoam(db, ws, state, { pack: pack.id, isAgent: (id) => fleet?.isRoamAgent(id) === true });'));
  assert.match(src, /fleet = createFleet\(\{ system, [^\n]+roamTools: offered, sharedTools: \[askHumanTool, ideaTool\(state\)\] \}\);/);
  assert.match(src, /agent: \{ model:[^\n]+tools: \{ remove: offered \} \}/);
  assert.ok(!src.includes("process.env.FREE_ROAM"), "only createFleet gates the tools, never their construction");
});

function sliceTools(state, machine) {
  const sessionTool = candidateTool({ name: "submit_session_candidate", description: SESSION_DESCRIPTION, pack: "multi", state, lookup: sessionLookup(state), poc: SESSION_POC });
  return [...roamTools({}, { record: (e) => recordSession(state, e), egress: { env: EGRESS_ENV, start: startEgressLog, pull: pullEgressLog }, machine }), sessionTool];
}

test("real slice tools construct without a key and stay uninstalled with free-roam off", async (t) => {
  const old = process.env.DAYTONA_API_KEY;
  delete process.env.DAYTONA_API_KEY;
  t.after(() => { if (old === undefined) delete process.env.DAYTONA_API_KEY; else process.env.DAYTONA_API_KEY = old; });
  const state = { passed: new Map(), found: [] };
  const offered = sliceTools(state, () => assert.fail("construction or a confined call must not open a machine"));
  assert.deepEqual(offered.map((tool) => tool.name), ROAM);
  assert.equal(state.session, undefined);
  const r = await runtime(t, (s) => s.who === "coordinator" ? coordinator(s, [spawnCall("Alpha")]) : answer("Done."), {
    env: { ...ON, FREE_ROAM: undefined, DAYTONA_API_KEY: undefined }, offered,
  });
  await r.run("start");
  assert.deepEqual(r.lists.Alpha.filter((name) => ROAM.includes(name)), []);
  assert.deepEqual(r.lists.coordinator.filter((name) => ROAM.includes(name)), []);
  assert.equal(state.session, undefined);
});

for (const automatic of [false, true]) test(`${automatic ? "default" : "explicit"} child runs shell, Ask and unproven session submission through the fleet`, { timeout: 15000 }, async (t) => {
  const state = { passed: new Map(), found: [] }, calls = [], requests = new Map();
  let initialized = false;
  const generation = "fake-fleet-supervisor";
  const machine = {
    id: `fleet-loadout-slice-${automatic ? "default" : "explicit"}`, fresh: false, replaced: true,
    upload: async (path, bytes) => {
      assert.ok(bytes.length > 0);
      if (path === "/tmp/touchstone-egress-log.mjs") { calls.push("upload"); return; }
      if (path === "/tmp/touchstone-shell-control.mjs") { calls.push("supervisor"); return; }
      const id = /^\/tmp\/touchstone-shell-([a-f0-9-]{36})\.json$/.exec(path)?.[1];
      assert.ok(id, "only the fixed scripts and supervisor request files may be uploaded");
      const q = JSON.parse(bytes);
      assert.equal(q.id, id);
      assert.ok(!requests.has(id));
      assert.ok(["init", "run"].includes(q.op), "this fixture expects no control operation");
      requests.set(id, q);
      calls.push(`request:${q.op}`);
    },
    exec: async (command) => {
      if (command.includes("nohup")) { calls.push("start"); return { exitCode: 0, result: "" }; }
      if (command.includes("tail -c")) {
        calls.push("pull");
        const line = { t: 1, host: "example.test", method: "GET", url: "http://example.test/export", status: 200 };
        return { exitCode: 0, result: Buffer.from(JSON.stringify(line) + "\n").toString("base64") };
      }
      const id = /^node \/tmp\/touchstone-shell-control\.mjs ([a-f0-9-]{36})$/.exec(command)?.[1];
      assert.ok(id && requests.has(id), "exec must consume an uploaded correlated request");
      const q = requests.get(id);
      requests.delete(id);
      assert.equal(q.epoch, 0);
      if (q.op === "init") {
        assert.equal(initialized, false);
        assert.equal(q.fresh, false);
        assert.equal(q.generation, undefined);
        initialized = true; calls.push("init");
        return { exitCode: 0, result: JSON.stringify({ ok: true, id, generation, epoch: 0, ack: true, state: "active", scope: "managed-shell" }) };
      }
      assert.equal(q.op, "run");
      assert.equal(initialized, true);
      assert.equal(q.generation, generation);
      assert.equal(q.seconds, 120);
      assert.equal(q.command, EGRESS_ENV + "probe export");
      calls.push("shell");
      return { exitCode: 0, result: JSON.stringify({ ok: true, id, generation, epoch: 0, exitCode: 0, result: "Private export is readable\nAuthorization: Bearer made-up-token-123456789\n" }) };
    },
  };
  const offered = sliceTools(state, async () => { calls.push(`machine:${currentAgent()}`); return machine; });
  const route = (s) => {
    if (s.who === "coordinator") return automatic ? answer("Done.") : coordinator(s, [spawnCall("Beta", "free-roam")]);
    if (s.last.role === "user") return result([askCall()]);
    if (s.last.toolName === "ask_human") {
      assert.ok(!s.last.isError);
      return result([call("shell", { command: "probe export" })]);
    }
    if (s.last.toolName === "shell") {
      const output = text(s.last);
      assert.match(output, /^The machine was replaced\.[^]*\nsession session:a-\d+:1\nexit 0/);
      assert.ok(!output.includes("made-up-token-123456789"));
      const poc = /^session (.+)$/m.exec(output)[1];
      return result([call("submit_session_candidate", { title: "Export is open", severity: "high", poc, evidence_lines: ["Private export is readable"], explanation: "Anyone can read the export.\nFix: require a login." })]);
    }
    return answer("Done.");
  };
  const r = await runtime(t, route, { offered, defaultRoute: route, sharedTools: [askHumanTool], hooks: answerEvents });
  await r.run("start");
  const beta = r.spawned(automatic ? "FreeRoam" : "Beta");
  assert.equal(r.events.find((e) => e.ev === "ask-human").agent, beta.id);
  assert.equal(r.events.filter((e) => e.ev === "ask-answered").length, 1);
  assert.deepEqual(calls, [`machine:${beta.id}`, "upload", "start", "supervisor", "request:init", "init", "request:run", "shell", "pull"]);
  assert.equal(requests.size, 0);
  assert.deepEqual((await r.results(beta.conv, "submit_session_candidate")).map((m) => !!m.isError), [false]);
  assert.equal(state.candidates.length, 1);
  const c = state.candidates[0];
  assert.equal(c.pack, "multi");
  assert.equal(c.proven, false);
  assert.equal(c.evidence.agent, beta.id);
  assert.equal(c.evidence.sandbox, machine.id);
  assert.deepEqual(c.evidence.egress.hosts, ["example.test"]);
  assert.equal(c.evidence.egress.requests, 1);
  assert.deepEqual(state.found, []);
  assert.ok(!JSON.stringify(c).includes("made-up-token-123456789"));
  assert.ok(r.events.some((e) => e.ev === "egress-log" && e.requests === 1));
});

test("requested free-roam fails at construction, never falls back to confined", async (t) => {
  for (const [name, extra] of [
    ["solo", { env: { ...ON, FLEET: "0" } }],
    ["Daytona off", { env: { ...ON, TOUCHSTONE_EXEC: undefined } }],
    ["no key", { env: { ...ON, DAYTONA_API_KEY: undefined } }],
    ["no offered tools", { offered: [] }],
  ]) await t.test(name, async (t) => {
    await assert.rejects(runtime(t, () => assert.fail("no model call"), extra), /No confined fallback/);
  });
});

test("invalid or disabled run options are refused before a model runs", async (t) => {
  for (const value of ["not JSON", "null", "{}", '["unknown"]', '["wallet","wallet"]', '[1]']) {
    await t.test(value, async (t) => {
      await assert.rejects(runtime(t, () => assert.fail("no model call"), { env: { ...ON, ROAM_OPTIONS: value } }), /ROAM_OPTIONS/);
    });
  }
  await t.test("disabled", async (t) => {
    await assert.rejects(runtime(t, () => assert.fail("no model call"), { env: { ...ON, FREE_ROAM: "0", ROAM_OPTIONS: '["wallet"]' } }), /requires FREE_ROAM/);
  });
});

test("the reserved slot starts a real default child once across drains and workers", { timeout: 20000 }, async (t) => {
  const open = await shared(t);
  let defaults = 0;
  const defaultRoute = (s) => {
    if (s.last.role === "user") { defaults++; return result([call("shell", {})]); }
    return answer("Default complete.");
  };
  const env = { ...ON, ROAM_OPTIONS: '["email","wallet"]' };
  let w = await runtime(t, (s) => s.who === "coordinator" ? coordinator(s, [spawnCall("Alpha"), spawnCall("Overflow")]) : answer("Done."), { max: 2, storage: await open(), env, defaultRoute });
  await w.run("start");
  const board = await w.harness.snapshot(Roster, ROOT_CONVERSATION_ID, ctx);
  assert.deepEqual(board.agents.map((a) => a.loadout), ["confined", "free-roam"]);
  const automatic = board.agents[1];
  assert.deepEqual(automatic.options, ["wallet", "email"]);
  assert.equal(automatic.status, "done");
  assert.equal(w.spawned("FreeRoam").tier, "T2");
  assert.deepEqual(w.spawned("FreeRoam").options, ["wallet", "email"]);
  assert.deepEqual(w.ran, [`${automatic.id}:shell`]);
  const spawns = await w.results(undefined, "spawn_agent");
  assert.ok(spawns.some((m) => m.isError && /reserved/.test(text(m))));
  assert.deepEqual(w.lists.FreeRoam.toSorted(), ["bulletin_post", "bulletin_read", "message_agent", "shell", "submit_session_candidate"]);
  await w.fleet.drain(ctx);
  assert.equal(defaults, 1);
  await w.close();
  w = await runtime(t, () => answer("Follow-up complete."), { max: 2, storage: await open(), env, defaultRoute });
  await w.run("follow-up");
  const restored = await w.harness.snapshot(Roster, ROOT_CONVERSATION_ID, ctx);
  assert.deepEqual(restored.agents.map((a) => a.id), board.agents.map((a) => a.id));
  assert.deepEqual(restored.jobs, board.jobs);
  assert.equal(defaults, 1, "the default task is not rerun by a later worker");
  assert.equal(w.events.filter((e) => e.ev === "subagent-spawned").length, 0);
});

test("one-slot fleets reserve it for free-roam; a chosen child prevents an extra default", async (t) => {
  const r = await runtime(t, (s) => s.who === "coordinator" ? coordinator(s, [spawnCall("Blocked"), spawnCall("Beta", "free-roam")]) : answer("Done."), { max: 1 });
  await r.run("start");
  const board = await r.harness.snapshot(Roster, ROOT_CONVERSATION_ID, ctx);
  assert.deepEqual(board.agents.map((a) => a.name), ["Beta"]);
  assert.equal(r.spawned("FreeRoam"), undefined);
  assert.ok((await r.results(undefined, "spawn_agent")).some((m) => m.isError && /reserved/.test(text(m))));
});

test("an older full confined roster cannot silently omit the requested default", async (t) => {
  const open = await shared(t);
  let w = await runtime(t, (s) => s.who === "coordinator" ? coordinator(s, [spawnCall("Alpha")]) : answer("Done."), { max: 1, storage: await open(), env: { ...ON, FREE_ROAM: "0" } });
  await w.run("start");
  await w.close();
  w = await runtime(t, () => answer("Done."), { max: 1, storage: await open() });
  await assert.rejects(w.run("follow-up"), /Fleet limit reached/);
  assert.deepEqual((await w.harness.snapshot(Roster, ROOT_CONVERSATION_ID, ctx)).agents.map((a) => a.loadout), ["confined"]);
});

test("child options are normalized, bounded by the run, and read from the caller's current board row", async (t) => {
  const r = await runtime(t, (s) => {
    if (s.who !== "coordinator") return answer("Done.");
    if (text(s.last) !== "start") return answer("Complete.");
    return result([
      call("spawn_agent", { name: "Beta", task: "Investigate", area: "web", loadout: "free-roam", options: ["email", "wallet", "email"] }),
      spawnCall("Alpha"),
      call("spawn_agent", { name: "Rejected", task: "Investigate", area: "web", options: ["wallet"] }),
    ]);
  }, { env: { ...ON, ROAM_OPTIONS: '["email","wallet"]' } });
  await r.run("start");
  const beta = r.spawned("Beta"), alpha = r.spawned("Alpha");
  const api = (conv) => ({ conversationId: Number(conv), snapshot: (doc, id, c) => r.harness.snapshot(doc, id, c) });
  assert.deepEqual(await r.fleet.options(beta.id, api(beta.conv), ctx), ["wallet", "email"]);
  await assert.rejects(r.fleet.options(beta.id, api(alpha.conv), ctx), /calling free-roam child/);
  await assert.rejects(r.fleet.options(alpha.id, api(alpha.conv), ctx), /calling free-roam child/);
  await assert.rejects(r.fleet.options("coordinator", api(ROOT_CONVERSATION_ID), ctx), /calling free-roam child/);
  await assert.rejects(r.fleet.options("a-999999", api(999999), ctx), /calling free-roam child/);
  assert.equal(r.spawned("Rejected"), undefined);
  assert.ok((await r.results(undefined, "spawn_agent")).some((m) => m.isError && /Confined children/.test(text(m))));
  // A fresh read, not a cached model selection or a caller-owned returned array.
  const options = await r.fleet.options(beta.id, api(beta.conv), ctx);
  options.length = 0;
  assert.deepEqual(await r.fleet.options(beta.id, api(beta.conv), ctx), ["wallet", "email"]);
  await r.harness.commit(async (tx) => { (await tx.doc(Roster, ROOT_CONVERSATION_ID)).agents.find((a) => a.id === beta.id).options = ["email"]; }, ctx);
  assert.deepEqual(await r.fleet.options(beta.id, api(beta.conv), ctx), ["email"]);
  await r.harness.commit(async (tx) => { (await tx.doc(Roster, ROOT_CONVERSATION_ID)).agents.find((a) => a.id === beta.id).loadout = "confined"; }, ctx);
  await assert.rejects(r.fleet.options(beta.id, api(beta.conv), ctx), /calling free-roam child/);
});

test("a model cannot select an option the run did not enable", async (t) => {
  const r = await runtime(t, (s) => s.who === "coordinator" && text(s.last) === "start" ? result([
    call("spawn_agent", { name: "Rejected", task: "Investigate", area: "web", loadout: "free-roam", options: ["wallet"] }),
  ]) : answer("Done."), { env: { ...ON, ROAM_OPTIONS: '["email"]' } });
  await r.run("start");
  assert.equal(r.spawned("Rejected"), undefined);
  assert.ok((await r.results(undefined, "spawn_agent")).some((m) => m.isError && /did not enable/.test(text(m))));
  assert.deepEqual(r.spawned("FreeRoam").options, ["email"]);
});

test("concurrent drains create one default even in a one-slot fleet", async (t) => {
  let calls = 0;
  const r = await runtime(t, () => answer("Done."), { max: 1, defaultRoute: () => { calls++; return answer("Done."); } });
  await Promise.all([r.fleet.drain(ctx), r.fleet.drain(ctx)]);
  const board = await r.harness.snapshot(Roster, ROOT_CONVERSATION_ID, ctx);
  assert.equal(board.agents.length, 1);
  assert.equal(board.agents[0].loadout, "free-roam");
  assert.equal(calls, 1);
});

test("the default avoids a confined child's name", async (t) => {
  const r = await runtime(t, (s) => coordinator(s, [spawnCall("FreeRoam")]), { max: 2 });
  await r.run("start");
  const board = await r.harness.snapshot(Roster, ROOT_CONVERSATION_ID, ctx);
  assert.deepEqual(board.agents.map((a) => [a.name, a.loadout]), [["FreeRoam", "confined"], ["FreeRoam_", "free-roam"]]);
});

test("a stopped run never starts a default child", async (t) => {
  const r = await runtime(t, () => assert.fail("no model call"));
  await r.harness.commit(async (tx) => { (await tx.doc(LiveDoc, ROOT_CONVERSATION_ID)).runFailure = { reason: "stopped", detail: "Stopped for test." }; }, ctx);
  assert.deepEqual(await r.fleet.drain(ctx), { status: "unanswered", reason: "stopped", detail: "Stopped for test." });
  assert.equal((await r.harness.snapshot(Roster, ROOT_CONVERSATION_ID, ctx))?.agents.length ?? 0, 0);
});

test("a failed coordinator drains an existing child without starting a default and keeps its original failure", { timeout: 15000 }, async (t) => {
  let started, release;
  const childStarted = new Promise((resolve) => { started = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const r = await runtime(t, async (s) => {
    if (s.who === "coordinator") {
      if (text(s.last) === "start") return result([spawnCall("Alpha")]);
      if (s.last.toolName === "spawn_agent") {
        await childStarted;
        return answer([], { stopReason: "error", errorMessage: "Original coordinator failure" });
      }
      return answer("Child report received.");
    }
    if (s.last.role === "user") {
      started();
      await held;
      return result([call("read_source", {})]);
    }
    return answer("Child evidence recorded.");
  }, { defaultRoute: () => assert.fail("a failed coordinator must not start a default child") });
  const root = await r.harness.root(ctx);
  await (await root.submit({ type: "input", content: "start" }, ctx)).wait(ctx);
  const original = (await r.harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, ctx)).runFailure;
  assert.ok(original);
  const draining = r.fleet.drain(ctx);
  assert.equal(await Promise.race([draining.then(() => "settled"), delay(20, "pending")]), "pending", "drain must wait for the existing child");
  release();
  assert.deepEqual(await draining, { status: "unanswered", reason: original.reason, detail: original.detail });
  const alpha = r.spawned("Alpha");
  assert.deepEqual(r.ran, [`${alpha.id}:read_source`]);
  assert.ok(r.events.some((e) => e.ev === "subagent-done" && e.id === alpha.id && e.status === "done"));
  assert.equal(r.spawned("FreeRoam"), undefined);
  assert.equal((await r.harness.snapshot(Roster, ROOT_CONVERSATION_ID, ctx)).agents.length, 1);
});

test("a reopened worker cannot grant a stale option", async (t) => {
  const open = await shared(t);
  let w = await runtime(t, () => answer("Done."), { storage: await open(), env: { ...ON, ROAM_OPTIONS: '["wallet","email"]' } });
  await w.run("start");
  const child = w.spawned("FreeRoam");
  await w.close();
  w = await runtime(t, () => answer("Done."), { storage: await open(), env: { ...ON, ROAM_OPTIONS: '["email"]' } });
  const api = { conversationId: Number(child.conv), snapshot: (doc, id, c) => w.harness.snapshot(doc, id, c) };
  assert.deepEqual(await w.fleet.options(child.id, api, ctx), ["email"]);
  await w.close();
  w = await runtime(t, () => answer("Done."), { storage: await open(), env: { ...ON, FREE_ROAM: "0" } });
  await assert.rejects(w.fleet.options(child.id, api, ctx), /calling free-roam child/);
});

const askCall = () => call("ask_human", { kind: "question", question: "Which scope?" });
const answerEvents = { event: (e) => { if (e.ev === "ask-human") queueMicrotask(() => answerAsk({ ask: e.id, reply: "The lab only." })); } };

test("shared Ask is available to coordinator, confined and free-roam children", async (t) => {
  const r = await runtime(t, (s) => {
    if (s.who === "coordinator") return text(s.last) === "start" ? result([spawnCall("Alpha"), spawnCall("Beta", "free-roam"), askCall()]) : answer("Done.");
    return s.last.role === "user" ? result([askCall()]) : answer("Done.");
  }, { sharedTools: [askHumanTool], hooks: answerEvents });
  await r.run("start");
  for (const name of ["coordinator", "Alpha", "Beta"]) assert.ok(r.lists[name].includes("ask_human"));
  assert.deepEqual(r.events.filter((e) => e.ev === "ask-human").map((e) => e.agent).sort(), ["coordinator", r.spawned("Alpha").id, r.spawned("Beta").id].sort());
  assert.equal(r.events.filter((e) => e.ev === "ask-answered").length, 3);
  assert.equal(r.fleet.extension.tools.find((t) => t.name === "ask_human"), askHumanTool, "shared Ask is not wrapped by packQueue or the roam guard");
});

test("a solo worker retains shared Ask without installing roam tools", async (t) => {
  const r = await runtime(t, (s) => text(s.last) === "start" ? result([askCall()]) : answer("Done."), { sharedTools: [askHumanTool], hooks: answerEvents, env: { ...ON, FLEET: "0", FREE_ROAM: "0" } });
  await r.run("start");
  assert.ok(r.lists.coordinator.includes("ask_human"));
  assert.ok(!r.lists.coordinator.includes("shell"));
  assert.equal(r.events.find((e) => e.ev === "ask-human").agent, "coordinator");
});

test("saved free-roam allow lists gain shared Ask but no new pack tool", async (t) => {
  const open = await shared(t);
  let w = await runtime(t, (s) => s.who === "coordinator" ? coordinator(s, [spawnCall("Beta", "free-roam")]) : answer("Done."), { storage: await open() });
  await w.run("start");
  const beta = w.spawned("Beta");
  await w.close();
  w = await runtime(t, (s) => {
    if (s.who === "coordinator") return text(s.last) === "go on" ? result([call("message_agent", { to: "Beta", text: "Go on." })]) : answer("Done.");
    return s.last.role === "user" ? result([askCall()]) : answer("Done.");
  }, { storage: await open(), sharedTools: [askHumanTool], hooks: answerEvents, pack: [...PACK, "new_pack_tool"] });
  await w.run("go on");
  assert.deepEqual(w.lists.Beta.toSorted(), ["ask_human", "bulletin_post", "bulletin_read", "message_agent", "shell", "submit_session_candidate"]);
  assert.equal(w.events.find((e) => e.ev === "ask-human").agent, beta.id);
});

test("spawn replay through the real tool API returns the same child without a settled overlay", async (t) => {
  const replies = [];
  let taskId;
  const r = await runtime(t, (s) => s.who === "coordinator" && text(s.last) === "start"
    ? result([call("read_source", {})]) : answer("Done."), { max: 1, hooks: {
    read_source: async (_args, api, c) => {
      taskId = api.taskId;
      const spawn = r.fleet.extension.tools.find((tool) => tool.name === "spawn_agent");
      const args = { name: "Beta", task: "Audit the lab", area: "lab", loadout: "free-roam" };
      replies.push(await spawn.execute(args, api, c));
      replies.push(await spawn.execute(args, api, c));
      replies.push(...await Promise.all(Array.from({ length: 5 }, () => spawn.execute(args, api, c))));
    },
  } });
  assert.equal((await r.run("start")).status, "done");
  assert.equal(replies.length, 7, "every replay succeeds through the same actual task API");
  for (const replay of replies) assert.deepEqual(replay, replies[0]);
  assert.deepEqual((await r.results(undefined, "read_source")).map((m) => !!m.isError), [false]);
  const board = await r.harness.snapshot(Roster, ROOT_CONVERSATION_ID, ctx);
  assert.equal(board.agents.length, 1);
  assert.equal(board.agents[0].spawn, taskId);
  assert.deepEqual(Object.keys(board.jobs), [String(taskId)]);
  assert.equal(board.agents[0].status, "done");
  assert.equal(r.events.filter((e) => e.ev === "subagent-spawned").length, 1);
});

test("the gate sees trusted membership before a first action and immediately after a board commit", async (t) => {
  const r = await runtime(t, (s) => s.who === "coordinator" ? coordinator(s, [spawnCall("Alpha"), spawnCall("Beta", "free-roam")]) : answer("Done."));
  assert.equal(r.fleet.isRoamAgent("coordinator"), false);
  assert.equal(r.fleet.isRoamAgent("a-99999"), false);
  await r.run("start");
  const beta = r.spawned("Beta"), alpha = r.spawned("Alpha");
  assert.deepEqual(r.ran, [], "no machine tool has run");
  assert.equal(r.fleet.isRoamAgent(beta.id), true);
  assert.equal(r.fleet.isRoamAgent(alpha.id), false);
  const pauses = [];
  const gate = createRoamControl({ epoch: "test-worker", isAgent: r.fleet.isRoamAgent, emit() {}, remote: {
    pause: async (id) => pauses.push(id), resume: async () => {}, close: async () => {},
  } });
  t.after(() => gate.dispose());
  assert.deepEqual(await gate.pause(beta.id, "lease1"), { state: "paused", lease: "lease1" });
  assert.deepEqual(pauses, [beta.id]);
  await gate.resume(beta.id, "lease1");
  let release;
  const first = gate.run(beta.id, () => new Promise((resolve) => { release = resolve; }));
  const queued = gate.run(beta.id, () => assert.fail("revoked child must not dispatch"));
  const refused = assert.rejects(queued, /ROAM_AGENT/);
  await r.harness.commit(async (tx) => { (await tx.doc(Roster, ROOT_CONVERSATION_ID)).agents.find((a) => a.id === beta.id).loadout = "confined"; }, ctx);
  assert.equal(r.fleet.isRoamAgent(beta.id), false, "no observer tick or tool call is needed");
  release("done");
  await first;
  await refused;
  await r.harness.commit(async (tx) => { (await tx.doc(Roster, ROOT_CONVERSATION_ID)).agents.find((a) => a.id === beta.id).loadout = "free-roam"; }, ctx);
  assert.equal(r.fleet.isRoamAgent(beta.id), true);
  await r.close();
  assert.equal(r.fleet.isRoamAgent(beta.id), false);
});

test("gate membership restores before any model turn and rejects a mismatched conversation", async (t) => {
  const open = await shared(t);
  let w = await runtime(t, () => answer("Done."), { storage: await open() });
  await w.run("start");
  const child = w.spawned("FreeRoam");
  await w.close();
  w = await runtime(t, () => assert.fail("no model turn"), { storage: await open() });
  assert.equal(w.fleet.isRoamAgent(child.id), true);
  await w.harness.commit(async (tx) => { (await tx.doc(Roster, ROOT_CONVERSATION_ID)).agents[0].conv = ROOT_CONVERSATION_ID; }, ctx);
  assert.equal(w.fleet.isRoamAgent(child.id), false);
  await w.close();
});
