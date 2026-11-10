// Tests 5-7 through a real pi-durable loop on NEAR AI Cloud.
//   node smoke-durable.mjs t5            tool loop with replayed reasoning (#1369), all models x REPS
//   node smoke-durable.mjs t6            kill mid-tool and mid-answer, then resume
//   node smoke-durable.mjs t7            approval wait, kill while waiting, resume, approve
//   node smoke-durable.mjs child ...     internal: one worker process for t6/t7
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createRegistry, defineDoc, defineDocFamily, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { obj, str } from "@earendil-works/pi-schema";
import { MODELS, charge, guard, spent } from "./lib/near.mjs";

const ctx = BACKGROUND_CONTEXT;
const DIR = new URL("./results/durable/", import.meta.url).pathname;
mkdirSync(DIR, { recursive: true });
const ADDR_A = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const ADDR_B = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const BAL = { [ADDR_A.toLowerCase()]: "12.5", [ADDR_B.toLowerCase()]: "3.25" };

// ---- NEAR as a pi-ai provider.
function nearModels() {
  const list = Object.values(MODELS).map((m) => ({
    id: m.id,
    name: m.id,
    api: "openai-completions",
    provider: "near",
    baseUrl: "https://cloud-api.near.ai/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: m.input, output: m.output, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.context,
    maxTokens: 8192,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, thinkingFormat: "openai" },
  }));
  const models = createModels();
  models.setProvider(createProvider({
    id: "near",
    name: "NEAR AI Cloud",
    baseUrl: "https://cloud-api.near.ai/v1",
    auth: { apiKey: envApiKeyAuth("NEAR AI key", ["NEARAI_API_KEY"]) },
    models: list,
    api: openAICompletionsApi(),
  }));
  return models;
}

// ---- Approval state: one doc per request, plus an index the host watches.
const Approval = defineDocFamily({
  kind: "app.approval", version: 1, scope: "session", family: true,
  initial: (seed) => ({ ...seed, status: "pending" }),
  checkpointWhen: () => false,
});
const Pending = defineDoc({
  kind: "app.pending", version: 1, scope: "session",
  initial: () => ({ ids: [] }),
  checkpointWhen: () => false,
});

// ---- Events go to stdout (parent reads them) and to a counter file (survives kills).
function event(name, data = {}) {
  const line = JSON.stringify({ t: Date.now(), ev: name, ...data });
  console.log("EVENT " + line);
  if (process.env.EVENTS_FILE) appendFileSync(process.env.EVENTS_FILE, line + "\n");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slowOnce = (marker, ms) => {
  // Slow only on the first run of a scenario, so the resumed process does not wait again.
  if (!marker || existsSync(marker)) return 0;
  writeFileSync(marker, "1");
  return ms;
};

function tools() {
  const getBalance = defineTool({
    name: "get_balance",
    description: "Read the native ETH balance of an address on the forked chain. Returns the balance in ETH.",
    parameters: obj({ address: str({ description: "0x-prefixed address" }) }),
    replay: "safe",
    execute: async (args) => {
      event("tool-start", { tool: "get_balance", address: args.address });
      const wait = slowOnce(process.env.SLOW_BALANCE_MARKER, 20_000);
      if (wait) await sleep(wait);
      const bal = BAL[String(args.address).toLowerCase()];
      event("tool-done", { tool: "get_balance" });
      if (!bal) throw new Error(`Unknown address ${args.address}`);
      return { output: [{ type: "text", text: `${bal} ETH` }] };
    },
  });
  const runPoc = defineTool({
    name: "run_poc",
    description: "Run a Foundry proof of concept test on the fork and return its output.",
    parameters: obj({ test_name: str() }),
    replay: "unsafe",
    execute: async (args) => {
      event("tool-start", { tool: "run_poc", test: args.test_name });
      const wait = slowOnce(process.env.SLOW_POC_MARKER, 20_000);
      if (wait) await sleep(wait);
      event("tool-done", { tool: "run_poc" });
      return { output: [{ type: "text", text: `[PASS] ${args.test_name}() (gas: 184211)\nattacker balance after: 12.5 ETH\n1 passed; 0 failed` }] };
    },
  });
  const sendTx = defineTool({
    name: "send_tx",
    description: "Send ETH on the fork. Every call needs a human approval before it runs.",
    parameters: obj({ to: str(), amount_eth: str() }),
    replay: "safe",
    execute: async (args, api, c) => {
      // Stable across reruns: the same approval request after a crash.
      const id = await api.memo("approvalId", randomUUID(), c);
      await api.commit(async (tx) => {
        await tx.doc(Approval, id, { tool: "send_tx", args });
        const p = await tx.doc(Pending);
        if (!p.ids.includes(id)) p.ids.push(id);
      }, c);
      event("approval-pending", { id });
      const watch = await api.watchDoc(Approval, id, c);
      const decided = await new Promise((resolve) => {
        if (watch.value.status !== "pending") return resolve(watch.value);
        watch.start(async (call) => {
          if (call.kind === "value" && call.value.status !== "pending") resolve(call.value);
        });
      });
      await watch.stop();
      event("approval-decided", { id, status: decided.status });
      if (decided.status !== "approved") throw new Error(`Denied by ${decided.by ?? "reviewer"}`);
      return { output: [{ type: "text", text: `sent ${args.amount_eth} ETH to ${args.to}, tx 0x9f3c...e1` }] };
    },
  });
  return [getBalance, runPoc, sendTx];
}

async function open(dbPath, alias) {
  const registry = createRegistry();
  registry.install(defineExtension({ name: "smoke", tools: tools() }));
  const reports = [];
  const harness = await Harness.open(await openNodeSqliteStorage(dbPath), {
    models: nearModels(),
    registry,
    settings: { retry: { maxRetries: 2 }, stream: { timeoutMs: 180_000 } },
    onReport: (r) => reports.push({ kind: r.kind, reason: r.reason, msg: String(r.error?.message ?? r.error ?? "").slice(0, 200) }),
  }, ctx);
  const root = await harness.root(ctx, {
    agent: { model: { provider: "near", modelId: MODELS[alias].id } },
  });
  return { harness, root, reports };
}

// Summarize the transcript: tool calls, tool results, and the final answer.
async function summarize(root) {
  const view = await root.context(ctx);
  const msgs = view.messages;
  const calls = [], results = [], assistants = [];
  for (const m of msgs) {
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      const thinking = m.content.filter((b) => b.type === "thinking").map((b) => b.thinking ?? "").join("").length;
      const tc = m.content.filter((b) => b.type === "toolCall");
      tc.forEach((b) => calls.push({ name: b.name, args: b.arguments }));
      assistants.push({ stop: m.stopReason, text: text.slice(0, 300), thinkingChars: thinking, toolCalls: tc.length, error: m.errorMessage?.slice(0, 200) });
    }
    if (m.role === "toolResult") {
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      results.push({ name: m.toolName, isError: !!m.isError, text: text.slice(0, 200) });
    }
  }
  return { calls, results, assistants, final: assistants.at(-1) };
}

