// A Review lead must become a recorded lead the moment the agent ranks it.
//
// The live ENS run ranked 17 leads in its last message, then the coordinator's
// model failed ("Stream interrupted"), and the run recorded 0 leads. The pack
// had no tool to record a lead, so a lead lived only in prose. These tests
// check that the Review pack records each lead as an event with its evidence
// (file, line, reason) as soon as it is ranked, in solo and fleet runs, and that
// a later model error does not lose it. A lead is never marked proven.
//
//   node --test spike/test/review-leads.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage as answer, fauxProvider, fauxToolCall as call } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createFleet, COORDINATOR_INSTRUCTIONS } from "../lib/fleet.mjs";
import review, { SYSTEM, KICKOFF } from "../packs/review/pack.mjs";
// Loaded per test, so on a base without the module each test fails on its own.
const leadsFrom = async (events) => (await import("../lib/leads.mjs")).leadsFrom(events);

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const SRC = "const express = require('express');\nconst app = express();\napp.get('/avatar', (req, res) => fetch(req.query.url));\nmodule.exports = app;\n";

function workspace() {
  const ws = mkdtempSync(join(tmpdir(), "review-leads-"));
  dirs.push(ws);
  mkdirSync(join(ws, "src/svc"), { recursive: true });
  writeFileSync(join(ws, "src/svc/server.js"), SRC);
  writeFileSync(join(ws, ".touchstone.json"), JSON.stringify({ pack: "review" }));
  const events = join(ws, "events.jsonl");
  writeFileSync(events, "");
  return { ws, events };
}

