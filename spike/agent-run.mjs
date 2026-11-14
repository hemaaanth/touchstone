import { roamError } from "./lib/roam-errors.mjs";
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
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { MODELS, PROVIDER_ID, costOf, guard, runSpend, spent } from "./lib/inference.mjs";
import { readSpendWith } from "./lib/attempt-cap.mjs";
import { auditState } from "./lib/audit-state.mjs";
import { checkRecordedReplays } from "./lib/replay-bundle.mjs";
import { inferenceModels } from "./lib/provider.mjs";
import { activeProvider, defaultAlias } from "./lib/providers.mjs";
import { cleanupWorkspace, makeWorkspace, readTouchstone } from "./lib/sandbox.mjs";
import { briefChange, getTarget, pickTarget, prepareMultiWorkspace, prepareRunWorkspace, scopeEnv, scopeInstructions } from "./lib/targets.mjs";
import { openReach } from "./lib/reach.mjs";
import { currentAgent, event, exitAfterEvents } from "./lib/event.mjs";
import { watchCognition } from "./lib/cognition.mjs";
import { createFleet } from "./lib/fleet.mjs";
import { askHumanTool, answerAsk, disposeAsks } from "./lib/ask.mjs";
import { packFor } from "./packs/index.mjs";
import { sourceNavTools, NAV_SYSTEM } from "./packs/source-nav/pack.mjs";
import { DIAGRAM_RULE } from "./lib/diagram-rule.mjs";
import { resolveCbmBinary } from "./lib/cbm.mjs";
import { withProven } from "./lib/proof-view.mjs";
import { ideaTool, makeAgentFinding, candidateTool, recordSession, sessionLookup, SESSION_DESCRIPTION, SESSION_POC, splitMeasured, supersededBy } from "./lib/candidate.mjs";
import { roamTools, pauseRoamShell, resumeRoamShell, closeRoamShell } from "./lib/roam.mjs";
import { roamBrowserTools, pauseRoamBrowser, resumeRoamBrowser, closeRoamBrowser } from "./lib/roam-browser.mjs";
import { roamMachine } from "./lib/daytona.mjs";
import { createRoamControl } from "./lib/roam-control.mjs";
import { captureSessionArtifacts } from "./lib/session-artifacts.mjs";
import { EGRESS_ENV, startEgressLog, pullEgressLog } from "./lib/roam-egress.mjs";
import { sourceCoverage, coverageFailure } from "./lib/source-coverage.mjs";
import { leadsFrom } from "./lib/leads.mjs";
import { afterNudge } from "./lib/nudge.mjs";

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
// AGENT_RESULTS_DIR moves the run records (a test sends them to a temp folder).
const DIR = process.env.AGENT_RESULTS_DIR ? path.join(process.env.AGENT_RESULTS_DIR, "/") : new URL("./results/agent/", import.meta.url).pathname;
mkdirSync(DIR, { recursive: true });

