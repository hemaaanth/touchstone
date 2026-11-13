// A follow-up really continues a fleet that a restart cut off.
//
// The app server starts no agent again after a restart (app/server/runs.mjs).
// The operator sends a message, and the follow-up worker reopens the run's saved
// session. This test shows what that reopen does in the engine, with the fake
// model provider and no network: a child that was mid-turn when its process was
// killed goes back to work, ends, and reports. It is not spawned a second time.
//
// The first process is this same file, started as a plain program. It is killed
// with SIGKILL while the child's model call is in flight: a crash, not a close.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage as answer, fauxProvider, fauxToolCall as call } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createFleet, COORDINATOR_INSTRUCTIONS } from "../lib/fleet.mjs";

const text = (message) => typeof message?.content === "string" ? message.content : (message?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
const info = (request) => ({ last: request.messages.findLast((m) => m.role !== "system"), system: request.messages.filter((m) => m.role === "system").map((m) => text(m) + Object.values(m.sections ?? {}).join("\n")).join("\n") });

// Open the run's session the way spike/agent-run.mjs does: same storage file,
// same extensions, the engine's own retry setting.
async function open(db, route, brief = {}) {
  const faux = fauxProvider({ tokensPerSecond: 100000 });
  faux.setResponses(Array.from({ length: 100 }, () => route));
  const models = createModels();
  models.setProvider(faux.provider);
  const fleet = createFleet({ system: "Audit the lab only.", costOf: (_model, input, output) => (input + output) / 1e6, max: 4, ...brief });
  const registry = createRegistry();
  registry.install(fleet.extension);
  const reports = [];
  const harness = await Harness.open(await openNodeSqliteStorage(db), { models, registry, settings: { retry: { maxRetries: 5, baseDelayMs: 20 } }, onReport: (r) => reports.push(r.kind) }, ctx);
  await fleet.attach(harness, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" }, instructions: COORDINATOR_INSTRUCTIONS } });
  return { harness, fleet, root, reports };
}

if (process.env.FLEET_CONTINUE_DB) {
  // The first server's worker. The child's model call never returns.
  const { root } = await open(process.env.FLEET_CONTINUE_DB, (request) => {
    const { last, system } = info(request);
    if (system.includes("trusted child")) {
      console.log("MIDTURN");
      return new Promise(() => {});
    }
    if (last.role === "user" && text(last) === "start") return answer([call("spawn_agent", { name: "Alpha", task: "Map calls", area: "calls" })], { stopReason: "toolUse" });
    return answer("Waiting for Alpha.");
  }, { brief: process.env.FLEET_CONTINUE_BRIEF ?? "" });
  await root.submit({ type: "input", requestId: "run1", content: "start" }, ctx);
  await new Promise(() => {});
}

test("a follow-up puts a cut-off child back to work in the saved session; it ends and reports, and is not spawned again", { timeout: 60000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-continue-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "run.sqlite");

  // The fleet works, then its process dies while the child is mid-turn.
  const first = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, FLEET_CONTINUE_DB: db, NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  first.stderr.on("data", (d) => { err += d; });
  await new Promise((resolve, reject) => {
    first.stdout.on("data", (d) => { out += d; if (out.includes("MIDTURN")) resolve(); });
    first.on("exit", (code) => reject(new Error(`the first worker exited early (${code}): ${err.slice(-600)}`)));
  });
  const before = out.split("\n").filter((l) => l.startsWith("EVENT ")).map((l) => JSON.parse(l.slice(6)));
  const child = before.find((e) => e.ev === "subagent-spawned");
  assert.equal(child.name, "Alpha");
  assert.ok(before.some((e) => e.ev === "agent-status" && e.id === child.id && e.state === "working"));
  assert.ok(!before.some((e) => e.ev === "subagent-done"), "the child had not ended");
  first.removeAllListeners("exit");
  first.kill("SIGKILL");
  await new Promise((resolve) => first.on("exit", resolve));

  // The follow-up worker (chat() in spike/agent-run.mjs): reopen, submit the
  // operator's message, wait for it and for the fleet.
  const events = [];
  t.mock.method(console, "log", (line) => { if (String(line).startsWith("EVENT ")) events.push(JSON.parse(line.slice(6))); });
  let childCalls = 0;
  const second = await open(db, (request) => {
    const { system } = info(request);
    if (system.includes("trusted child")) { childCalls++; return answer("Calls mapped. No verdict without replay."); }
    return answer("Noted.");
  });
  t.after(async () => { await second.fleet.close(); await second.harness.close(ctx); });
  const sub = await second.root.submit({ type: "input", requestId: "followup-1", content: "Continue the audit from where it stopped." }, ctx);
  let settled = await sub.wait(ctx);
  settled = await second.fleet.drain(ctx, { enforce: false }) ?? settled;
  assert.equal(settled.status, "done");

  // The same child went back to work, ended, and reported to the coordinator.
  assert.ok(events.some((e) => e.ev === "agent-status" && e.id === child.id && e.state === "working"));
  assert.deepEqual(events.filter((e) => e.ev === "subagent-done").map((e) => [e.id, e.status]), [[child.id, "done"]]);
  assert.ok(events.some((e) => e.ev === "agent-message" && e.from === child.id && e.to === "coordinator" && /Alpha completed: Calls mapped/.test(e.text)));
  assert.ok(childCalls >= 1);
  // Not spawned a second time: one child in the roster, in its first conversation.
  assert.equal(events.filter((e) => e.ev === "subagent-spawned").length, 0);
  const view = await (await second.harness.conversation(Number(child.conv), ctx)).context(ctx);
  assert.ok(view.messages.some((m) => m.role === "assistant" && /Calls mapped/.test(text(m))));
});

test("a child that a restart cut off, reopened after the scope brief changed, reads the change in the turn it goes back to; with no change it reads nothing extra", { timeout: 90000 }, async (t) => {
  const { briefChange } = await import("../lib/targets.mjs");
  // The first worker has the first brief. It dies while the child is mid-turn. Then a follow-up reopens the session.
  async function cutOffThenReopen(now) {
    const dir = mkdtempSync(join(tmpdir(), "fleet-continue-brief-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const db = join(dir, "run.sqlite");
    const first = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, FLEET_CONTINUE_DB: db, FLEET_CONTINUE_BRIEF: "First brief.", NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    await new Promise((resolve, reject) => {
      first.stdout.on("data", (d) => { out += d; if (out.includes("MIDTURN")) resolve(); });
      first.on("exit", (code) => reject(new Error(`the first worker exited early (${code})`)));
    });
    first.removeAllListeners("exit");
    first.kill("SIGKILL");
    await new Promise((resolve) => first.on("exit", resolve));
    const asked = []; // every user text the child's model call holds when it goes back to work
    const changed = briefChange("First brief.", now);
    const second = await open(db, (request) => {
      const { system } = info(request);
      if (!system.includes("trusted child")) return answer("Noted.");
      asked.push(request.messages.filter((m) => m.role === "user").map(text));
      return answer("Calls mapped.");
    }, { brief: now, briefChange, changed });
    const sub = await second.root.submit({ type: "input", requestId: "followup-1", content: "Continue the audit from where it stopped." }, ctx);
    await sub.wait(ctx);
    await second.fleet.drain(ctx, { enforce: false });
    await second.fleet.close();
    await second.harness.close(ctx);
    return { asked, changed };
  }
  t.mock.method(console, "log", () => {});
  const same = await cutOffThenReopen("First brief.");
  assert.ok(same.asked.length >= 1, "the child went back to work");
  assert.deepEqual(same.asked.flat().filter((m) => /scope brief/.test(m)), [], "no change: nothing extra");
  const moved = await cutOffThenReopen("Second brief.");
  assert.match(moved.changed, /^The operator changed the scope brief\.[^]*Second brief\./);
  assert.ok(moved.asked.some((messages) => messages.includes(moved.changed)), "the child reads the change");
  assert.equal(moved.asked.flat().filter((m) => m === moved.changed).length >= 1, true);
  // Said once: no model call of the child holds the change twice.
  for (const messages of moved.asked) assert.ok(messages.filter((m) => m === moved.changed).length <= 1);
});
