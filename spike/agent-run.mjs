// Vertical slice of the real agent loop: one Contracts run end to end.
//
//   node agent-run.mjs                 run qwen-abl against the planted reentrancy bug
//   ALIAS=ds-abl node agent-run.mjs    pick the model
//   MAX_POC=20 node agent-run.mjs      cap PoC attempts (default: no cap; the run budget stops it)
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
import { createRegistry, defineExtension, Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { MODELS, PROVIDER_ID, costOf, guard, runSpend, spent } from "./lib/inference.mjs";
import { readSpendWith } from "./lib/attempt-cap.mjs";
import { inferenceModels } from "./lib/provider.mjs";
import { activeProvider, defaultAlias } from "./lib/providers.mjs";
import { cleanupWorkspace, makeWorkspace, readTouchstone } from "./lib/sandbox.mjs";
import { getTarget, prepareRunWorkspace } from "./lib/targets.mjs";
import { openReach } from "./lib/reach.mjs";
import { event } from "./lib/event.mjs";
import { candidateState } from "./lib/candidate.mjs";
import { watchCognition } from "./lib/cognition.mjs";
import { createFleet } from "./lib/fleet.mjs";
import { packFor } from "./packs/index.mjs";
import { sourceNavTools, NAV_SYSTEM } from "./packs/source-nav/pack.mjs";
import { resolveCbmBinary } from "./lib/cbm.mjs";
import { withProven } from "./lib/proof-view.mjs";

// Tools tell the model how much of the run budget is left.
readSpendWith(runSpend);

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
//   candidates  unproven, agent-asserted results (lib/candidate.mjs)
//   attempts    attempt id -> what it captured, for submit_candidate
function auditState() {
  return { poc: 0, passed: new Map(), found: [], candidates: candidateState(), attempts: new Map() };
}

async function openHarness(db, ws, state) {
  const pack = packFor(readTouchstone(ws));
  // Source navigation is the DEFAULT code-reading layer for any run given a local
  // folder or a fetched repo: Contracts and Review. The hunter gets the five
  // read-only index tools alongside the pack's own tools, and an instruction to
  // prefer the index over blind file reads. The flat source tools stay as the
  // fallback. The nav tools and their prompt are mounted only when the index
  // binary actually resolves, so a host without it gets no dead tools and no
  // instruction to use them — the run falls back cleanly to the flat source
  // tools. Navigation never produces a finding; proof is unchanged.
  const navy = (pack.id === "contracts" || pack.id === "review") && (await resolveCbmBinary()) !== null;
  const system = pack.system(ws) + (navy ? NAV_SYSTEM : "");
  const registry = createRegistry();
  const fleet = createFleet({ system, costOf });
  const tools = [...pack.tools(ws, state), ...(navy ? sourceNavTools(ws) : [])];
  registry.install(defineExtension({ name: pack.id, tools: fleet ? fleet.wrapTools(tools) : tools }));
  if (fleet) registry.install(fleet.extension);
  const reports = [];
  const harness = await Harness.open(await openNodeSqliteStorage(db), {
    models: inferenceModels({ agentForSession: fleet?.agentForSession }),
    registry,
    // maxRetries 5 (baseDelayMs 2s, exponential, capped 60s) rides out a flaky
    // gateway: transient 5xx/timeout/overload/rate-limit errors are retried with
    // ~2+4+8+16+32s of backoff before a call is allowed to fail the whole run.
    // Non-retryable errors (quota/billing/bad-request) still fail fast.
    settings: { retry: { maxRetries: 5 }, stream: { timeoutMs: 180_000 } },
    onReport: (r) => reports.push({ kind: r.kind, reason: r.reason, msg: String(r.error?.message ?? r.error ?? "").slice(0, 200) }),
  }, ctx);
  await fleet?.attach(harness, ctx);
  const root = await harness.root(ctx, {
    agent: { model: { provider: PROVIDER_ID, modelId: MODELS[ALIAS].id }, instructions: system + (fleet ? `\n\n${fleet.instructions}` : "") },
  });
  return { harness, root, reports, pack, fleet };
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

let streamed;
async function streamCognition(harness, base = 0) {
  streamed = await watchCognition(harness, ROOT_CONVERSATION_ID, { base, skipStale: base > 0, uniqueTurns: process.env.FLEET !== "0" }, ctx);
}

function flushFinal(summary) {
  streamed?.flush(summary?.final?.text);
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

// Operator messages arrive on stdin, one JSON line ({"text":"…","id":"…"}) each, while a
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
      let text, id;
      try { ({ text, id } = JSON.parse(line)); } catch { continue; }
      if (typeof text !== "string" || !text.trim()) continue;
      // The UI's id for this message. The echo carries it back, so the UI can
      // swap its instant copy for the real one.
      const tag = typeof id === "string" && id ? { id } : {};
      steerSeq += 1;
      root.submit({ type: "input", requestId: `steer-${Date.now()}-${steerSeq}`, content: text, whenBusy: "steer" }, ctx)
        .then(() => event("operator-message", { text, ...tag }))
        .catch((e) => event("steer-error", { text, ...tag, error: String(e?.message ?? e) }));
    }
  });
  process.stdin.on("error", () => {});
  process.stdin.resume();
}