async function chargeUsage(harness, label) {
  const u = await harness.usage(ctx);
  let usd = 0;
  for (const [key, v] of Object.entries(u.models ?? {})) {
    const id = key.replace(/^near\//, "");
    usd += charge(id, { input: v.input, output: v.output });
  }
  return { usd, models: Object.fromEntries(Object.entries(u.models ?? {}).map(([k, v]) => [k, { in: v.input, out: v.output, reasoning: v.reasoning }])) };
}

// ---------------- t5: multi-step tool loop, reasoning replayed after tool results.
async function t5() {
  const REPS = Number(process.env.REPS ?? 3);
  const ONLY = process.env.ONLY?.split(",");
  const rows = [];
  await Promise.all(Object.keys(MODELS).filter((a) => !ONLY || ONLY.includes(a)).map(async (alias) => {
    for (let rep = 0; rep < REPS; rep++) {
      guard(0.03);
      const db = `${DIR}t5-${alias}-${rep}.sqlite`;
      rmSync(db, { force: true }); rmSync(db + "-wal", { force: true }); rmSync(db + "-shm", { force: true });
      const t0 = Date.now();
      const { harness, root, reports } = await open(db, alias);
      let row;
      try {
        const sub = await root.submit({
          type: "input",
          requestId: `t5-${rep}`,
          content: `Step 1: get the ETH balances of ${ADDR_A} and ${ADDR_B} with get_balance. Step 2: run the PoC named test_vault_drain with run_poc. Step 3: answer in one line with the sum of both balances in ETH and whether the PoC passed.`,
        }, ctx);
        const settled = await sub.wait(ctx);
        const s = await summarize(root);
        const addrs = new Set(s.calls.filter((c) => c.name === "get_balance").map((c) => String(c.args?.address).toLowerCase()));
        const ranPoc = s.calls.some((c) => c.name === "run_poc");
        const finalText = s.final?.text ?? "";
        // #1369 symptom: a stop with no text after tool results.
        const emptyStopAfterTools = s.assistants.some((a, i) => i > 0 && a.stop === "stop" && !a.text.trim() && a.toolCalls === 0);
        const pass = settled.status === "done" && addrs.has(ADDR_A.toLowerCase()) && addrs.has(ADDR_B.toLowerCase()) && ranPoc && /15\.75/.test(finalText) && !emptyStopAfterTools;
        const usage = await chargeUsage(harness, `t5-${alias}-${rep}`);
        row = { alias, rep, ms: Date.now() - t0, pass, status: settled.status, reason: settled.reason, turns: s.assistants.length, calls: s.calls.map((c) => c.name), toolErrors: s.results.filter((r) => r.isError).map((r) => r.text), emptyStopAfterTools, thinkingPerTurn: s.assistants.map((a) => a.thinkingChars), final: finalText.slice(0, 200), assistants: s.assistants, usage, reports };
      } catch (e) {
        row = { alias, rep, ms: Date.now() - t0, pass: false, thrown: String(e?.stack ?? e).slice(0, 600), reports };
      } finally {
        await harness.close(ctx).catch(() => {});
      }
      rows.push(row);
      console.log(`${alias.padEnd(9)} t5 #${rep} ${row.pass ? "PASS" : "FAIL"} ${row.ms}ms turns=${row.turns} calls=${row.calls?.join(",")} final=${JSON.stringify(row.final ?? row.thrown)}`);
    }
  }));
  writeFileSync(`${DIR}t5.json`, JSON.stringify(rows, null, 2));
  console.log("spent total", spent().toFixed(4));
}

// ---------------- child worker for t6/t7.
async function child([, , , mode, db, alias, requestId, content]) {
  const { harness, root, reports } = await open(db, alias);
  event("opened", { mode });
  if (mode === "resume" || mode === "approve") {
    const insp = await harness.inspect(ctx);
    event("inspect", { tasks: insp.tasks?.length, submissions: insp.submissions?.length });
    harness.resume();
  }
  if (mode === "approve") {
    // The host: approve every pending request after a pause. No model call should run meanwhile.
    const w = await harness.watchDoc(Pending, ctx);
    const approve = async (ids) => {
      for (const id of ids) {
        const before = await harness.usage(ctx);
        await sleep(4000);
        const after = await harness.usage(ctx);
        const outDelta = Object.values(after.models ?? {}).reduce((s, v) => s + v.output, 0) - Object.values(before.models ?? {}).reduce((s, v) => s + v.output, 0);
        event("host-approving", { id, outputTokensWhileWaiting: outDelta });
        await harness.commit(async (tx) => {
          const d = await tx.doc(Approval, id, { tool: "?", args: {} });
          d.status = "approved";
          d.by = "host";
        }, ctx);
      }
    };
    const seen = new Set();
    const handle = (v) => { const fresh = (v?.ids ?? []).filter((i) => !seen.has(i)); fresh.forEach((i) => seen.add(i)); if (fresh.length) approve(fresh); };
    if (w) { handle(w.value); w.start(async (call) => { if (call.kind === "value") handle(call.value); }); }
  }
  // Same requestId returns the same submission after a restart.
  const sub = await root.submit({ type: "input", requestId, content }, ctx);
  event("submitted", { id: sub.id });
  const settled = await sub.wait(ctx);
  const s = await summarize(root);
  const pending = await harness.snapshot(Pending, ctx);
  const usage = await chargeUsage(harness, `${mode}`);
  event("settled", { status: settled.status, reason: settled.reason, results: s.results, calls: s.calls.map((c) => c.name), assistants: s.assistants, pendingIds: pending?.ids, usage, reports });
  await harness.close(ctx);
  process.exit(0);
}

// Spawn a worker; resolve on exit. killOn(evt) returns ms to wait before SIGKILL, or undefined.
function runChild(args, env, killOn) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [new URL(import.meta.url).pathname, "child", ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const events = [];
    let killed = false, buf = "", err = "";
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.startsWith("EVENT ")) continue;
        const e = JSON.parse(line.slice(6));
        events.push(e);
        const wait = !killed && killOn ? killOn(e) : undefined;
        if (wait !== undefined) { killed = true; setTimeout(() => { p.kill("SIGKILL"); }, wait); }
      }
    });
    p.stderr.on("data", (d) => { err += d; });
    p.on("exit", (code, signal) => resolve({ code, signal, killed, events, stderr: err.slice(-1500) }));
  });
}