const fileEvents = (path) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const text = (m) => typeof m?.content === "string" ? m.content : (m?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
const systemOf = (request) => request.messages.filter((m) => m.role === "system").map((m) => text(m) + Object.values(m.sections ?? {}).join("\n")).join("\n");
const lead = { severity: "high", file: "src/svc/server.js", line: 3, title: "SSRF through the avatar url", reason: "req.query.url goes to fetch with no host check", proof: "a request with url=http://169.254.169.254/ reaches the metadata host" };

// Run one tool the way the harness does, with EVENTS_FILE set to the run's file.
async function exec(tool, args) {
  return tool.execute(args, { signal: undefined });
}

test("Review offers record_lead; a lead becomes an event with file, line and reason, never proven", async (t) => {
  const { ws, events } = workspace();
  t.mock.method(console, "log", () => {});
  process.env.EVENTS_FILE = events;
  t.after(() => { delete process.env.EVENTS_FILE; });
  const state = { poc: 0, passed: new Map(), found: [] };
  const tools = review.tools(ws, state);
  const record = tools.find((x) => x.name === "record_lead");
  assert.ok(record, "the Review pack has a record_lead tool");
  assert.ok(!tools.some((x) => x.name === "submit_finding" || x.name === "run_poc"));

  const ok = await exec(record, lead);
  assert.ok(!ok.isError, text({ content: ok.output }));
  const leads = fileEvents(events).filter((e) => e.ev === "lead");
  assert.equal(leads.length, 1, "the lead is in EVENTS_FILE at once");
  const [e] = leads;
  assert.equal(e.file, "src/svc/server.js");
  assert.equal(e.line, 3);
  assert.equal(e.severity, "high");
  assert.equal(e.reason, lead.reason);
  assert.equal(e.title, lead.title);
  assert.match(e.id, /^lead-[0-9a-f]{8,}$/);
  assert.ok(!("proven" in e), "a lead never carries a proven flag");

  // One lead per file:line. A second lead on the same line is refused as an
  // error, so the agent knows it was not recorded; it names the lead that holds it.
  const again = await exec(record, { ...lead, title: "SSRF again" });
  assert.equal(again.isError, true, "a second lead on the same line is not silently dropped");
  assert.match(text({ content: again.output }), /not recorded/i);
  assert.match(text({ content: again.output }), new RegExp(e.id));

  // Evidence must point at real source: a file the agent may read, a line in it.
  // Bad files use line 1, which every non-empty file has, so only the path
  // check can reject them. Two symlinks lead out of the workspace.
  const outside = mkdtempSync(join(tmpdir(), "review-leads-out-"));
  dirs.push(outside);
  writeFileSync(join(outside, "secret.js"), "const key = 'k';\n");
  symlinkSync(join(outside, "secret.js"), join(ws, "src/svc/secret.js"));
  symlinkSync("/etc/passwd", join(ws, "src/svc/passwd.js"));
  const badFiles = ["src/svc/nope.js", ".touchstone.json", "events.jsonl", "../etc/passwd", "/etc/passwd", "src/svc/secret.js", "src/svc/passwd.js"];
  for (const bad of [...badFiles.map((file) => ({ file, line: 1 })), { line: 99 }, { line: 0 }, { reason: "" }]) {
    const r = await exec(record, { ...lead, ...bad });
    assert.equal(r.isError, true, `rejects ${JSON.stringify(bad)}`);
  }
  assert.equal(fileEvents(events).filter((x) => x.ev === "lead").length, 1, "a rejected lead writes no event");
  assert.equal(state.leads, 1, "the pack counts recorded leads for its nudge");
});

test("the Review prompt tells the agent to record each lead as it goes", () => {
  assert.match(SYSTEM, /record_lead/);
  assert.match(KICKOFF, /record_lead/);
});

test("with no lead recorded after a clean end, Review asks once to record them", () => {
  assert.match(review.nudge({ leads: 0 }) ?? "", /record_lead/);
  assert.match(review.nudge({}) ?? "", /record_lead/);
  assert.equal(review.nudge({ leads: 2 }), null);
});

async function open(t, route, { fleet: useFleet }) {
  const { ws, events } = workspace();
  t.mock.method(console, "log", () => {});
  process.env.EVENTS_FILE = events;
  t.after(() => { delete process.env.EVENTS_FILE; });
  const faux = fauxProvider({ tokensPerSecond: 100000 });
  faux.setResponses(Array.from({ length: 60 }, () => route));
  const models = createModels();
  models.setProvider(faux.provider);
  const fleet = useFleet ? createFleet({ system: SYSTEM, costOf: () => 0, max: 2 }) : undefined;
  const registry = createRegistry();
  const tools = review.tools(ws, { poc: 0, passed: new Map(), found: [] });
  registry.install(defineExtension({ name: "review", tools: fleet ? fleet.wrapTools(tools) : tools }));
  if (fleet) registry.install(fleet.extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry, settings: { retry: { maxRetries: 0 } } }, ctx);
  await fleet?.attach(harness, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" }, instructions: fleet ? COORDINATOR_INSTRUCTIONS : SYSTEM } });
  t.after(async () => { await fleet?.close(); await harness.close(ctx); });
  return { events, root, fleet };
}

test("fleet: a child's lead is saved with its agent tag before the coordinator's model fails", { timeout: 15000 }, async (t) => {
  const r = await open(t, (request) => {
    const last = request.messages.findLast((m) => m.role !== "system");
    if (systemOf(request).includes("trusted child")) {
      if (last.role === "user") return answer([call("record_lead", lead)], { stopReason: "toolUse" });
      return answer("Lead recorded. Coverage: server.js.");
    }
    if (last.role === "user" && text(last) === KICKOFF) return answer([call("spawn_agent", { name: "Egress", task: "Check outbound fetches", area: "ssrf" })], { stopReason: "toolUse" });
    return answer([], { stopReason: "error", errorMessage: "Stream interrupted" });
  }, { fleet: true });
  let settled = await (await r.root.submit({ type: "input", content: KICKOFF }, ctx)).wait(ctx);
  settled = await r.fleet.drain(ctx) ?? settled;
  const all = fileEvents(r.events);
  assert.ok(all.some((e) => e.ev === "subagent-done"), "the child ran");
  assert.equal(all.filter((e) => e.ev === "lead").length, 1, "EVENTS_FILE holds the child's lead event");
  const leads = await leadsFrom(all);
  assert.equal(leads.length, 1, "the child's lead survives the coordinator's error");
  assert.equal(leads[0].file, "src/svc/server.js");
  assert.equal(leads[0].line, 3);
  assert.match(leads[0].agent ?? "", /^a-/, "the lead keeps the child's agent tag");
  assert.ok(!("proven" in leads[0]));
});

test("solo: a lead is saved before the model fails on its next turn", { timeout: 15000 }, async (t) => {
  const r = await open(t, (request) => {
    const last = request.messages.findLast((m) => m.role !== "system");
    if (last.role === "user") return answer([call("record_lead", lead)], { stopReason: "toolUse" });
    return answer([], { stopReason: "error", errorMessage: "Stream interrupted" });
  }, { fleet: false });
  const settled = await (await r.root.submit({ type: "input", content: KICKOFF }, ctx)).wait(ctx);
  assert.notEqual(settled.status, "done", "the model error ends the turn");
  assert.equal(fileEvents(r.events).filter((e) => e.ev === "lead").length, 1, "EVENTS_FILE holds the lead event");
  const leads = await leadsFrom(fileEvents(r.events));
  assert.equal(leads.length, 1);
  assert.equal(leads[0].reason, lead.reason);
  assert.equal(leads[0].agent, undefined, "a solo lead belongs to the root agent");
});

test("leadsFrom keeps one lead per id, the latest, and ignores other events", async () => {
  const leads = await leadsFrom([
    { ev: "lead", id: "lead-a", severity: "low", file: "a.js", line: 1, title: "x", reason: "r" },
    { ev: "bulletin-post", kind: "lead", text: "free text" },
    { ev: "lead", id: "lead-b", severity: "high", file: "b.js", line: 2, title: "y", reason: "s", agent: "a-1" },
    { ev: "lead", id: "lead-a", severity: "medium", file: "a.js", line: 1, title: "x2", reason: "r2", proven: true },
  ]);
  assert.deepEqual(leads.map((l) => [l.id, l.severity]), [["lead-b", "high"], ["lead-a", "medium"]]);
  assert.ok(leads.every((l) => !("proven" in l)), "leadsFrom drops any proven flag");
});

test("leadsFrom keeps only the known lead fields, and proof only as text", async () => {
  const [forged, typed] = await leadsFrom([
    { ev: "lead", id: "lead-x", t: 5, agent: "a-2", severity: "high", file: "x.js", line: 4, title: "t", reason: "r", proven: true, verdict: { proven: true }, pocProved: true, proof: { status: "pass" } },
    { ev: "lead", id: "lead-y", severity: "low", file: "y.js", line: 1, title: "t", reason: "r", proof: "send a request" },
  ]);
  assert.deepEqual(Object.keys(forged).sort(), ["agent", "file", "id", "line", "reason", "severity", "t", "title"]);
  assert.equal(typed.proof, "send a request");
});

test("a run records at most 200 leads; the next one is refused with a clear error", async (t) => {
  const { ws, events } = workspace();
  t.mock.method(console, "log", () => {});
  process.env.EVENTS_FILE = events;
  t.after(() => { delete process.env.EVENTS_FILE; });
  writeFileSync(join(ws, "src/svc/big.js"), Array.from({ length: 205 }, (_, i) => `const v${i} = ${i};`).join("\n") + "\n");
  const record = review.tools(ws, {}).find((x) => x.name === "record_lead");
  for (let line = 1; line <= 200; line++) {
    const r = await exec(record, { ...lead, file: "src/svc/big.js", line });
    assert.ok(!r.isError, `lead ${line} is recorded`);
  }
  const over = await exec(record, { ...lead, file: "src/svc/big.js", line: 201 });
  assert.equal(over.isError, true);
  assert.match(text({ content: over.output }), /200/);
  assert.match(text({ content: over.output }), /cap/i);
  assert.equal(fileEvents(events).filter((e) => e.ev === "lead").length, 200, "the refused lead writes no event");
});

test("an empty file has no line 1, and a proof that is not text is not stored", async (t) => {
  const { ws, events } = workspace();
  t.mock.method(console, "log", () => {});
  process.env.EVENTS_FILE = events;
  t.after(() => { delete process.env.EVENTS_FILE; });
  writeFileSync(join(ws, "src/svc/empty.js"), "");
  const record = review.tools(ws, {}).find((x) => x.name === "record_lead");
  const empty = await exec(record, { ...lead, file: "src/svc/empty.js", line: 1 });
  assert.equal(empty.isError, true, "an empty file has no line to point at");
  assert.match(text({ content: empty.output }), /0 lines/);
  const ok = await exec(record, { ...lead, proof: { status: "pass" } });
  assert.ok(!ok.isError, text({ content: ok.output }));
  const leads = fileEvents(events).filter((e) => e.ev === "lead");
  assert.equal(leads.length, 1);
  assert.ok(!("proof" in leads[0]), `a proof object is dropped, not stored as ${JSON.stringify(leads[0].proof)}`);
});