// ---- Follow-up worker: one operator message to a finished run. It reopens the
// run's saved session, so the agent keeps the whole earlier conversation. The
// workspace is new, so files the agent wrote or fetched before are gone; the
// message says so. Findings it proves now continue the run's numbering.
async function chat({ harness, root, reports, state, fleet }) {
  const text = String(process.env.FOLLOWUP ?? "").trim();
  if (!text) throw new Error("FOLLOWUP is empty");
  for (const f of JSON.parse(process.env.PRIOR_FOUND || "[]")) state.found.push(f);
  const prior = state.found.length;
  for (const c of JSON.parse(process.env.PRIOR_CANDIDATES || "[]")) state.candidates.push(c);
  const priorCandidates = state.candidates.length;
  const before = (await harness.usage(ctx)).models ?? {};
  await streamCognition(harness, Number(process.env.ATTEMPT_BASE ?? 0));
  readSteers(root);
  const sub = await root.submit({
    type: "input", requestId: `followup-${Date.now()}`,
    content: `${text}\n\n(Operator follow-up. The sandbox was rebuilt since your last turn, so files you wrote or fetched before are gone. Rewrite or refetch any you need.)`,
  }, ctx);
  event("operator-message", { text, ...(process.env.FOLLOWUP_ID ? { id: process.env.FOLLOWUP_ID } : {}) });
  let settled = await sub.wait(ctx);
  settled = await fleet?.drain(ctx, { enforce: false }) ?? settled;
  const s = await summarize(root);
  flushFinal(s);
  const usage = await chargeUsage(harness, before);
  event("settled", { status: settled.status, reason: settled.reason, detail: settled.detail, summary: s, findings: state.found.slice(prior), candidates: state.candidates.slice(priorCandidates), usage, reports });
}