function fresh(name) {
  const db = `${DIR}${name}.sqlite`;
  for (const f of [db, db + "-wal", db + "-shm", `${DIR}${name}.marker`, `${DIR}${name}.events`]) rmSync(f, { force: true });
  return db;
}

// ---------------- t6: kill mid-tool (unsafe and safe) and mid-answer, then resume.
async function t6() {
  const aliases = (process.env.ONLY?.split(",")) ?? ["qwen-abl", "ds-abl"];
  const out = [];
  for (const alias of aliases) {
    const content = `Run the PoC named test_vault_drain with run_poc. Then get the balance of ${ADDR_A} with get_balance. Then answer in one line with the PoC result and the balance.`;
    // a) Unsafe tool (run_poc) killed mid-call: expect an "interrupted" error result, then the model carries on.
    {
      guard(0.03);
      const name = `t6-unsafe-${alias}`; const db = fresh(name);
      const env = { SLOW_POC_MARKER: `${DIR}${name}.marker`, EVENTS_FILE: `${DIR}${name}.events` };
      const first = await runChild(["run", db, alias, "r1", content], env, (e) => (e.ev === "tool-start" && e.tool === "run_poc" ? 1500 : undefined));
      const second = await runChild(["resume", db, alias, "r1", content], env);
      out.push({ alias, scenario: "kill mid unsafe tool", first: brief(first), second: brief(second) });
    }
    // b) Safe tool (get_balance) killed mid-call: expect it to rerun and succeed.
    {
      guard(0.03);
      const name = `t6-safe-${alias}`; const db = fresh(name);
      const env = { SLOW_BALANCE_MARKER: `${DIR}${name}.marker`, EVENTS_FILE: `${DIR}${name}.events` };
      const first = await runChild(["run", db, alias, "r1", content], env, (e) => (e.ev === "tool-start" && e.tool === "get_balance" ? 1500 : undefined));
      const second = await runChild(["resume", db, alias, "r1", content], env);
      out.push({ alias, scenario: "kill mid safe tool", first: brief(first), second: brief(second) });
    }
    // c) Killed mid-answer: after the last tool finishes, the model is generating. Kill 1.2s later.
    {
      guard(0.03);
      const name = `t6-answer-${alias}`; const db = fresh(name);
      const env = { EVENTS_FILE: `${DIR}${name}.events` };
      const first = await runChild(["run", db, alias, "r1", content], env, (e) => (e.ev === "tool-done" && e.tool === "get_balance" ? 1200 : undefined));
      const second = await runChild(["resume", db, alias, "r1", content], env);
      out.push({ alias, scenario: "kill mid answer", first: brief(first), second: brief(second) });
    }
  }
  writeFileSync(`${DIR}t6.json`, JSON.stringify(out, null, 2));
  for (const r of out) console.log(JSON.stringify({ alias: r.alias, scenario: r.scenario, killed: r.first.killed, firstSettled: r.first.settled?.status, resumed: r.second.settled?.status, results: r.second.settled?.results?.map((x) => `${x.name}:${x.isError ? "ERR " + x.text.slice(0, 60) : "ok"}`), final: r.second.settled?.assistants?.at(-1)?.text?.slice(0, 120), toolStarts: [...r.first.events, ...r.second.events].filter((e) => e.ev === "tool-start").map((e) => e.tool), stderr: r.second.stderr ? r.second.stderr.slice(-300) : undefined }));
  console.log("spent total", spent().toFixed(4));
}

