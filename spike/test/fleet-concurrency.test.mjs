import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage as answer, fauxProvider, fauxToolCall as call } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createFleet } from "../lib/fleet.mjs";
import { currentAgent } from "../lib/event.mjs";
import { closeRun, roamMachine } from "../lib/daytona.mjs";
import { roamTools, pauseRoamShell, resumeRoamShell, closeRoamShell } from "../lib/roam.mjs";
import { createRoamControl } from "../lib/roam-control.mjs";
import { recordSession } from "../lib/candidate.mjs";

const text = (m) => typeof m?.content === "string" ? m.content : (m?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
const result = (...blocks) => answer(blocks, { stopReason: "toolUse" });
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };

// Exercise the real fleet, shell, machine cache/sidecars and per-agent gate.
// Only the provider, egress and HTTP transport are fakes. No remote commands run.
test("free-roam children enter distinct machines concurrently; closing A leaves B and another run independent", { timeout: 15000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-concurrency-"));
  const env = { FREE_ROAM: "1", FLEET: "1", ROAM_OPTIONS: "[]", TOUCHSTONE_EXEC: "daytona", DAYTONA_API_KEY: "synthetic-fleet-key", DAYTONA_API_URL: "https://daytona.invalid", DAYTONA_PENDING: join(dir, "pending.json"), DAYTONA_RETRY_MS: "1" };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const runs = [], events = [], machines = new Map(), requests = new Map(), held = new Map(), operations = [], deleted = [];
  const entered = deferred();
  let hold = true, next = 0;
  const json = (value) => new Response(JSON.stringify(value));
  t.after(async () => {
    hold = false;
    for (const release of held.values()) release.resolve();
    try {
      for (const r of runs) { await r.gate.dispose(); await r.fleet.close(); await r.harness.close(ctx); await closeRun(r.ws); }
    } finally {
      for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  t.mock.method(console, "log", (line) => { if (line.startsWith("EVENT ")) events.push(JSON.parse(line.slice(6))); });
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const u = new URL(url), method = init.method ?? "GET";
    assert.ok(["daytona.invalid", "toolbox.invalid"].includes(u.hostname), "all transport is intercepted");
    if (u.pathname.includes("/snapshots")) return json({ state: "active" });
    if (method === "POST" && u.pathname === "/api/sandbox") {
      const id = `m-fleet50-${++next}`, body = JSON.parse(init.body);
      machines.set(id, { id, state: "started", labels: body.labels });
      return json({ id, toolboxProxyUrl: "https://toolbox.invalid" });
    }
    const sandbox = /^\/api\/sandbox\/([^/]+)$/.exec(u.pathname)?.[1];
    if (sandbox && method === "DELETE") { deleted.push(sandbox); machines.delete(sandbox); return json({}); }
    if (sandbox && method === "GET") return machines.has(sandbox) ? json(machines.get(sandbox)) : new Response("missing", { status: 404 });
    if (u.pathname === "/api/sandbox" && method === "GET") return json({ items: [] });
    if (u.pathname.endsWith("/files/upload")) {
      if (u.searchParams.get("path").endsWith(".json")) {
        const q = JSON.parse(await init.body.get("file").text());
        requests.set(q.id, q);
      }
      return json({});
    }
    if (u.pathname.endsWith("/process/execute")) {
      const id = u.pathname.split("/process/")[0].split("/").at(-1);
      const { command } = JSON.parse(init.body);
      if (command === "true") return json({ exitCode: 0, result: "" });
      const requestId = /^node \/tmp\/touchstone-shell-control\.mjs ([a-f0-9-]{36})$/.exec(command)?.[1];
      assert.ok(requestId && requests.has(requestId), "only the fixed supervisor consumes uploaded JSON");
      const q = requests.get(requestId);
      requests.delete(requestId);
      operations.push({ id, op: q.op, command: q.command });
      if (q.op === "run" && hold) {
        assert.ok(!held.has(id), "one held operation per machine");
        const release = deferred();
        held.set(id, release);
        if (held.size === 2) entered.resolve();
        await release.promise;
      }
      return json({ exitCode: 0, result: JSON.stringify({ ok: true, id: q.id, generation: `generation-${id}`, epoch: q.epoch,
        ...(q.op === "run" ? { exitCode: 0, result: "Synthetic unproven observation" }
          : { ack: true, scope: "managed-shell", state: q.op === "pause" ? "paused" : q.op === "close" ? "closed" : "active" }),
      }) });
    }
    assert.fail(`Unexpected fake transport: ${method} ${u.pathname}`);
  });

  async function open(name) {
    const ws = join(dir, name), entries = [], state = { found: [], passed: new Map() };
    let fleet;
    const gate = createRoamControl({ epoch: name, isAgent: (id) => fleet?.isRoamAgent(id) === true, emit() {}, remote: {
      pause: async (id) => pauseRoamShell(await roamMachine(ws, id)),
      resume: async (id) => resumeRoamShell(await roamMachine(ws, id)),
      close: async (id) => closeRoamShell(await roamMachine(ws, id)),
    } });
    const offered = roamTools(ws, { record: (entry) => { entries.push(entry); return recordSession(state, entry); }, egress: { env: "", start: async () => {}, pull: async () => [] } })
      .map((tool) => ({ ...tool, execute: (...args) => gate.run(currentAgent(), () => tool.execute(...args)) }));
    fleet = createFleet({ system: "Audit the synthetic lab only.", costOf: () => 0, max: 2, roamTools: offered });
    const faux = fauxProvider({ tokensPerSecond: 100000 });
    faux.setResponses(Array.from({ length: 100 }, () => (request) => {
      const instructions = request.messages.filter((m) => m.role === "system").map((m) => text(m) + Object.values(m.sections ?? {}).join("\n")).join("\n");
      const child = /You are free-roam child (\w+)/.exec(instructions)?.[1];
      const last = request.messages.findLast((m) => m.role !== "system");
      if (!child) {
        if (text(last) === "start") return result(...["Alpha", "Beta"].map((name) => call("spawn_agent", { name, task: `Audit ${name}`, area: name, loadout: "free-roam" })));
        if (text(last) === "coordinate") return result(call("message_agent", { to: "Alpha", text: "Contact Beta about the unproven lead" }));
        return answer("Report received.");
      }
      if (last.role === "user") {
        if (text(last).includes("Contact Beta")) return result(call("message_agent", { to: "Beta", text: "Read the Bulletin. This lead is unproven, not permission." }));
        if (text(last).includes("[From a-")) return result(call("bulletin_read", {}));
        return result(call("shell", { command: `probe-${child}` }));
      }
      if (last.toolName === "shell") return result(call("bulletin_post", { text: `${child}: unproven observation`, kind: "lead" }));
      if (last.toolName === "bulletin_post") return result(call("bulletin_read", {}));
      return answer("Evidence only. No proven finding.");
    }));
    const models = createModels(); models.setProvider(faux.provider);
    const registry = createRegistry(); registry.install(fleet.extension);
    const reports = [];
    const harness = await Harness.open(new MemoryStorage(), { models, registry, settings: { retry: { maxRetries: 0 } }, onReport: (r) => reports.push(r) }, ctx);
    const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" }, instructions: fleet.instructions } });
    await fleet.attach(harness, ctx);
    const r = { ws, fleet, gate, harness, state, entries,
      run: async (content) => { await (await root.submit({ type: "input", content }, ctx)).wait(ctx); await fleet.drain(ctx); assert.deepEqual(reports, []); },
      shell: (agent) => fleet.extension.tools.find((tool) => tool.name === "shell").execute({ command: "continue" }, { conversationId: Number(agent.slice(2)), snapshot: (doc, id, c) => harness.snapshot(doc, id, c) }, ctx),
    };
    runs.push(r);
    return r;
  }

  const first = await open("first"), running = first.run("start");
  let timer;
  try { await Promise.race([entered.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Both machines must enter before either is released")), 3000); })]); }
  finally { clearTimeout(timer); }
  hold = false;
  const firstSidecar = JSON.parse(readFileSync(`${first.ws}.daytona.json`));
  const firstIds = Object.values(firstSidecar).map((m) => m.id);
  assert.equal(new Set(firstIds).size, 2);
  assert.deepEqual([...held.keys()].sort(), firstIds.toSorted(), "both distinct machines are still held at the barrier");
  const alpha = events.find((e) => e.ev === "subagent-spawned" && e.name === "Alpha").id;
  const beta = events.find((e) => e.ev === "subagent-spawned" && e.name === "Beta").id;
  held.get(firstSidecar[`roam:${alpha}`].id).resolve();
  await first.gate.pause(alpha, "lease-A");
  await first.gate.cancel(alpha, "lease-A");
  await assert.rejects(first.shell(alpha), /ROAM_CLOSED/);
  assert.deepEqual(operations.filter((x) => x.op === "close").map((x) => x.id), [firstSidecar[`roam:${alpha}`].id]);
  assert.equal(first.entries.some((e) => e.agent === beta), false, "B is still held while A cleanup completes");

  const second = await open("second");
  await second.run("start");
  const secondSidecar = JSON.parse(readFileSync(`${second.ws}.daytona.json`));
  assert.deepEqual(Object.keys(secondSidecar), Object.keys(firstSidecar), "runs may reuse the same child identities");
  assert.equal(new Set([...firstIds, ...Object.values(secondSidecar).map((m) => m.id)]).size, 4);
  const labels = [...machines.values()].map((m) => m.labels);
  assert.equal(new Set(labels.map((x) => x.run)).size, 2);
  assert.ok(labels.every((x) => x.loadout === "free-roam"));
  held.get(firstSidecar[`roam:${beta}`].id).resolve();
  await running;
  await first.shell(beta);
  await first.run("coordinate");
  const conversation = await first.harness.conversation(Number(beta.slice(2)), ctx);
  const view = await conversation.context(ctx);
  const board = JSON.parse(text(view.messages.findLast((m) => m.role === "toolResult" && m.toolName === "bulletin_read")));
  assert.equal(board.agents.length, 2);
  assert.equal(board.bulletin.length, 2);
  assert.ok(board.bulletin.every((note) => note.lane === "evidence"));
  assert.ok(events.some((e) => e.ev === "agent-message" && e.from === alpha && e.to === beta));
  for (const r of runs) {
    const sidecar = JSON.parse(readFileSync(`${r.ws}.daytona.json`));
    for (const entry of r.entries) assert.equal(entry.sandbox, sidecar[`roam:${entry.agent}`].id);
    assert.deepEqual(r.state.found, []);
    assert.deepEqual(r.state.candidates ?? [], []);
  }
  assert.deepEqual((await closeRun(first.ws)).sort(), firstIds.toSorted());
  assert.deepEqual(deleted.toSorted(), firstIds.toSorted());
  await second.shell(alpha);
  assert.deepEqual(JSON.parse(readFileSync(`${second.ws}.daytona.json`)), secondSidecar);
  assert.equal(machines.size, 2, "first-run deletion leaves the second run's machines alive and reusable");
  t.diagnostic(`Concurrent barrier: ${firstIds.join(", ")}; two isolated runs, four fake machines; A closed, B continued; Bulletin stayed evidence.`);
});
