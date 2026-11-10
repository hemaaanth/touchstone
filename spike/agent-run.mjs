// Vertical slice of the real agent loop: one Contracts run end to end.
//
//   node agent-run.mjs                 run qwen-abl against the planted reentrancy bug
//   ALIAS=ds-abl node agent-run.mjs    pick the model
//   MAX_POC=20 node agent-run.mjs      raise the PoC attempt budget
//
// The agent gets real tools over a per-run Foundry sandbox: it reads the contract
// source, writes its own exploit tests, runs them offline in Docker, and must
// prove each exploit.
//
// The audit is comprehensive. One contract can have several bugs. The agent first
// ranks every suspect, worst first. Then it tries to prove each one. Each passing
// test is submitted as its own finding, and the audit keeps going. submit_finding
// never blocks and never ends the run. When the run settles, the engine replays
// every submitted test once more and records each finding with its own proof.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, Harness, LiveDoc, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { MODELS, PROVIDER_ID, costOf, guard, spent } from "./lib/inference.mjs";
import { inferenceModels } from "./lib/provider.mjs";
import { activeProvider, defaultAlias } from "./lib/providers.mjs";
import { cleanupWorkspace, makeWorkspace, readTouchstone } from "./lib/sandbox.mjs";
import { event } from "./lib/event.mjs";
import { packFor } from "./packs/index.mjs";
import { withProven } from "./lib/proof-view.mjs";

const ctx = BACKGROUND_CONTEXT;
const ALIAS = process.env.ALIAS ?? defaultAlias(activeProvider());
if (!MODELS[ALIAS]) {
  throw new Error(`Unknown ALIAS "${ALIAS}" for provider "${PROVIDER_ID}". Known: ${Object.keys(MODELS).join(", ")}`);
}
// Which lab to audit. Defaults to the reentrancy lab (Slither's showcase); set
// TARGET=../lab/vault-accounting to run the fuzzing showcase. A relative value is
// resolved against this file; an absolute path is used as-is.
const TARGET = process.env.TARGET
  ? new URL(process.env.TARGET, import.meta.url).pathname
  : new URL("../lab/vault-reentrancy/", import.meta.url).pathname;
const DIR = new URL("./results/agent/", import.meta.url).pathname;
mkdirSync(DIR, { recursive: true });

// Per-process audit state. One run is one process, so plain memory is enough.
//   poc     run_poc attempts so far
//   passed  test contract name -> the exact source that last passed
//   found   submitted findings, in submit order
function auditState() {
  return { poc: 0, passed: new Map(), found: [] };
}

async function openHarness(db, ws, state) {
  const pack = packFor(readTouchstone(ws));
  const registry = createRegistry();
  registry.install(defineExtension({ name: pack.id, tools: pack.tools(ws, state) }));
  const reports = [];
  const harness = await Harness.open(await openNodeSqliteStorage(db), {
    models: inferenceModels(),
    registry,
    settings: { retry: { maxRetries: 2 }, stream: { timeoutMs: 180_000 } },
    onReport: (r) => reports.push({ kind: r.kind, reason: r.reason, msg: String(r.error?.message ?? r.error ?? "").slice(0, 200) }),
  }, ctx);
  const root = await harness.root(ctx, {
    agent: { model: { provider: PROVIDER_ID, modelId: MODELS[ALIAS].id }, instructions: pack.system(ws) },
  });
  return { harness, root, reports, pack };
}

async function summarize(root) {
  const view = await root.context(ctx);
  const calls = [], results = [], assistants = [];
  for (const m of view.messages) {
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      const tc = m.content.filter((b) => b.type === "toolCall");
      tc.forEach((b) => calls.push({ name: b.name, args: b.arguments }));
      assistants.push({ stop: m.stopReason, text: text.slice(0, 4000), toolCalls: tc.length, error: m.errorMessage?.slice(0, 200) });
    }
    if (m.role === "toolResult") {
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      results.push({ name: m.toolName, isError: !!m.isError, text: text.slice(0, 300) });
    }
  }
  return { calls, results, assistants, final: assistants.at(-1) };
}