function brief(r) {
  const settled = r.events.find((e) => e.ev === "settled");
  if (settled?.usage) { /* charged inside the child */ }
  return { code: r.code, signal: r.signal, killed: r.killed, events: r.events.filter((e) => e.ev !== "settled"), settled, stderr: r.stderr };
}

// ---------------- t7: approval wait, kill while waiting, resume, approve.
async function t7() {
  const aliases = (process.env.ONLY?.split(",")) ?? ["qwen-abl", "ds-abl"];
  const out = [];
  for (const alias of aliases) {
    guard(0.03);
    const name = `t7-${alias}`; const db = fresh(name);
    const env = { EVENTS_FILE: `${DIR}${name}.events` };
    const content = `Send 1 ETH to ${ADDR_B} with send_tx. Then tell me the transaction hash.`;
    const first = await runChild(["run", db, alias, "r1", content], env, (e) => (e.ev === "approval-pending" ? 1000 : undefined));
    const second = await runChild(["approve", db, alias, "r1", content], env);
    const ids = [...first.events, ...second.events].filter((e) => e.ev === "approval-pending").map((e) => e.id);
    out.push({ alias, first: brief(first), second: brief(second), approvalIds: ids, sameId: ids.length >= 2 && ids.every((i) => i === ids[0]) });
  }
  writeFileSync(`${DIR}t7.json`, JSON.stringify(out, null, 2));
  for (const r of out) console.log(JSON.stringify({ alias: r.alias, killed: r.first.killed, approvalIds: r.approvalIds, sameId: r.sameId, pendingIds: r.second.settled?.pendingIds, host: r.second.events.filter((e) => e.ev === "host-approving"), resumed: r.second.settled?.status, results: r.second.settled?.results?.map((x) => `${x.name}:${x.isError ? "ERR " + x.text.slice(0, 60) : "ok"}`), final: r.second.settled?.assistants?.at(-1)?.text?.slice(0, 160), stderr: r.second.stderr ? r.second.stderr.slice(-300) : undefined }));
  console.log("spent total", spent().toFixed(4));
}

const cmd = process.argv[2];
if (cmd === "t5") await t5();
else if (cmd === "t6") await t6();
else if (cmd === "t7") await t7();
else if (cmd === "child") await child(process.argv);
else console.log("usage: node smoke-durable.mjs t5|t6|t7");
