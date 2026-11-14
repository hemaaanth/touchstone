import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage as answer, fauxProvider, fauxToolCall as call } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, Harness, MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { withAgent } from "../lib/event.mjs";

const request = { kind: "question", question: "Continue this task?" };
let sequence = 0;
async function engine(t) {
  const api = await import(`../lib/ask.mjs?test=${++sequence}`);
  const events = [];
  const file = process.env.EVENTS_FILE;
  delete process.env.EVENTS_FILE;
  t.mock.method(console, "log", (line) => { if (line.startsWith("EVENT ")) events.push(JSON.parse(line.slice(6))); });
  t.after(() => {
    api.disposeAsks();
    if (file === undefined) delete process.env.EVENTS_FILE;
    else process.env.EVENTS_FILE = file;
  });
  return { ...api, events };
}

async function open(storage, api) {
  const faux = fauxProvider({ tokensPerSecond: 100000 });
  faux.setResponses(Array.from({ length: 8 }, () => (generation) => {
    const last = generation.messages.findLast((m) => m.role !== "system");
    return last.role === "user" ? answer([call("ask_human", request)], { stopReason: "toolUse" }) : answer("Finished.");
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(defineExtension({ name: "ask", tools: [api.askHumanTool] }));
  const harness = await Harness.open(storage, { models, registry, settings: { retry: { maxRetries: 0 } } }, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" }, instructions: "Ask the human." } });
  return { harness, root };
}

if (process.env.ASK_CRASH_DB) {
  delete process.env.EVENTS_FILE;
  const api = await import("../lib/ask.mjs");
  const { root } = await open(await openNodeSqliteStorage(process.env.ASK_CRASH_DB), api);
  await root.submit({ type: "input", requestId: "ask-1", content: "Ask." }, ctx);
  await new Promise(() => {});
} else {
  test("matching ID resolves once; answer event keeps the asking identity", async (t) => {
    const e = await engine(t);
    const pending = withAgent("a-2", () => e.askHuman({ ...request, detail: { task: "review" }, agent: "a-forged" }));
    const ask = e.events[0];
    assert.equal(ask.agent, "a-2");
    assert.deepEqual(ask.detail, { task: "review" });
    assert.equal(e.answerAsk({ ask: "wrong-id", done: true }), false);
    assert.equal(e.events.length, 1);
    assert.equal(withAgent("a-99", () => e.answerAsk({ ask: ask.id, done: true })), true);
    assert.deepEqual(await pending, { done: true });
    assert.equal(e.answerAsk({ ask: ask.id, done: false }), false);
    assert.deepEqual(e.events.map(({ ev, agent, answer }) => ({ ev, agent, answer })), [
      { ev: "ask-human", agent: "a-2", answer: undefined },
      { ev: "ask-answered", agent: "a-2", answer: "done" },
    ]);
    const next = withAgent("a-2", () => e.askHuman(request));
    assert.notEqual(e.events.at(-1).id, ask.id);
    assert.equal(e.answerAsk({ ask: ask.id, done: true }), false);
    e.answerAsk({ ask: e.events.at(-1).id, done: false });
    assert.deepEqual(await next, { done: false });
  });

  test("malformed answers leave the ask pending", async (t) => {
    const e = await engine(t);
    const pending = e.askHuman(request);
    const id = e.events[0].id;
    for (const line of [null, [], "{}", {}, { ask: id }, { ask: id, done: "true" }, { ask: id, done: 1 },
      { ask: id, reply: "" }, { ask: id, reply: "  " }, { ask: id, reply: "x".repeat(4001) },
      { ask: id, done: true, reply: "yes" }, { ask: id, done: true, text: "steer" },
      { ask: id, done: true, agent: "coordinator" }, { ask: 7, done: true },
      Object.assign(Object.create({ ask: id }), { done: true })]) {
      assert.equal(e.answerAsk(line), false);
    }
    assert.equal(e.events.length, 1);
    assert.equal(e.answerAsk({ ask: id, reply: "x".repeat(4000) }), true);
    assert.deepEqual(await pending, { reply: "x".repeat(4000) });
    assert.equal(e.events.at(-1).answer, "reply");
    assert.ok(!JSON.stringify(e.events).includes("x".repeat(4000)));
  });

  test("cancellation and replies cannot approve a gated action", async (t) => {
    const e = await engine(t);
    let actions = 0;
    const gated = async () => {
      const result = await e.askHuman({ ...request, kind: "wallet-spend" });
      if (result.done !== true) return "not approved";
      actions++;
      return "sent";
    };
    for (const result of [{ done: false }, { reply: "done" }, { reply: "yes, approved" }, { done: true }]) {
      const wait = gated();
      e.answerAsk({ ask: e.events.at(-1).id, ...result });
      assert.equal(await wait, result.done === true ? "sent" : "not approved");
    }
    assert.equal(actions, 1);
    assert.ok(!JSON.stringify(e.events).includes("yes, approved"));
  });

  test("each agent has one independent pending ask, including the coordinator", async (t) => {
    const e = await engine(t);
    const root = e.askHuman(request);
    const a = withAgent("a-2", () => e.askHuman(request));
    const b = withAgent("a-3", () => e.askHuman(request));
    await assert.rejects(withAgent("a-2", () => e.askHuman(request)), /already has a pending ask/);
    await assert.rejects(e.askHuman(request), /already has a pending ask/);
    const asks = e.events.slice();
    assert.deepEqual(asks.map((event) => event.agent), ["coordinator", "a-2", "a-3"]);
    e.answerAsk({ ask: asks[2].id, reply: "B context" });
    e.answerAsk({ ask: asks[0].id, done: false });
    e.answerAsk({ ask: asks[1].id, done: true });
    assert.deepEqual(await Promise.all([root, a, b]), [{ done: false }, { done: true }, { reply: "B context" }]);
    assert.deepEqual(e.events.slice(3).map((event) => event.agent), ["a-3", "coordinator", "a-2"]);
  });

  test("30 minutes cancels the wait and makes a late approval stale", async (t) => {
    const e = await engine(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = e.askHuman(request);
    const id = e.events[0].id;
    t.mock.timers.tick(30 * 60_000 - 1);
    assert.equal(e.events.length, 1);
    t.mock.timers.tick(1);
    assert.deepEqual(await pending, { done: false });
    assert.equal(e.events.at(-1).answer, "cancel");
    assert.equal(e.answerAsk({ ask: id, done: true }), false);
  });

  test("abort releases only its wait; an already aborted signal never asks", async (t) => {
    const e = await engine(t);
    const controller = new AbortController();
    const pending = withAgent("a-2", () => e.askHuman(request, { signal: controller.signal }));
    const root = e.askHuman(request);
    controller.abort();
    assert.deepEqual(await pending, { done: false });
    assert.equal(e.answerAsk({ ask: e.events[0].id, done: true }), false);
    const count = e.events.length;
    assert.deepEqual(await e.askHuman(request, { signal: controller.signal }), { done: false });
    assert.equal(e.events.length, count);
    e.answerAsk({ ask: e.events[1].id, done: false });
    await root;
  });

  test("disposal releases every wait and future asks fail closed", async (t) => {
    const e = await engine(t);
    const waits = [e.askHuman(request), withAgent("a-2", () => e.askHuman(request))];
    e.disposeAsks();
    e.disposeAsks();
    assert.deepEqual(await Promise.all(waits), [{ done: false }, { done: false }]);
    assert.equal(e.events.filter((event) => event.ev === "ask-answered").length, 2);
    for (const ask of e.events.filter((event) => event.ev === "ask-human")) assert.equal(e.answerAsk({ ask: ask.id, done: true }), false);
    assert.deepEqual(await e.askHuman(request), { done: false });
  });

  test("invalid questions and event failures create no stuck ask or approval", async (t) => {
    const e = await engine(t);
    for (const bad of [{ ...request, kind: "password" }, { ...request, question: " " }, { ...request, question: 4 }, { ...request, question: "x".repeat(4001) }]) {
      await assert.rejects(e.askHuman(bad), /Ask needs/);
    }
    const cyclic = {}; cyclic.self = cyclic;
    await assert.rejects(e.askHuman({ ...request, detail: cyclic }), /circular/i);
    const pending = e.askHuman(request);
    e.answerAsk({ ask: e.events.at(-1).id, done: false });
    assert.deepEqual(await pending, { done: false });
  });

  test("ordinary tool derives identity from runtime, not model or inherited tags", async (t) => {
    const e = await engine(t);
    for (const conversationId of [ROOT_CONVERSATION_ID, 7]) {
      const wait = withAgent("a-forged", () => e.askHumanTool.execute({ ...request, agent: "a-model", id: "forged" }, { conversationId }, ctx));
      const ask = e.events.at(-1);
      assert.equal(ask.agent, conversationId === ROOT_CONVERSATION_ID ? "coordinator" : "a-7");
      e.answerAsk({ ask: ask.id, reply: "  ordinary reply  " });
      assert.deepEqual(await wait, { output: [{ type: "text", text: "ordinary reply" }] });
    }
    await assert.rejects(e.askHumanTool.execute(request, {}, ctx), /trusted conversation ID/);
  });

  test("installed runtime waits for an answer and closes without stranding asks", { timeout: 10000 }, async (t) => {
    const e = await engine(t);
    let appeared;
    const ask = new Promise((resolve) => { appeared = resolve; });
    t.mock.method(console, "log", (line) => {
      if (!line.startsWith("EVENT ")) return;
      const event = JSON.parse(line.slice(6));
      e.events.push(event);
      if (event.ev === "ask-human") appeared(event);
    });
    const { harness, root } = await open(new MemoryStorage(), e);
    t.after(() => harness.close(ctx));
    const sub = await root.submit({ type: "input", requestId: "ask-1", content: "Ask." }, ctx);
    const first = await ask;
    assert.equal(e.answerAsk({ ask: first.id, done: false }), true);
    assert.equal((await sub.wait(ctx)).status, "done");
    const view = await root.context(ctx);
    assert.ok(view.messages.some((m) => m.role === "toolResult" && m.toolName === "ask_human" && m.content.some((p) => p.text === "cancelled")));
    const secondAsk = new Promise((resolve) => { appeared = resolve; });
    await root.submit({ type: "input", requestId: "ask-2", content: "Ask again." }, ctx);
    const second = await secondAsk;
    await harness.close(ctx);
    assert.equal(e.answerAsk({ ask: second.id, done: true }), false);
    assert.ok(e.events.some((event) => event.ev === "ask-answered" && event.id === second.id && event.answer === "cancel"));
  });

  test("crash recovery does not replay an interrupted ask or reuse its ID", { timeout: 15000 }, async (t) => {
    const e = await engine(t);
    const dir = mkdtempSync(join(tmpdir(), "ask-replay-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const db = join(dir, "run.sqlite");
    const worker = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, ASK_CRASH_DB: db, NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => { if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL"); });
    let out = "", err = "";
    worker.stderr.on("data", (chunk) => { err += chunk; });
    const first = await new Promise((resolve, reject) => {
      worker.on("error", reject);
      worker.once("exit", (code) => reject(new Error(`Ask worker exited early (${code}): ${err}`)));
      worker.stdout.on("data", (chunk) => {
        out += chunk;
        const line = out.split("\n").find((line) => line.startsWith("EVENT ") && line.includes('"ask-human"'));
        if (line) { try { resolve(JSON.parse(line.slice(6))); } catch {} }
      });
    });
    const exited = once(worker, "exit");
    worker.kill("SIGKILL");
    await exited;
    const { harness, root } = await open(await openNodeSqliteStorage(db), e);
    t.after(() => harness.close(ctx));
    const sub = await root.submit({ type: "input", requestId: "ask-1", content: "Ask." }, ctx);
    assert.equal((await sub.wait(ctx)).status, "done");
    const view = await root.context(ctx);
    const result = view.messages.find((m) => m.role === "toolResult" && m.toolName === "ask_human");
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /interrupted/i);
    assert.equal(e.events.filter((event) => event.ev === "ask-human").length, 0);
    assert.equal(e.answerAsk({ ask: first.id, done: true }), false);
  });
}