// Stream the agent's live thinking and prose to the UI. pi-durable commits a
// throttled partial of the in-flight response into the root conversation's
// LiveDoc (`generation.message`), so we watch that doc and, on every commit,
// re-derive the full text and reasoning of the current answer. The reducer
// REPLACES a streamed step by (conv, attempt), so emitting the growing snapshot
// types the text on screen. We key `attempt` on the run's tool-round index
// (`run.turns`), so each round's prose lands as its own step instead of
// overwriting the last. Without this a live run shows tool steps but no
// cognition — exactly the gap the operator saw. Returns the watch handle so the
// caller can stop it; a no-op if the harness has no live doc yet.
async function streamCognition(harness, base = 0) {
  const w = await harness.watchDoc(LiveDoc, ROOT_CONVERSATION_ID, ctx);
  if (!w) return undefined;
  let turn = -1;
  let lastSay = "", lastThink = "";
  // A resumed session still holds the last answer of the previous turn. Skip it
  // until a new answer starts, so old text does not show again as a new step.
  let stale = null;
  const read = (live) => {
    const msg = live?.generation?.message;
    if (!msg || !Array.isArray(msg.content)) return null;
    let say = "", think = "";
    for (const b of msg.content) {
      if (b?.type === "text" && typeof b.text === "string") say += b.text;
      else if (b?.type === "thinking" && typeof b.thinking === "string") think += b.thinking;
    }
    return { say, think };
  };
  const emit = (live) => {
    const r = read(live);
    if (!r) return;
    if (stale !== null) {
      if (r.think + "\u0000" + r.say === stale) return;
      stale = null;
    }
    // `base` keeps a follow-up's steps apart from the earlier turns' steps.
    const t = base + (live?.run?.turns ?? 0);
    // A new tool round resets the partial; start a fresh step and dedupe baseline.
    if (t !== turn) { turn = t; lastSay = ""; lastThink = ""; }
    const { say, think } = r;
    if (think && think !== lastThink) { lastThink = think; event("thinking-delta", { attempt: turn, text: think }); }
    if (say && say !== lastSay) { lastSay = say; event("assistant-delta", { attempt: turn, text: say }); }
  };
  if (base > 0) {
    const r = read(w.value);
    if (r) stale = r.think + "\u0000" + r.say;
  }
  emit(w.value);
  w.start(async (call) => { if (call.kind === "value") emit(call.value); });
  return w;
}

// harness.usage() counts the whole session. A follow-up reopens a session that
// was already charged. The provider charges each response; this only summarizes
// the new usage for the run record.
async function chargeUsage(harness, base = {}) {
  const u = await harness.usage(ctx);
  let usd = 0;
  const prefix = new RegExp("^" + PROVIDER_ID + "/");
  const models = {};
  for (const [key, v] of Object.entries(u.models ?? {})) {
    const b = base[key] ?? {};
    const d = { input: v.input - (b.input ?? 0), output: v.output - (b.output ?? 0), reasoning: (v.reasoning ?? 0) - (b.reasoning ?? 0) };
    if (d.input <= 0 && d.output <= 0) continue;
    usd += costOf(key.replace(prefix, ""), d.input, d.output);
    models[key] = { in: d.input, out: d.output, reasoning: d.reasoning };
  }
  return { usd, models };
}

// Operator messages arrive on stdin, one JSON line ({"text":"…"}) each, while a
// turn is in flight. Each one is injected into the agent's current turn with
// whenBusy:"steer" (pi-durable native steering), so it rides into the running
// generation instead of queuing a fresh run. "operator-message" is emitted only
// once the steer is admitted, so the transcript shows it when it really landed.
function readSteers(root) {
  let steerSeq = 0;
  let stdinBuf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    stdinBuf += chunk;
    let i;
    while ((i = stdinBuf.indexOf("\n")) >= 0) {
      const line = stdinBuf.slice(0, i);
      stdinBuf = stdinBuf.slice(i + 1);
      if (!line.trim()) continue;
      let text;
      try { text = JSON.parse(line).text; } catch { continue; }
      if (typeof text !== "string" || !text.trim()) continue;
      steerSeq += 1;
      root.submit({ type: "input", requestId: `steer-${Date.now()}-${steerSeq}`, content: text, whenBusy: "steer" }, ctx)
        .then(() => event("operator-message", { text }))
        .catch((e) => event("steer-error", { text, error: String(e?.message ?? e) }));
    }
  });
  process.stdin.on("error", () => {});
  process.stdin.resume();
}

// ---- Follow-up worker: one operator message to a finished run. It reopens the
// run's saved session, so the agent keeps the whole earlier conversation. The
// workspace is new, so files the agent wrote or fetched before are gone; the
// message says so. Findings it proves now continue the run's numbering.
async function chat({ harness, root, reports, state }) {
  const text = String(process.env.FOLLOWUP ?? "").trim();
  if (!text) throw new Error("FOLLOWUP is empty");
  for (const f of JSON.parse(process.env.PRIOR_FOUND || "[]")) state.found.push(f);
  const prior = state.found.length;
  const before = (await harness.usage(ctx)).models ?? {};
  await streamCognition(harness, Number(process.env.ATTEMPT_BASE ?? 0));
  readSteers(root);
  const sub = await root.submit({
    type: "input", requestId: `followup-${Date.now()}`,
    content: `${text}\n\n(Operator follow-up. The sandbox was rebuilt since your last turn, so files you wrote or fetched before are gone. Rewrite or refetch any you need.)`,
  }, ctx);
  event("operator-message", { text });
  const settled = await sub.wait(ctx);
  const s = await summarize(root);
  const usage = await chargeUsage(harness, before);
  event("settled", { status: settled.status, reason: settled.reason, summary: s, findings: state.found.slice(prior), usage, reports });
}

