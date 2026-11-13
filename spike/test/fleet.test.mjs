import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage as answer, fauxProvider, fauxText, fauxThinking, fauxToolCall as call } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineDoc, defineExtension, defineTool, Harness, MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { createFleet, COORDINATOR_INSTRUCTIONS, SPLIT_TURN } from "../lib/fleet.mjs";
import { event, withAgent } from "../lib/event.mjs";

const result = (blocks) => answer(blocks, { stopReason: "toolUse" });
const text = (message) => typeof message?.content === "string" ? message.content : (message?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");

async function runtime(t, route, { max = 4, budgeted = false, required = false, survey } = {}) {
  const events = [], reports = [];
  t.mock.method(console, "log", (line) => { if (line.startsWith("EVENT ")) events.push(JSON.parse(line.slice(6))); });
  const faux = fauxProvider({ tokensPerSecond: 100000 });
  faux.setResponses(Array.from({ length: 150 }, () => route));
  const models = createModels();
  const fleet = createFleet({ system: "Audit the lab only.", costOf: (_model, input, output) => (input + output) / 1e6, max, required, survey });
  if (budgeted) {
    const { budgetedApi } = await import("../lib/provider.mjs");
    models.setProvider({ ...faux.provider, ...budgetedApi(faux.provider, fleet?.agentForSession) });
  } else models.setProvider(faux.provider);
  const registry = createRegistry();
  let active = 0, peak = 0;
  const read = defineTool({
    name: "read_source", description: "Read the lab.", parameters: obj({}), replay: "safe",
    execute: async () => {
      active++; peak = Math.max(peak, active);
      event("read_source", { file: "Vault.sol" });
      await delay(5);
      event("source-read-done", { file: "Vault.sol" });
      active--;
      return { output: [{ type: "text", text: "Lab source." }] };
    },
  });
  registry.install(defineExtension({ name: "pack", tools: fleet ? fleet.wrapTools([read]) : [read] }));
  if (fleet) registry.install(fleet.extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry, settings: { retry: { maxRetries: 0 } }, onReport: (r) => reports.push(r) }, ctx);
  await fleet?.attach(harness, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" }, instructions: fleet ? COORDINATOR_INSTRUCTIONS : "Audit the lab only." } });
  t.after(async () => { await fleet?.close(); await harness.close(ctx); });
  async function run(content, drain) {
    let settled = await (await root.submit({ type: "input", content }, ctx)).wait(ctx);
    settled = await fleet?.drain(ctx, drain) ?? settled;
    assert.deepEqual(reports, []);
    return settled;
  }
  return { events, harness, root, run, peak: () => peak };
}

function requestInfo(request) {
  return { last: request.messages.findLast((m) => m.role !== "system"), system: request.messages.filter((m) => m.role === "system").map((m) => text(m) + Object.values(m.sections ?? {}).join("\n")).join("\n") };
}

test("parallel children keep tool ownership, cognition, messages, Bulletin, and spend", { timeout: 15000 }, async (t) => {
  const r = await runtime(t, (request) => {
    const { last, system } = requestInfo(request);
    if (!system.includes("trusted child")) {
      if (last.role === "user" && text(last) === "start") return result([
        call("spawn_agent", { name: "Alpha", task: "Map calls", area: "calls" }),
        call("spawn_agent", { name: "Beta", task: "Map balances", area: "balances" }),
      ]);
      return answer("Coverage complete.");
    }
    if (last.role === "user" && !text(last).includes("[From a-")) return result([
      fauxThinking("Read this angle."), fauxText("Checking the lab source."), call("read_source", {}),
      call("bulletin_post", { text: system.includes("child Alpha") ? "External call lead" : "Balance note", kind: "lead", severity: "high", tags: ["lab"] }),
      ...(system.includes("child Alpha") ? [call("message_agent", { to: "Beta", text: "Check the balance after the external call." })] : []),
    ]);
    return answer([fauxThinking("The angle is covered."), fauxText("Lab source reviewed. No verdict without replay.")]);
  });
  assert.equal((await r.run("start")).status, "done");
  const agents = r.events.filter((e) => e.ev === "subagent-spawned");
  assert.equal(agents.length, 2);
  assert.ok(agents.every((a) => a.tier === "T1" && !a.agent));
  for (const agent of agents) {
    const child = r.events.filter((e) => e.agent === agent.id);
    assert.ok(child.some((e) => e.ev === "read_source"));
    assert.ok(child.some((e) => e.ev === "source-read-done"));
    assert.ok(child.some((e) => e.ev === "assistant-delta" && e.conv === agent.conv));
    assert.ok(child.some((e) => e.ev === "thinking-delta" && e.conv === agent.conv));
    assert.ok(child.some((e) => e.ev === "agent-spend" && e.usd > 0));
    assert.equal(child.filter((e) => e.ev === "subagent-done").at(-1).status, "done");
    const conversation = await r.harness.conversation(Number(agent.conv), ctx);
    const view = await conversation.context(ctx);
    assert.ok(view.messages.some((m) => m.role === "toolResult" && m.toolName === "read_source"));
  }
  const messages = r.events.filter((e) => e.ev === "agent-message");
  assert.equal(new Set(messages.map((e) => e.id)).size, messages.length);
  assert.ok(messages.some((e) => e.from === agents[0].id && e.to === agents[1].id));
  assert.equal(r.events.filter((e) => e.ev === "bulletin-post").length, 2);
  assert.equal(r.peak(), 1, "shared pack tools must not race over the workspace");
  const total = await r.harness.usage(ctx);
  assert.ok(total.models["faux/faux-1"].output > 0);
});

test("a provider failure stays in the child and a retry reuses it at the cap", { timeout: 15000 }, async (t) => {
  const r = await runtime(t, (request) => {
    const { last, system } = requestInfo(request);
    if (system.includes("trusted child")) {
      if (text(last).includes("retry")) return answer("Retried the assigned task.");
      return answer([], { stopReason: "error", errorMessage: "Provider returned 503" });
    }
    if (text(last) === "start") return result([call("spawn_agent", { name: "Alpha", task: "Read calls", area: "calls" })]);
    if (text(last) === "retry Alpha") return result([call("message_agent", { to: "Alpha", text: "retry your assigned task" })]);
    if (text(last) === "extra") return result([call("spawn_agent", { name: "Beta", task: "Read balances", area: "balances" })]);
    if (text(last) === "board") return result([call("bulletin_read", {})]);
    return answer("Report received.");
  }, { max: 1 });
  await r.run("start");
  assert.deepEqual(r.events.filter((e) => e.ev === "subagent-done").map(({ status, error }) => ({ status, error })), [{ status: "failed", error: "Provider returned 503" }]);
  await r.run("retry Alpha");
  assert.equal(r.events.filter((e) => e.ev === "subagent-done").at(-1).status, "done");
  await r.run("retry Alpha");
  const answers = r.events.filter((e) => e.ev === "assistant-delta" && e.text === "Retried the assigned task.");
  assert.equal(new Set(answers.map((e) => `${e.conv}:${e.attempt}`)).size, 2, "retry must not replace the earlier answer");
  await r.run("extra");
  assert.equal(r.events.filter((e) => e.ev === "subagent-spawned").length, 1);
  await r.run("board");
  const view = await r.root.context(ctx);
  const board = view.messages.findLast((m) => m.role === "toolResult" && m.toolName === "bulletin_read");
  assert.equal(JSON.parse(text(board)).agents[0].task, "Read calls");
  assert.ok(view.messages.some((m) => m.role === "toolResult" && m.toolName === "spawn_agent" && m.isError));
});

test("event ownership stays local across interleaved async work", async (t) => {
  const events = [];
  t.mock.method(console, "log", (line) => events.push(JSON.parse(line.slice(6))));
  await Promise.all(["a-one", "a-two"].map((id) => withAgent(id, async () => {
    event("read_source");
    await delay(id === "a-one" ? 10 : 1);
    event("artifact-done");
  })));
  event("list_sources");
  assert.deepEqual(events.slice(0, 4).map((e) => e.agent), ["a-one", "a-two", "a-two", "a-one"]);
  assert.equal(events[4].agent, undefined);
});

test("a fleet run refuses coordinator pack work after the survey until it spawns", { timeout: 15000 }, async (t) => {
  const r = await runtime(t, (request) => {
    const { last, system } = requestInfo(request);
    if (system.includes("trusted child")) return answer("Child covered its area.");
    if (text(last) === "start") return result([call("read_source", {}), call("read_source", {})]);
    if (last.role === "toolResult" && last.toolName === "read_source" && last.isError) return result([call("spawn_agent", { name: "Alpha", task: "Read calls", area: "calls" })]);
    if (last.role === "toolResult" && last.toolName === "spawn_agent") return result([call("read_source", {})]);
    return answer("Coverage complete.");
  }, { required: true, survey: 1 });
  assert.equal((await r.run("start")).status, "done");
  const view = await r.root.context(ctx);
  const reads = view.messages.filter((m) => m.role === "toolResult" && m.toolName === "read_source");
  assert.deepEqual(reads.map((m) => !!m.isError), [false, true, false]);
  assert.match(text(reads[1]), /fleet run/);
  assert.equal(r.events.filter((e) => e.ev === "subagent-spawned").length, 1);
});

test("a fleet run that answers without spawning gets one turn to split", { timeout: 15000 }, async (t) => {
  const r = await runtime(t, (request) => {
    const { last, system } = requestInfo(request);
    if (system.includes("trusted child")) return answer("Child covered its area.");
    if (text(last) === SPLIT_TURN) return result([call("spawn_agent", { name: "Alpha", task: "Read calls", area: "calls" })]);
    return answer("Coverage complete.");
  }, { required: true });
  assert.equal((await r.run("start")).status, "done");
  assert.equal(r.events.filter((e) => e.ev === "subagent-spawned").length, 1);
  const asks = (await r.root.context(ctx)).messages.filter((m) => m.role === "user" && text(m) === SPLIT_TURN);
  assert.equal(asks.length, 1);
  // A second drain, as after the pack's nudge, does not ask again.
  assert.equal((await r.run("more", {})).status, "done");
});

test("an operator follow-up never gets the split turn", { timeout: 15000 }, async (t) => {
  const r = await runtime(t, () => answer("Answered."), { required: true });
  assert.equal((await r.run("question", { enforce: false })).status, "done");
  assert.equal((await r.root.context(ctx)).messages.filter((m) => text(m) === SPLIT_TURN).length, 0);
});

test("FLEET=0 keeps pack tools and does not install fleet tools", async (t) => {
  const old = process.env.FLEET;
  process.env.FLEET = "0";
  t.after(() => { if (old === undefined) delete process.env.FLEET; else process.env.FLEET = old; });
  const r = await runtime(t, (request) => {
    const tools = request.messages.filter((m) => m.role === "system").flatMap((m) => m.toolsAdded ?? []);
    assert.deepEqual(tools.map((t) => t.name), ["read_source"]);
    const { last } = requestInfo(request);
    return last.role === "user" ? result([call("read_source", {})]) : answer("Single agent done.");
  });
  assert.equal((await r.run("start")).status, "done");
  assert.deepEqual(r.events.map((e) => e.ev), ["read_source", "source-read-done"]);
  assert.ok(r.events.every((e) => e.agent === undefined));
});

test("child responses charge the run budget and block later model calls", { timeout: 15000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-budget-"));
  const previous = { RUN_BUDGET_USD: process.env.RUN_BUDGET_USD, SPEND_LEDGER: process.env.SPEND_LEDGER };
  process.env.RUN_BUDGET_USD = "0.01";
  process.env.SPEND_LEDGER = join(dir, "spend.json");
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const r = await runtime(t, (request) => {
    const { last, system } = requestInfo(request);
    if (system.includes("trusted child")) {
      return answer("Covered this lab angle. ".repeat(1000));
    }
    if (text(last) === "start") return result([call("spawn_agent", { name: "Alpha", task: "Read calls", area: "calls" })]);
    return answer("Waiting for the child.");
  }, { budgeted: true });
  const settled = await r.run("start");
  assert.equal(settled.status, "unanswered");
  assert.match(settled.detail, /Run budget reached/);
  const agent = r.events.find((e) => e.ev === "subagent-spawned");
  const childSpend = r.events.find((e) => e.ev === "spend" && e.agent === agent.id);
  assert.ok(childSpend.usd >= 0.01);
  const { runSpend } = await import("../lib/inference.mjs");
  assert.equal(runSpend().usd, r.events.findLast((e) => e.ev === "spend").usd);
  assert.ok(r.events.some((e) => e.ev === "budget-reached"));
  const before = runSpend().usd;
  await r.run("another request");
  assert.equal(runSpend().usd, before);
});

// ---- A changed scope brief reaches a child that a later worker reopens (L26) ----

// The change text, as the engine's briefChange gives it (targets.mjs): "" for no
// change. The fleet takes the function as a parameter, so these tests need no store.
const briefChange = (before, now) => ((before ?? "") === now ? "" : now ? `The operator changed the scope brief. Follow this one instead of the earlier one.\n\n${now}` : "The operator removed the scope brief. Do not follow the earlier one any more.");

// One worker over a shared store: the first run, or a follow-up that reopens it.
// The coordinator spawns or messages children as `plan(operator text)` says; every
// child answers "ok". `seen` gets what each child was asked, and its instructions.
async function worker(t, storage, { brief, changed = "", briefChange }, seen) {
  t.mock.method(console, "log", () => {});
  const faux = fauxProvider({ tokensPerSecond: 100000 });
  faux.setResponses(Array.from({ length: 60 }, () => (request) => {
    const { last, system } = requestInfo(request);
    if (system.includes("trusted child")) {
      if (last.role === "user") seen.push({ child: /trusted child (\w+)/.exec(system)[1], asked: text(last), system });
      return answer("ok");
    }
    if (last.role !== "user" || text(last).startsWith("[Fleet report")) return answer("Done.");
    const calls = text(last).split(";").map((part) => part.trim().split(" "));
    return result(calls.map(([verb, name]) => (verb === "spawn" ? call("spawn_agent", { name, task: `Task of ${name}`, area: "area" }) : call("message_agent", { to: name, text: "Go on." }))));
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  const system = `Audit the lab only.${brief ? `\n\nBRIEF IN INSTRUCTIONS: ${brief}` : ""}`;
  const fleet = createFleet({ system, costOf: () => 0, brief, changed, briefChange });
  const registry = createRegistry();
  registry.install(fleet.extension);
  const harness = await Harness.open(storage, { models, registry, settings: { retry: { maxRetries: 0 } } }, ctx);
  await fleet.attach(harness, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" }, instructions: COORDINATOR_INSTRUCTIONS } });
  return {
    harness,
    async say(content) {
      await (await root.submit({ type: "input", content }, ctx)).wait(ctx);
      await fleet.drain(ctx, { enforce: false });
    },
    async close() {
      await fleet.close();
      await harness.close(ctx);
    },
  };
}

test("a child reopened after the scope brief changed gets the new brief once; no change gives nothing extra; a new child has it in its instructions", { timeout: 20000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-brief-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
  const db = join(dir, "session.sqlite");
  const seen = [];
  const asked = (child) => seen.filter((s) => s.child === child).map((s) => s.asked);

  // The first run, with the first brief. Two children.
  let w = await worker(t, await openNodeSqliteStorage(db), { brief: "Look at the vault first.", briefChange }, seen);
  await w.say("spawn Alpha; spawn Beta");
  await w.close();
  assert.deepEqual(asked("Alpha"), ["[From coordinator] Task of Alpha"], "a new child gets nothing extra: the brief is in its instructions");
  assert.match(seen.find((s) => s.child === "Alpha").system, /BRIEF IN INSTRUCTIONS: Look at the vault first\./);

  // A follow-up with the same brief reopens Alpha: nothing extra.
  seen.length = 0;
  w = await worker(t, await openNodeSqliteStorage(db), { brief: "Look at the vault first.", briefChange }, seen);
  await w.say("message Alpha");
  await w.close();
  assert.deepEqual(asked("Alpha"), ["[From coordinator] Go on."]);

  // The operator changed the brief. A follow-up reopens Alpha and spawns Gamma.
  seen.length = 0;
  const changed = briefChange("Look at the vault first.", "Look at the router only.");
  w = await worker(t, await openNodeSqliteStorage(db), { brief: "Look at the router only.", changed, briefChange }, seen);
  await w.say("message Alpha; spawn Gamma");
  assert.deepEqual(asked("Alpha"), [`[From coordinator] Go on.\n\n${changed}`], "the reopened child reads the change, with the new brief");
  assert.match(asked("Alpha")[0], /The operator changed the scope brief\. Follow this one instead of the earlier one\.[^]*Look at the router only\./);
  // Its instructions still hold the first brief: the message is how it learns.
  assert.match(seen.find((s) => s.child === "Alpha").system, /Look at the vault first\./);
  assert.deepEqual(asked("Gamma"), ["[From coordinator] Task of Gamma"], "a child spawned now gets nothing extra");
  assert.match(seen.find((s) => s.child === "Gamma").system, /BRIEF IN INSTRUCTIONS: Look at the router only\./);
  // Once: a second message to Alpha in the same worker is plain.
  seen.length = 0;
  await w.say("message Alpha");
  assert.deepEqual(asked("Alpha"), ["[From coordinator] Go on."]);
  await w.close();

  // A later follow-up, no new change. Beta was not reopened since the change: it still gets it. Alpha and Gamma do not.
  seen.length = 0;
  w = await worker(t, await openNodeSqliteStorage(db), { brief: "Look at the router only.", briefChange }, seen);
  await w.say("message Alpha; message Beta; message Gamma");
  assert.deepEqual(asked("Beta"), [`[From coordinator] Go on.\n\n${changed}`], "a child that missed the follow-up of the change still gets it");
  assert.deepEqual([asked("Alpha"), asked("Gamma")], [["[From coordinator] Go on."], ["[From coordinator] Go on."]]);
  await w.close();

  // The operator removed the brief.
  seen.length = 0;
  w = await worker(t, await openNodeSqliteStorage(db), { brief: "", briefChange }, seen);
  await w.say("message Gamma");
  assert.deepEqual(asked("Gamma"), ["[From coordinator] Go on.\n\nThe operator removed the scope brief. Do not follow the earlier one any more."]);
  await w.close();
});

test("a child from before the roster kept briefs gets the change this worker was told about, or nothing", { timeout: 20000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-brief-old-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
  const db = join(dir, "session.sqlite");
  const seen = [];
  const asked = (child) => seen.filter((s) => s.child === child).map((s) => s.asked);
  // The roster of an older run: its children have no `brief`.
  const Roster = defineDoc({ kind: "touchstone.fleet", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ agents: [], jobs: {}, bulletin: [] }), checkpointWhen: () => false });
  let w = await worker(t, await openNodeSqliteStorage(db), { brief: "Look at the vault first.", briefChange }, seen);
  await w.say("spawn Alpha; spawn Beta");
  await w.harness.commit(async (tx) => { for (const a of (await tx.doc(Roster, ROOT_CONVERSATION_ID)).agents) delete a.brief; }, ctx);
  assert.deepEqual((await w.harness.snapshot(Roster, ROOT_CONVERSATION_ID, ctx)).agents.map((a) => [a.name, a.brief]), [["Alpha", undefined], ["Beta", undefined]]);
  await w.close();

  // A follow-up that was told of no change: the old child gets nothing extra.
  seen.length = 0;
  w = await worker(t, await openNodeSqliteStorage(db), { brief: "Look at the vault first.", briefChange }, seen);
  await w.say("message Alpha");
  await w.close();
  assert.deepEqual(asked("Alpha"), ["[From coordinator] Go on."]);

  // A follow-up that was told of a change: an old child gets that text.
  seen.length = 0;
  const changed = briefChange("Look at the vault first.", "Look at the router only.");
  w = await worker(t, await openNodeSqliteStorage(db), { brief: "Look at the router only.", changed, briefChange }, seen);
  await w.say("message Beta");
  await w.close();
  assert.deepEqual(asked("Beta"), [`[From coordinator] Go on.\n\n${changed}`]);
});

test("the engine gives the fleet the worker's brief, the change text and the change it was told about", () => {
  // agent-run.mjs runs on import, so its wiring is pinned by its source.
  const src = readFileSync(new URL("../agent-run.mjs", import.meta.url), "utf8");
  assert.match(src, /import \{[^}]*\bbriefChange\b[^}]*\} from "\.\/lib\/targets\.mjs"/);
  assert.match(src, /createFleet\(\{ system, costOf, brief: process\.env\.SCOPE_BRIEF \?\? "", briefChange, changed: process\.env\.BRIEF_CHANGE \?\? "" \}\)/);
});