// ---- Child worker: one process runs the whole audit.
async function child([, , , mode, db, ws]) {
  const state = auditState();
  const { harness, root, reports, pack, fleet } = await openHarness(db, ws, state);
  event("opened", { mode });
  if (mode === "chat") {
    await chat({ harness, root, reports, state, fleet });
    await fleet?.close();
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
  settled = await fleet?.drain(ctx) ?? settled;

  // One nudge, owned by the pack: ask a model that stopped early to work the
  // suspects it has not tried. Only after a clean end of turn.
  const more = settled.status === "done" ? pack.nudge(state) : null;
  if (more) settled = await (await root.submit({ type: "input", requestId: "continue1", content: more }, ctx)).wait(ctx);
  settled = await fleet?.drain(ctx) ?? settled;

  const s = await summarize(root);
  flushFinal(s);
  const usage = await chargeUsage(harness);
  event("settled", { status: settled.status, reason: settled.reason, detail: settled.detail, summary: s, findings: state.found, candidates: state.candidates, usage, reports });
  await fleet?.close();
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
  // TARGET_ID selects a library target (a live scope included) and prepares it
  // the way the app does; TARGET stays the direct path for a working checkout.
  const target = process.env.TARGET_ID ? getTarget(process.env.TARGET_ID) : null;
  const reach = target ? await openReach(target, { mode: target.kind === "live" ? "confine" : "proxy" }) : null;
  const ws = target ? await prepareRunWorkspace(target) : makeWorkspace(TARGET);
  const pack = packFor(readTouchstone(ws));
  const env = { EVENTS_FILE: `${DIR}run-${ALIAS}.events` };
  rmSync(env.EVENTS_FILE, { force: true });
  const t0 = Date.now();

  // A pre-pass failure must not sink the run (the app does the same): the
  // agent can still audit with no leads. The record keeps the reason.
  let prep = null;
  let prepassError = null;
  try {
    prep = await pack.prepass?.(ws, {
      reach,
      emit: (ev) => {
        appendFileSync(env.EVENTS_FILE, JSON.stringify(ev) + "\n");
        console.log("· " + ev.ev + " " + JSON.stringify(ev));
      },
    });
  } catch (err) {
    prepassError = String(err?.message ?? err);
    console.log("· prepass failed " + prepassError);
  }

  // The record is always written, even when the agent or the proof replay
  // fails: then it reads as an error with its reason, never as a clean run.
  let all = [];
  let settled = null;
  let findings = [];
  let error = null;
  try {
    // One worker runs the whole audit. submit_finding never blocks, so nothing
    // has to be killed or resumed; the run settles on its own.
    console.log(`\n== agent run (${ALIAS}) ==`);
    const runEnv = { ...env, ...(reach?.env ?? {}), ...prep?.env };
    const first = await runChild("run", db, ws, runEnv);
    all = first.events;
    settled = all.find((e) => e.ev === "settled") ?? null;
    if (!settled) error = `the agent exited before it settled (code ${first.code ?? first.signal}): ${first.stderr.slice(-400)}`;
    else if (settled.status !== "done") error = `the agent did not finish: ${settled.reason ?? settled.status}`;

    // Structured proof delta for EACH finding — the engine's own reading of each
    // proven exploit. Each finding's exact passing source is replayed once more in
    // JSON trace mode, so its proof panel shows what the chain DID, not what the
    // test was written to assert. "Proven" binds to the submitted test only; a
    // throwaway diagnostic that happens to pass never turns a record green. Runs
    // before the workspace is torn down below.
    findings = withProven(await pack.prove?.(ws, settled?.findings ?? [], all, (m) => console.log("· " + m)));
    for (const f of findings) {
      console.log("· proof-delta " + JSON.stringify({ poc: f.poc, severity: f.severity, status: f.proof?.status ?? null, transfers: f.proof?.transfers?.map((t) => `${t.label}:${t.net}`) ?? [] }));
    }
  } catch (err) {
    error = String(err?.message ?? err);
    findings = [];
  }
  const worst = findings[0] ?? null;
  const pocRuns = all.filter((e) => e.ev === "run_poc").length;

  const result = {
    alias: ALIAS, approveMode: "auto", ms: Date.now() - t0,
    status: settled?.status, reason: settled?.reason,
    // How the run ended. An error keeps its reason.
    outcome: findings.length ? "recorded" : error ? "error" : "no-finding",
    error: findings.length ? null : error,
    prepassError,
    ...prep?.record,
    pocRuns,
    // Every proven finding, worst first, each with its own replay proof: real
    // pass/fail, gas, decoded logs, and the signed money-moved table.
    findings,
    // Unproven, agent-asserted results. Never findings, never counted as one.
    candidates: settled?.candidates ?? [],
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
  await reach?.stop?.();
  await cleanupWorkspace(ws);

  console.log("\n==== run summary ====");
  console.log(JSON.stringify(result, null, 2));
  console.log("spent total NEAR $", spent().toFixed(4));
}

const cmd = process.argv[2];
if (cmd === "child") await child(process.argv);
else await main();
