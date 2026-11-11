import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage as answer, fauxProvider, fauxText, fauxThinking, fauxToolCall as call } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { createFleet, COORDINATOR_INSTRUCTIONS } from "../lib/fleet.mjs";
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
  async function run(content) {
    let settled = await (await root.submit({ type: "input", content }, ctx)).wait(ctx);
    settled = await fleet?.drain(ctx) ?? settled;
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
