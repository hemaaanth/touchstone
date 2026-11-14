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
import { createRegistry, defineDoc, defineExtension, defineTool, Harness, MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { createFleet, FREE_ROAM_INSTRUCTIONS } from "../lib/fleet.mjs";
import { currentAgent } from "../lib/event.mjs";

// Per-agent loadouts (I7a). Every tool here is a fake: no Daytona call, no
// network, no key. "Daytona on" is two env values with a made-up key.
const ON = { FLEET: undefined, FREE_ROAM: "1", TOUCHSTONE_EXEC: "daytona", DAYTONA_API_KEY: "made-up-test-key", DAYTONA_API_URL: undefined };
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
async function runtime(t, route, { env = ON, required = false, survey, hooks = {}, storage = new MemoryStorage(), pack = PACK } = {}) {
  const set = (values) => { for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  set(env);
  t.after(() => set(ORIGINAL));
  const events = [], reports = [], ran = [], lists = {};
  t.mock.method(console, "log", (line) => { if (line.startsWith("EVENT ")) events.push(JSON.parse(line.slice(6))); });
  // Each fake records who ran it. `hooks[name]` lets one case hold a call open.
  const fake = (name) => defineTool({
    name, description: `Fake ${name}.`, parameters: obj({}), replay: "safe",
    execute: async () => { ran.push(`${currentAgent() ?? "coordinator"}:${name}`); await hooks[name]?.(); return { output: [{ type: "text", text: `${name} ran.` }] }; },
  });
  const packTools = pack.map(fake), roamTools = ROAM.map(fake);
  const faux = fauxProvider({ tokensPerSecond: 100000 });
  faux.setResponses(Array.from({ length: 150 }, () => (request) => { const s = seen(request); lists[s.who] = s.tools; return route(s); }));
  const models = createModels();
  models.setProvider(faux.provider);
  const fleet = createFleet({ system: "Audit the lab only.", costOf: () => 0, max: 4, required, survey, roamTools });
  const registry = createRegistry();
  // The same wiring as agent-run.mjs: the pack extension, then the fleet's own.
  registry.install(defineExtension({ name: "pack", tools: fleet ? fleet.wrapTools(packTools) : packTools }));
  if (fleet) registry.install(fleet.extension);
  const harness = await Harness.open(storage, { models, registry, settings: { retry: { maxRetries: 0 } }, onReport: (r) => reports.push(r) }, ctx);
  await fleet?.attach(harness, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" }, instructions: fleet ? fleet.instructions : "Audit the lab only." } });
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

test("free-roam is refused without FREE_ROAM=1, and with it when Daytona is off", { timeout: 15000 }, async (t) => {
  for (const [label, env] of [["no FREE_ROAM", { ...ON, FREE_ROAM: undefined }], ["FREE_ROAM=0", { ...ON, FREE_ROAM: "0" }], ["Daytona off", { ...ON, TOUCHSTONE_EXEC: undefined }], ["no key", { ...ON, DAYTONA_API_KEY: undefined }]]) {
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

test("with FLEET=0 and FREE_ROAM=1 the tool list has no shell", { timeout: 15000 }, async (t) => {
  const r = await runtime(t, (s) => s.last.role === "user" ? result([call("shell", {})]) : answer("Single agent done."), { env: { ...ON, FLEET: "0" } });
  assert.equal(r.fleet, undefined);
  assert.equal((await r.run("start")).status, "done");
  assert.deepEqual(r.lists.coordinator, PACK);
  assert.ok((await r.results(undefined, "shell")).every((m) => m.isError));
  assert.deepEqual(r.ran, []);
  // agent-run.mjs runs on import, so its wiring is pinned by its source: only
  // two extensions are installed, the pack's and the fleet's.
  const src = readFileSync(new URL("../agent-run.mjs", import.meta.url), "utf8");
  assert.deepEqual(src.match(/registry\.install\([^\n]*/g), [
    "registry.install(defineExtension({ name: pack.id, tools: fleet ? fleet.wrapTools(tools) : tools }));",
    "registry.install(fleet.extension);",
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