// Per-process audit state. One run is one process, so plain memory is enough.
//   poc     run_poc attempts so far
//   passed  test contract name -> the exact source that last passed
//   found   submitted findings, in submit order
function createRuntimeRoam(db, ws, state, { pack, isAgent }) {
  const slots = new Map();
  let disposed = false, disposal;
  const unavailable = () => new Error("Managed automation is unavailable. Keep human input disabled.");
  function slotFor(agent) {
    if (disposed) throw unavailable();
    if (!slots.has(agent)) slots.set(agent, { machine: Promise.resolve().then(() => roamMachine(ws, agent)), tail: Promise.resolve(), closed: false, failed: false });
    return slots.get(agent);
  }
  const machine = async (_ws, agent) => {
    const slot = slotFor(agent);
    if (disposed || slot.closed || slot.failed) throw unavailable();
    // Resolve on every action so Daytona can check/replace a lost machine.
    // Clear failed opens; a rejected promise must not poison this child forever.
    const pending = slot.machine ??= Promise.resolve().then(() => roamMachine(ws, agent));
    let value;
    try { value = await pending; }
    catch { throw roamError("ROAM_MACHINE_UNAVAILABLE"); }
    finally { if (slot.machine === pending) slot.machine = null; }
    slot.current = value;
    if (disposed || slot.closed || slot.failed) throw unavailable();
    return value;
  };
  const both = (m, browser, shell) => Promise.allSettled([
    Promise.resolve().then(() => browser(m)), Promise.resolve().then(() => shell(m)),
  ]);
  async function closeSlot(slot) {
    slot.closed = true;
    return slot.closing ??= (async () => {
      // A late resume must settle before terminal close, never after it.
      await slot.tail;
      const m = slot.machine ? await slot.machine : slot.current ?? await (slot.machine = Promise.resolve().then(() => roamMachine(ws, agent)));
      const results = await both(m, closeRoamBrowser, closeRoamShell);
      if (results.some((r) => r.status !== "fulfilled") || results[0].value?.ok !== true || results[0].value?.closed !== true || results[1].value?.ack !== true || results[1].value?.state !== "closed" || results[1].value?.scope !== "managed-shell") throw unavailable();
    })();
  }
  function operate(agent, paused) {
    const slot = slotFor(agent);
    const job = slot.tail.then(async () => {
      const m = slot.machine ? await slot.machine : slot.current ?? await (slot.machine = Promise.resolve().then(() => roamMachine(ws, agent)));
      if (disposed || slot.closed || slot.failed) throw unavailable();
      const results = await both(m, paused ? pauseRoamBrowser : resumeRoamBrowser, paused ? pauseRoamShell : resumeRoamShell);
      const [browser, shell] = results.map((r) => r.status === "fulfilled" ? r.value : null);
      if (results.some((r) => r.status !== "fulfilled") || browser?.ok !== true || browser.paused !== paused || browser.active !== false || browser.closed !== false || browser.failed !== false || shell?.ack !== true || shell.state !== (paused ? "paused" : "active") || shell.scope !== "managed-shell") {
        slot.failed = true;
        await both(m, closeRoamBrowser, closeRoamShell);
        throw unavailable();
      }
      if (disposed || slot.closed) throw unavailable();
    });
    slot.tail = job.catch(() => {});
    return job;
  }
  const gate = createRoamControl({
    epoch: process.env.ROAM_CONTROL_EPOCH ?? randomUUID(), isAgent,
    emit: ({ ev, ...data }) => event(ev, data),
    remote: {
      pause: (agent) => operate(agent, true),
      // Only trusted APP IPC resumes: APP closes the viewer and revokes its grant first.
      resume: (agent) => operate(agent, false),
      close: (agent) => slots.has(agent) ? closeSlot(slots.get(agent)) : Promise.resolve(),
    },
  });
  const record = (entry) => recordSession(state, entry);
  const egress = { env: EGRESS_ENV, start: startEgressLog, pull: pullEgressLog };
  const session = candidateTool({ name: "submit_session_candidate", description: SESSION_DESCRIPTION, pack, state, lookup: sessionLookup(state), poc: SESSION_POC });
  const tools = [...roamTools(ws, { record, egress, machine }), ...roamBrowserTools(ws, { record, egress, machine }), session].map((tool) => ({
    ...tool,
    execute: (args, api, context) => gate.run(currentAgent(), async () => {
      if (tool === session) {
        try {
          const run = /^run-([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.sqlite$/.exec(path.basename(db))?.[1];
          if (!run || !process.env.SESSION_ARTIFACT_DIR) throw unavailable();
          captureSessionArtifacts(process.env.SESSION_ARTIFACT_DIR, { run, agent: currentAgent(), poc: args.poc, state });
        } catch { throw roamError("ROAM_SESSION_SNAPSHOT_UNAVAILABLE"); }
      }
      return tool.execute(args, api, context);
    }),
  }));
  return { tools, control: { ...gate, dispose() {
    if (disposal) return disposal;
    disposed = true;
    gate.dispose();
    disposal = Promise.allSettled([...slots.values()].map(closeSlot));
    return disposal;
  } } };
}

async function openHarness(db, ws, state) {
  try {
    const options = JSON.parse(process.env.ROAM_OPTIONS ?? "[]");
    if (!Array.isArray(options) || options.length) throw new Error();
  } catch {
    throw new Error("ROAM_OPTIONS must be [] for this release.");
  }
  const pack = packFor(readTouchstone(ws));
  // Source navigation is the DEFAULT code-reading layer for any run given a local
  // folder or a fetched repo: Contracts and Review. The hunter gets the five
  // read-only index tools alongside the pack's own tools, and an instruction to
  // prefer the index over blind file reads. The flat source tools stay as the
  // fallback. The nav tools and their prompt are mounted only when the index
  // binary actually resolves, so a host without it gets no dead tools and no
  // instruction to use them — the run falls back cleanly to the flat source
  // tools. Navigation never produces a finding; proof is unchanged.
  // A joined run mounts the layer when ANY of its modules reads code; the index
  // is built once, over the run's shared tree (the run root).
  const readsCode = (id) => id === "contracts" || id === "review";
  const navy = (pack.readsCode === true || readsCode(pack.id)) && (await resolveCbmBinary()) !== null;
  // The nav prompt names flat tools; the joined pack renames them for the whole
  // run, so a run reads a name it really has.
  const navText = navy ? (typeof pack.renameText === "function" ? pack.renameText(ws, NAV_SYSTEM) : NAV_SYSTEM) : "";
  // The scope's notes and the operator's brief close the instructions, so the
  // root agent and every fleet child start with them (targets.mjs scopeEnv).
  // The diagram rule (lib/diagram-rule.mjs) comes just before them.
  const system = pack.system(ws) + navText + DIAGRAM_RULE + scopeInstructions(process.env);
  const registry = createRegistry();
  // Always offer the tools, even with FREE_ROAM off, so confined children keep
  // their remove list across workers. Construction opens no machine.
  let fleet;
  const { tools: offered, control } = createRuntimeRoam(db, ws, state, { pack: pack.id, isAgent: (id) => fleet?.isRoamAgent(id) === true });
  // A child that a follow-up reopens holds the brief of its spawn. The fleet
  // gives it the current one with its next message (fleet.mjs createFleet).
  fleet = createFleet({ system, costOf, brief: process.env.SCOPE_BRIEF ?? "", briefChange, changed: process.env.BRIEF_CHANGE ?? "", roamTools: offered, sharedTools: [askHumanTool, ideaTool(state)] });
  const tools = [...pack.tools(ws, state), ...(navy ? sourceNavTools(ws) : [])];
  registry.install(defineExtension({ name: pack.id, tools: fleet ? fleet.wrapTools(tools) : tools }));
  if (fleet) registry.install(fleet.extension);
  else registry.install(defineExtension({ name: "shared", tools: [askHumanTool, ideaTool(state)] }));
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
  try {
    const root = await harness.root(ctx, {
      agent: { model: { provider: PROVIDER_ID, modelId: MODELS[ALIAS].id }, instructions: system + (fleet ? `\n\n${fleet.instructions}` : ""), tools: { remove: offered } },
    });
    await fleet?.attach(harness, ctx);
    return { harness, root, reports, pack, fleet, control };
  } catch (error) {
    await control.dispose();
    disposeAsks();
    try { await fleet?.close(); } finally { await harness.close(ctx); }
    throw error;
  }
}

// The record keeps each assistant text, cut at TEXT_CAP so a long run's record
// stays small. The last one is the run's final answer, which the run view
// shows: it is kept whole up to FINAL_CAP. A cut text ends with " …cut", the
// mark app/src/lib/final-text.ts knows.
const TEXT_CAP = 4000, FINAL_CAP = 50_000;
const cutText = (text, cap) => (text.length > cap ? `${text.slice(0, cap)} …cut` : text);

async function summarize(root) {
  const view = await root.context(ctx);
  const calls = [], results = [], assistants = [];
  for (const m of view.messages) {
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      const tc = m.content.filter((b) => b.type === "toolCall");
      tc.forEach((b) => calls.push({ name: b.name, args: b.arguments }));
      assistants.push({ stop: m.stopReason, text, toolCalls: tc.length, error: m.errorMessage?.slice(0, 200) });
    }
    if (m.role === "toolResult") {
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      results.push({ name: m.toolName, isError: !!m.isError, text: text.slice(0, 300) });
    }
  }
  assistants.forEach((a, i) => { a.text = cutText(a.text, i === assistants.length - 1 ? FINAL_CAP : TEXT_CAP); });
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
function readSteers(root, control) {
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
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (!message || typeof message !== "object" || Array.isArray(message)) continue;
      if (Object.hasOwn(message, "roamControl")) {
        // Do not await: resume/cancel and Ask replies must pass a draining pause.
        // Tagged input never becomes model text, including before gate attachment.
        void control?.handle(message).catch(() => {});
        continue;
      }
      if (Object.hasOwn(message, "ask")) { answerAsk(message); continue; }
      const { text, id } = message;
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
// server keeps the run's workspace too, and the message says so. When the
// workspace had to be built again, the server sends the true state in
// WORKSPACE_NOTE instead. Findings it proves now continue the run's numbering.
const KEPT_NOTE = "Operator follow-up. Your workspace is the one you left: the files you wrote and the sources you fetched are still there.";
async function chat({ harness, root, reports, state, fleet, control }) {
  const text = String(process.env.FOLLOWUP ?? "").trim();
  if (!text) throw new Error("FOLLOWUP is empty");
  for (const f of JSON.parse(process.env.PRIOR_FOUND || "[]")) state.found.push(f);
  const prior = state.found.length;
  for (const c of JSON.parse(process.env.PRIOR_CANDIDATES || "[]")) if (!state.candidates.some((x) => x.poc === c.poc && x.pack === c.pack)) state.candidates.push(c);
  // Final oracle proof runs in the parent process. Reconcile its retirement
  // events with the child's older audit file before counting report slots.
  for (const ended of JSON.parse(process.env.PRIOR_AGENT_SUPERSEDED || "[]")) {
    for (let i = state.agentFindings.length - 1; i >= 0; i--) if (state.agentFindings[i].poc === ended.poc && (!ended.pack || state.agentFindings[i].pack === ended.pack)) state.agentFindings.splice(i, 1);
  }
  state.agentFindings.save?.();
  for (const value of JSON.parse(process.env.PRIOR_AGENT_FINDINGS || "[]")) {
    const f = makeAgentFinding(value);
    if (f && !state.agentFindings.some((x) => x.poc === f.poc && x.pack === f.pack)) state.agentFindings.push(f);
  }
  // By poc, not by count: a finding this turn may supersede a prior candidate.
  const priorCandidates = new Set(state.candidates.map((c) => c.poc));
  const before = (await harness.usage(ctx)).models ?? {};
  await streamCognition(harness, Number(process.env.ATTEMPT_BASE ?? 0));
  readSteers(root, control);
  const sub = await root.submit({
    type: "input", requestId: `followup-${Date.now()}`,
    // BRIEF_CHANGE: the scope brief changed since the session started (targets.mjs briefChange).
    content: `${text}\n\n(${process.env.WORKSPACE_NOTE || KEPT_NOTE})${process.env.BRIEF_CHANGE ? `\n\n${process.env.BRIEF_CHANGE}` : ""}`,
  }, ctx);
  event("operator-message", { text, ...(process.env.FOLLOWUP_ID ? { id: process.env.FOLLOWUP_ID } : {}) });
  let settled = await sub.wait(ctx);
  settled = await fleet?.drain(ctx, { enforce: false }) ?? settled;
  const s = await summarize(root);
  flushFinal(s);
  const usage = await chargeUsage(harness, before);
  event("settled", { status: settled.status, reason: settled.reason, detail: settled.detail, summary: s, findings: state.found.slice(prior), candidates: state.candidates.filter((c) => !priorCandidates.has(c.poc)), agentFindings: state.agentFindings, usage, reports });
}

// ---- Child worker: one process runs the whole audit.
async function child([, , , mode, db, ws]) {
  let opened, completed = false;
  // Preserve immediate stop: a dead parent must not leave model work running.
  const stop = async (code) => {
    try {
      const closing = opened?.control?.dispose();
      disposeAsks();
      await closing;
    } finally { process.exit(code); }
  };
  process.once("SIGTERM", () => stop(143));
  process.once("SIGINT", () => stop(130));
  // The server owns this worker. A closed parent pipe means a restart; do not
  // keep charging or writing the session while a new server recovers it.
  if (process.env.TOUCHSTONE_PARENT_PIPE === "1") {
    process.stdin.on("end", () => stop(1));
    process.stdin.on("error", () => stop(1));
    process.stdin.resume();
  }
  try {
    const state = auditState(mode === "run" && process.env.TOUCHSTONE_PARENT_PIPE === "1" ? `${db}.audit.json` : null);
    opened = await openHarness(db, ws, state);
    const { harness, root, reports, pack, fleet, control } = opened;
    event("opened", { mode });
    if (mode === "chat") {
      await chat({ harness, root, reports, state, fleet, control });
      completed = true;
      return;
    }
    const sub = await root.submit({ type: "input", requestId: "run1", content: pack.kickoff(ws, process.env) }, ctx);

    if (mode === "run") {
      // Stream the agent's thinking and prose to the UI for the whole live turn.
      // In CLI mode stdin is /dev/null, so the steer reader never fires.
      await streamCognition(harness, Number(process.env.ATTEMPT_BASE ?? 0));
      readSteers(root, control);
    }

    let settled = await sub.wait(ctx);
    settled = await fleet?.drain(ctx) ?? settled;

    // One nudge, owned by the pack: ask a model that stopped early to work the
    // suspects it has not tried. Only after a clean end of turn.
    const more = settled.status === "done" ? pack.nudge(state) : null;
    const tally = () => ({ found: state.found.length, leads: state.leads ?? 0 });
    const before = more ? { settled, final: (await summarize(root)).final, ...tally() } : null;
    if (more) {
      settled = await (await root.submit({ type: "input", requestId: "continue1", content: more }, ctx)).wait(ctx);
      settled = await fleet?.drain(ctx) ?? settled;
    }

    const s = await summarize(root);
    flushFinal(s);
    if (before) ({ settled, final: s.final } = afterNudge(before, { settled, final: s.final, ...tally() }));
    const usage = await chargeUsage(harness);
    event("settled", { status: settled.status, reason: settled.reason, detail: settled.detail, summary: s, findings: state.found, candidates: state.candidates, agentFindings: state.agentFindings, usage, reports });
    completed = true;
  } finally {
    await opened?.control?.dispose();
    disposeAsks();
    try { await opened?.fleet?.close(); } finally { await opened?.harness.close(ctx); }
    if (completed) exitAfterEvents(0);
  }
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
  // PACKS=web,domains makes ONE run over several modules of that target: one
  // workspace, one per module inside it, one grant, one reach decision. One id
  // in PACKS is the run's one module, the same as the app's `pack`.
  let target = process.env.TARGET_ID ? getTarget(process.env.TARGET_ID) : null;
  const packs = [...new Set(String(process.env.PACKS ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
  if (packs.length && !target) throw new Error("PACKS needs TARGET_ID: a module is a module of a library target");
  // pickTarget is the one place that checks a target runs and allows a module,
  // and it returns the target under that module. One PACKS id takes that path,
  // so a module the target does not allow is refused here too.
  if (target && packs.length === 1) target = pickTarget({ id: target.id, pack: packs[0] });
  const reach = target ? await openReach(target, { mode: target.kind === "live" ? "confine" : "proxy" }) : null;
  // Several modules: the build checks the target's own list again, so the CLI
  // and the app refuse the same things.
  const ws = !target
    ? makeWorkspace(TARGET)
    : packs.length > 1
      ? await prepareMultiWorkspace(target, { packs })
      : await prepareRunWorkspace(target);
  const pack = packFor(readTouchstone(ws));
  const env = { EVENTS_FILE: `${DIR}run-${ALIAS}.events`, ...(target ? scopeEnv(target, packs) : {}) };
  rmSync(env.EVENTS_FILE, { force: true });
  const t0 = Date.now();

  // A pre-pass failure must not sink the run (the app does the same): the
  // agent can still audit with no leads. The record keeps the reason.
  let prep = null;
  let prepassError = null;
  const money = runSpend();
  try {
    prep = await pack.prepass?.(ws, {
      reach,
      // Strix's spend inside the pre-pass counts against this run's budget.
      budget: { limitUsd: money.budgetUsd, spentUsd: money.usd },
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
  let measured = [];
  let error = null;
  try {
    // One worker runs the whole audit. submit_finding never blocks, so nothing
    // has to be killed or resumed; the run settles on its own.
    console.log(`\n== agent run (${ALIAS}) ==`);
    const runEnv = { ...env, ...(reach?.env ?? {}), ...prep?.env };
    // The agent worker starts with the pre-pass spend already on its budget.
    if (prep?.spentUsd > 0) Object.assign(runEnv, { RUN_BUDGET_USD: String(money.budgetUsd), RUN_SPENT_USD: String(money.usd + prep.spentUsd) });
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
    // A replay that only repeated a measurement is a candidate, not a finding.
    const split = splitMeasured(withProven(await pack.prove?.(ws, settled?.findings ?? [], all, (m) => console.log("· " + m))), { from: Math.max(0, ...(settled?.candidates ?? []).map((c) => Number(c.n) || 0)) });
    findings = split.findings;
    measured = split.candidates;
    for (const f of findings) {
      console.log("· proof-delta " + JSON.stringify({ poc: f.poc, severity: f.severity, status: f.proof?.status ?? null, transfers: f.proof?.transfers?.map((t) => `${t.label}:${t.net}`) ?? [] }));
    }
  } catch (err) {
    error = String(err?.message ?? err);
    findings = [];
  }
  // A run that did not read every GitHub member of its scope is not clean.
  const sourceCov = sourceCoverage(readTouchstone(ws).links ?? [], all);
  if (!findings.length && !error) error = coverageFailure(sourceCov)?.message ?? null;
  const worst = findings[0] ?? null;
  const pocRuns = all.filter((e) => e.ev === "run_poc").length;

  const result = {
    alias: ALIAS, approveMode: "auto", ms: Date.now() - t0,
    status: settled?.status, reason: settled?.reason,
    // How the run ended. An error keeps its reason.
    outcome: findings.length ? "recorded" : error ? "error" : settled?.agentFindings?.length ? "reported" : "no-finding",
    error: findings.length ? null : error,
    prepassError,
    ...prep?.record,
    // Which GitHub members were read (and where) and which were not, with why.
    sourceCoverage: sourceCov,
    pocRuns,
    // Every proven finding, worst first, each with its own replay proof: real
    // pass/fail, gas, decoded logs, and the signed money-moved table.
    findings,
    // Unproven, agent-asserted results. Never findings, never counted as one.
    // A candidate a proven finding took the place of is left out.
    agentFindings: (settled?.agentFindings ?? []).filter((f) => !supersededBy([f], findings).length),
    candidates: [...(settled?.candidates ?? []).filter((c) => !supersededBy([c], findings).length), ...measured],
    // Back-compat single-finding fields: the worst finding.
    findingSubmitted: findings.length > 0,
    finding: worst ? { title: worst.title, severity: worst.severity, poc: worst.poc } : null,
    pocProved: worst?.pocProved ?? false,
    proof: worst?.proof ?? null,
    decision: findings.length ? "approved" : null,
    recorded: findings.length > 0,
    leads: leadsFrom(all),
    calls: settled?.summary?.calls?.map((c) => c.name),
    final: settled?.summary?.final?.text?.slice(0, 1200),
    usage: settled?.usage, reports: settled?.reports,
  };
  writeFileSync(`${DIR}run-${ALIAS}.json`, JSON.stringify({ result, transcript: settled?.summary }, null, 2));
  // After the record is written: re-run each proven Foundry proof offline and
  // write its verdict side file. The record itself is never rewritten.
  if (findings.length) { try { await checkRecordedReplays(findings); } catch (err) { console.log("· replay re-run check failed " + String(err?.message ?? err)); } }
  await reach?.stop?.();
  await cleanupWorkspace(ws);

  console.log("\n==== run summary ====");
  console.log(JSON.stringify(result, null, 2));
  console.log("spent total NEAR $", spent().toFixed(4));
}

const cmd = process.argv[2];
if (cmd === "child") await child(process.argv);
else await main();