// ---- Child worker: one process runs the whole audit.
async function child([, , , mode, db, ws]) {
  const state = auditState();
  const { harness, root, reports, pack } = await openHarness(db, ws, state);
  event("opened", { mode });
  if (mode === "chat") {
    await chat({ harness, root, reports, state });
    await harness.close(ctx);
    process.exit(0);
  }
  const sub = await root.submit({ type: "input", requestId: "run1", content: pack.kickoff(ws, process.env) }, ctx);

  if (mode === "run") {
    // Stream the agent's thinking and prose to the UI for the whole live turn.
    // In CLI mode stdin is /dev/null, so the steer reader never fires.
    await streamCognition(harness);
    readSteers(root);
  }

  let settled = await sub.wait(ctx);

  // One nudge, owned by the pack: ask a model that stopped early to work the
  // suspects it has not tried. Only after a clean end of turn.
  const more = settled.status === "done" ? pack.nudge(state) : null;
  if (more) settled = await (await root.submit({ type: "input", requestId: "continue1", content: more }, ctx)).wait(ctx);

  const s = await summarize(root);
  const usage = await chargeUsage(harness);
  event("settled", { status: settled.status, reason: settled.reason, summary: s, findings: state.found, usage, reports });
  await harness.close(ctx);
  process.exit(0);
}

// Spawn a worker; resolve on exit.
function runChild(mode, db, ws, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [new URL(import.meta.url).pathname, "child", mode, db, ws], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const events = [];
    let buf = "", err = "";
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.startsWith("EVENT ")) { if (line.trim()) process.stderr.write("  [child] " + line + "\n"); continue; }
        const e = JSON.parse(line.slice(6));
        events.push(e);
        console.log("· " + e.ev + (e.ev === "settled" ? "" : " " + JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !["t", "ev"].includes(k))))));
      }
    });
    p.stderr.on("data", (d) => { err += d; });
    p.on("exit", (code, signal) => resolve({ code, signal, events, stderr: err.slice(-1500) }));
  });
}

async function main() {
  guard(); // stop before starting if this run has already spent its budget
  const db = `${DIR}run-${ALIAS}.sqlite`;
  for (const f of [db, db + "-wal", db + "-shm"]) rmSync(f, { force: true });
  const ws = makeWorkspace(TARGET);
  const pack = packFor(readTouchstone(ws));
  const env = { EVENTS_FILE: `${DIR}run-${ALIAS}.events` };
  rmSync(env.EVENTS_FILE, { force: true });
  const t0 = Date.now();

  const prep = await pack.prepass?.(ws, {
    emit: (ev) => {
      appendFileSync(env.EVENTS_FILE, JSON.stringify(ev) + "\n");
      console.log("· " + ev.ev + " " + JSON.stringify(ev));
    },
  });

  // One worker runs the whole audit. submit_finding never blocks, so nothing
  // has to be killed or resumed; the run settles on its own.
  console.log(`\n== agent run (${ALIAS}) ==`);
  const runEnv = { ...env, ...prep?.env };
  const first = await runChild("run", db, ws, runEnv);
  const all = first.events;
  const settled = all.find((e) => e.ev === "settled");
  const pocRuns = all.filter((e) => e.ev === "run_poc").length;

  // Structured proof delta for EACH finding — the engine's own reading of each
  // proven exploit. Each finding's exact passing source is replayed once more in
  // JSON trace mode, so its proof panel shows what the chain DID, not what the
  // test was written to assert. "Proven" binds to the submitted test only; a
  // throwaway diagnostic that happens to pass never turns a record green. Runs
  // before the workspace is torn down below.
  const findings = withProven(await pack.prove?.(ws, settled?.findings ?? [], all, (m) => console.log("· " + m)));
  for (const f of findings) {
    console.log("· proof-delta " + JSON.stringify({ poc: f.poc, severity: f.severity, status: f.proof?.status ?? null, transfers: f.proof?.transfers?.map((t) => `${t.label}:${t.net}`) ?? [] }));
  }
  const worst = findings[0] ?? null;

  const result = {
    alias: ALIAS, approveMode: "auto", ms: Date.now() - t0,
    status: settled?.status, reason: settled?.reason,
    ...prep?.record,
    pocRuns,
    // Every proven finding, worst first, each with its own replay proof: real
    // pass/fail, gas, decoded logs, and the signed money-moved table.
    findings,
    // Back-compat single-finding fields: the worst finding.
    findingSubmitted: findings.length > 0,
    finding: worst ? { title: worst.title, severity: worst.severity, poc: worst.poc } : null,
    pocProved: worst?.pocProved ?? false,
    proof: worst?.proof ?? null,
    decision: findings.length ? "approved" : null,
    recorded: findings.length > 0,
    calls: settled?.summary?.calls?.map((c) => c.name),
    final: settled?.summary?.final?.text?.slice(0, 1200),
    usage: settled?.usage, reports: settled?.reports,
  };
  writeFileSync(`${DIR}run-${ALIAS}.json`, JSON.stringify({ result, transcript: settled?.summary }, null, 2));
  cleanupWorkspace(ws);

  console.log("\n==== run summary ====");
  console.log(JSON.stringify(result, null, 2));
  console.log("spent total NEAR $", spent().toFixed(4));
}

const cmd = process.argv[2];
if (cmd === "child") await child(process.argv);
else await main();
