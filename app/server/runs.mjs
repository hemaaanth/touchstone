// The live run orchestrator — the real heart of the app.
//
// This drives the SAME engine the CLI vertical slice drives (spike/agent-run.mjs):
// a real NEAR AI agent, over a real per-run Foundry sandbox, proving a real
// exploit. Nothing here is a mock. Clicking "Run" in the UI spawns the agent;
// the events you watch are the agent's actual tool calls as they happen.
//
// Lifecycle, mapped onto the engine's durable two-phase shape:
//   1. Phase "run": spawn the agent worker. It reads the contract, writes a
//      Foundry PoC, and runs it — iterating until the exploit passes. We stream
//      every EVENT line it prints. When it reaches submit_finding it durably
//      persists a pending approval to SQLite and blocks; we kill the worker (the
//      request survives in the DB) and move the run to "awaiting-approval".
//   2. The human decides in the UI (Approve / Deny).
//   3. Phase "decide": resume over the same SQLite. Resume replays the run from
//      durable state — no new inference, no new docker — so it is cheap and
//      deterministic. The decider writes the human's verdict, the worker
//      unblocks, records (or rejects) the finding, and settles. We persist the
//      settled run as spike/results/agent/run-<id>.json so it joins history.
import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { makeWorkspace, cleanupWorkspace } from "../../spike/lib/sandbox.mjs"
import { guard, spent, MODELS, CAP_USD, PROVIDER_ID, PROVIDER_LABEL } from "../../spike/lib/inference.mjs"
import { listTargets, pickTarget, resolveTargetDir, targetSummary } from "../../spike/lib/targets.mjs"
import { runPrepass } from "../../spike/lib/prepass.mjs"
import { proofDelta } from "../../spike/lib/proof.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "../..")
const SPIKE = path.join(ROOT, "spike")

// The agent engine authenticates to NEAR AI with NEARAI_API_KEY. When this app
// is launched by `bun run dev` the shell has not sourced spike/.env.local, so
// the key is absent and every inference call fails instantly with model_error.
// A real app loads its own secrets: read the dotenv file in code (its values
// only ever flow into process.env, never into logs) and fill any key that is
// not already set. This keeps `bun run dev` a single, self-sufficient command.
function loadEnvLocal() {
  const file = path.join(SPIKE, ".env.local")
  if (!existsSync(file)) return 0
  let loaded = 0
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq < 0) continue
    const name = line.slice(0, eq).replace(/^export\s+/, "").trim()
    if (!name || name in process.env) continue
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    process.env[name] = value
    loaded += 1
  }
  return loaded
}
const loadedKeys = loadEnvLocal()
if (loadedKeys > 0) console.log(`[runs] loaded ${loadedKeys} key(s) from spike/.env.local`)
const ENGINE = path.join(SPIKE, "agent-run.mjs")
const RESULTS_DIR = path.join(SPIKE, "results", "agent")
const MAX_POC = process.env.MAX_POC ?? "6"
const KILL_GRACE_MS = 1500 // let the pending approval commit land before SIGKILL

// Which models the UI may run. Lifted straight from the engine's price table,
// so a run can never name a model the engine does not know how to bill.
export function availableModels() {
  return Object.entries(MODELS).map(([alias, m]) => ({
    alias,
    id: m.id,
    abliterated: alias.endsWith("-abl"),
  }))
}

export function spendState() {
  return { usd: spent(), cap: CAP_USD }
}

// The active inference provider (NEAR / Boundless / Lyber), so the UI can show
// which gateway a run will drive.
export function providerInfo() {
  return { id: PROVIDER_ID, label: PROVIDER_LABEL }
}

// The target library the UI picks a scope from. No filesystem paths leak out.
export function availableTargets() {
  return listTargets()
}

// In-memory registry. The Vite dev server is one long-lived Node process, so a
// Map plus per-run subscriber sets is all the live state we need.
const runs = new Map()
let seq = 0

function monotonicId(alias) {
  seq += 1
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(2, 12)
  return `${alias}-${stamp}-${seq}`
}

function broadcast(run, event) {
  run.events.push(event)
  for (const send of run.subscribers) {
    try {
      send(event)
    } catch {
      run.subscribers.delete(send)
    }
  }
}

// Public view of a run: safe to serialize, no child handles or sockets.
function view(run) {
  return {
    id: run.id,
    alias: run.alias,
    model: run.model,
    // The real scope this run is pointed at, from the target library — no longer
    // a hardcoded string. `target` stays a label for back-compat; `scope` carries
    // the structured descriptor so the UI can show kind, proof surface, and which
    // resource is under evaluation.
    target: run.target.title,
    scope: targetSummary(run.target),
    status: run.status,
    startedAt: run.startedAt,
    events: run.events,
    pending: run.pending,
    decision: run.decision,
    findingId: run.status === "recorded" ? run.id : null,
    error: run.error,
    // The pre-pass ensemble's ranked suspects (static then fuzz) and the proven
    // exploit's structured proof delta — the feeder → proof story, same shape the
    // CLI persists. Null until each stage has run. A suspect is never a finding.
    static: run.static ?? null,
    fuzz: run.fuzz ?? null,
    proof: run.proof ?? null,
  }
}

export function listRuns() {
  return [...runs.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((r) => ({
      id: r.id,
      alias: r.alias,
      status: r.status,
      startedAt: r.startedAt,
      title: r.pending?.title ?? null,
      severity: r.pending?.severity ?? null,
    }))
}

export function getRun(id) {
  const run = runs.get(id)
  return run ? view(run) : null
}

export function subscribe(id, send) {
  const run = runs.get(id)
  if (!run) return null
  // Replay what already happened so a late subscriber is never behind.
  for (const e of run.events) send(e)
  send({ ev: "status", status: run.status, pending: run.pending, decision: run.decision })
  if (["recorded", "denied", "error", "no-finding"].includes(run.status)) {
    send({ ev: "closed" })
    return () => {}
  }
  run.subscribers.add(send)
  return () => run.subscribers.delete(send)
}

// Parse the engine's stdout: it prints one `EVENT {json}` line per step. We
// forward the parsed object; everything else is diagnostic noise we keep for
// error reporting but do not stream as a step.
function pipeEvents(child, onEvent, onNoise) {
  let buf = ""
  child.stdout.on("data", (d) => {
    buf += d
    let i
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line.startsWith("EVENT ")) {
        try {
          onEvent(JSON.parse(line.slice(6)))
        } catch {
          /* ignore a torn line */
        }
      } else if (line.trim()) {
        onNoise(line)
      }
    }
  })
}

export function createRun({ alias = Object.keys(MODELS)[0], targetId } = {}) {
  if (!MODELS[alias]) throw new Error(`unknown model alias: ${alias}`)
  // Pick the scope from the target library: an explicit choice, or random across
  // the labs so repeated Runs stop re-breaking one prepared bug. Throws on an
  // unknown id before anything is spent.
  const target = pickTarget({ id: targetId })
  // Respect the hard spend cap before spending a cent of real inference.
  guard(0.02)

  mkdirSync(RESULTS_DIR, { recursive: true })
  const id = monotonicId(alias)
  const db = path.join(RESULTS_DIR, `run-${id}.sqlite`)
  const eventsFile = path.join(RESULTS_DIR, `run-${id}.events`)
  for (const f of [db, `${db}-wal`, `${db}-shm`, eventsFile]) rmSync(f, { force: true })
  const ws = makeWorkspace(resolveTargetDir(target))

  const run = {
    id,
    alias,
    target,
    model: MODELS[alias].id,
    status: "starting",
    startedAt: Date.now(),
    events: [],
    subscribers: new Set(),
    db,
    ws,
    eventsFile,
    pending: null,
    decision: null,
    error: null,
    child: null,
    stderr: "",
  }
  runs.set(id, run)

  // The first event names the scope under evaluation. RunView only sees the
  // event stream, not the run object, so without this it cannot show which
  // resource this run is pointed at — the reason every run used to look the
  // same. It lands in run.events, so a late subscriber replays it too.
  broadcast(run, { t: Date.now(), ev: "scope", scope: targetSummary(run.target) })

  setRunStatus(run, "running")
  // Drive the full engine asynchronously: the pre-pass ensemble first (so the
  // agent starts with leads), then the agent worker. This takes minutes — docker
  // scanners run before any inference — exactly what the CLI does. We do NOT await
  // it: the run is already in the registry, so the HTTP response returns now and
  // the UI watches the scan events, then the agent events, stream in live.
  startEngine(run).catch((err) => {
    run.error = String(err?.message ?? err)
    setRunStatus(run, "error")
    broadcast(run, { ev: "closed" })
  })

  return view(run)
}

function setRunStatus(run, status) {
  run.status = status
  broadcast(run, { ev: "status", status, pending: run.pending, decision: run.decision })
}

// Run the pre-pass ensemble over the prepared workspace, then spawn the agent
// worker with the leads. This is the SAME runPrepass the CLI drives, so a live
// run and a CLI run hand the agent byte-identical leads and emit byte-identical
// scan events. Each scan event is broadcast to the UI as it lands, and the ranked
// suspects are kept on the run so the persisted record carries the feeder → proof
// story. A suspect is never a finding — only a passing replay is.
async function startEngine(run) {
  let leads = {}
  try {
    const prep = await runPrepass(run.ws, {
      onStatic: (ev, scan) => {
        run.static = { tool: scan.tool, engines: scan.engines, mode: scan.mode, files: scan.files, analysed: scan.analysed, suspects: scan.findings.length, top: ev.top }
        broadcast(run, ev)
      },
      onFuzz: (ev, fuzz) => {
        run.fuzz = { tool: fuzz.tool, engines: fuzz.engines, template: fuzz.template, applicable: fuzz.applicable, suspects: fuzz.findings.length, top: ev.top }
        broadcast(run, ev)
      },
    })
    leads = prep.runEnv
  } catch (err) {
    // A pre-pass failure must not sink the run: the agent can still audit from
    // source with no leads. Record the reason as diagnostic noise and continue.
    run.stderr += `[prepass] ${String(err?.message ?? err)}\n`
  }
  // The run may have been torn down while scanning (e.g. process restart); only
  // start the agent if it is still live.
  if (run.status !== "running") return
  spawnAgent(run, leads)
}

// Spawn the agent worker over the prepared workspace, with the pre-pass leads in
// its env, and wire its event stream into the run.
function spawnAgent(run, leads) {
  const env = { ...process.env, ALIAS: run.alias, EVENTS_FILE: run.eventsFile, MAX_POC, ...leads }
  // stdin is a pipe (not "ignore") so the operator can steer the live run: we
  // write one JSON line per message to the worker, which injects it into the
  // agent's current turn. Swallow EPIPE if we race a worker that just exited.
  const child = spawn(process.execPath, [ENGINE, "child", "run", run.db, run.ws], {
    cwd: SPIKE,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  })
  child.stdin.on("error", () => {})
  run.child = child

  pipeEvents(
    child,
    (e) => {
      if (e.ev === "settled") {
        // The agent settled without submitting a finding. That has two very
        // different meanings and we must not conflate them: if it actually ran
        // (status "answered"), it is an honest dead end — it audited and found
        // nothing to prove. If it is "unanswered" (e.g. reason "model_error"),
        // the inference itself failed and this is an error, not a clean miss.
        run.settled = {
          final: e.summary?.final?.text ?? null,
          status: e.status ?? null,
          reason: e.reason ?? null,
          calls: (e.summary?.calls ?? []).length,
        }
        return
      }
      broadcast(run, e)
      if (e.ev === "approval-pending") {
        run.pending = { id: e.id, title: e.title, severity: e.severity, poc: e.poc }
        run.status = "awaiting-approval"
        broadcast(run, { ev: "status", status: run.status, pending: run.pending })
        // The pending request is now durable in SQLite. Kill the blocked worker;
        // the finding survives and the human decides when they are ready.
        setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS)
      }
    },
    (line) => {
      run.stderr += line + "\n"
    },
  )
  child.stderr.on("data", (d) => {
    run.stderr += d
  })
  child.on("exit", () => {
    if (run.status === "awaiting-approval") {
      // The agent proved an exploit and we killed it at the durable gate. The
      // operator chose auto-accept, so record it immediately — no manual click.
      // The decide phase just replays SQLite (no inference, no docker), so this
      // is cheap and deterministic. The operator can dismiss it later from the
      // ledger. The workspace is cleaned up by the decide child on its exit.
      decideRun(run.id, "approve")
      return
    }
    if (run.status !== "running" && run.status !== "starting") return // killed at the gate — expected
    cleanupWorkspace(run.ws)
    const s = run.settled
    if (s && s.status === "answered") {
      // Terminal, but not an error: the agent audited and found nothing to prove.
      run.error = null
      s.final && broadcast(run, { ev: "no-finding", final: s.final })
      setRunStatus(run, "no-finding")
    } else if (s) {
      // Settled "unanswered" — the inference did not complete. Report the real
      // reason rather than pretending the agent chose not to find anything.
      run.error =
        s.reason === "model_error"
          ? "the model call failed (model_error) — no inference completed, nothing was spent"
          : `the run did not complete (${s.reason ?? s.status ?? "unknown"})`
      setRunStatus(run, "error")
    } else {
      run.error = run.stderr.slice(-800) || "the agent exited before proving a finding"
      setRunStatus(run, "error")
    }
    broadcast(run, { ev: "closed" })
  })
}

// Steer a live run. The operator's message is written to the worker's stdin as
// one JSON line; the worker injects it into the agent's in-flight turn (native
// pi-durable steering) and echoes it back as an `operator-message` event once it
// lands. Only valid while the worker is actually running — at the approval gate
// the worker is already killed, and a settled run has no turn to join.
export function steerRun(id, text) {
  const run = runs.get(id)
  if (!run) throw new Error("no such run")
  if (run.status !== "running") throw new Error(`run is ${run.status}, not accepting steering`)
  const msg = typeof text === "string" ? text.trim() : ""
  if (!msg) throw new Error("empty steer message")
  if (!run.child?.stdin?.writable) throw new Error("the run worker is not accepting input")
  run.child.stdin.write(JSON.stringify({ text: msg }) + "\n")
  return { ok: true }
}

export function decideRun(id, verdict) {
  const run = runs.get(id)
  if (!run) throw new Error("no such run")
  if (run.status !== "awaiting-approval") throw new Error(`run is ${run.status}, not awaiting approval`)
  if (verdict !== "approve" && verdict !== "deny") throw new Error("verdict must be approve or deny")

  run.status = "deciding"
  run.decision = verdict
  broadcast(run, { ev: "status", status: run.status, decision: verdict })

  // APPROVE=deny denies; anything else approves (see agent-run.mjs decider).
  const env = { ...process.env, ALIAS: run.alias, EVENTS_FILE: run.eventsFile, APPROVE: verdict === "deny" ? "deny" : "approve" }
  const child = spawn(process.execPath, [ENGINE, "child", "decide", run.db, run.ws], {
    cwd: SPIKE,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  run.child = child
  let settled = null

  pipeEvents(
    child,
    (e) => {
      if (e.ev === "settled") {
        settled = e
        return // internal: triggers persistence on exit, not a UI step
      }
      broadcast(run, e)
    },
    (line) => {
      run.stderr += line + "\n"
    },
  )
  child.stderr.on("data", (d) => {
    run.stderr += d
  })
  child.on("exit", async () => {
    try {
      // persistSettled computes the proof delta — it re-runs the proven test over
      // the still-live workspace — so it must finish BEFORE the finally below tears
      // the workspace down. Hence await, and hence the handler is async.
      if (settled) await persistSettled(run, settled, verdict)
      const recorded = verdict === "approve"
      run.status = recorded ? "recorded" : "denied"
      broadcast(run, { ev: "status", status: run.status, decision: verdict, findingId: recorded ? run.id : null })
    } catch (err) {
      run.error = String(err?.message ?? err)
      run.status = "error"
      broadcast(run, { ev: "status", status: run.status, error: run.error })
    } finally {
      cleanupWorkspace(run.ws)
      broadcast(run, { ev: "closed" })
    }
  })

  return view(run)
}

// Assemble the engine's canonical { result, transcript } record from the live
// event stream + the settled summary, and write it where the findings reader
// looks. This mirrors agent-run.mjs main()'s result assembly exactly, so a live
// run and a CLI run produce byte-compatible history.
async function persistSettled(run, settled, verdict) {
  const evs = run.events
  const pending = run.pending ?? {}
  const pocRuns = evs.filter((e) => e.ev === "run_poc").length
  const summary = settled.summary ?? {}
  const times = evs.map((e) => e.t).filter(Boolean)
  const ms = times.length ? times[times.length - 1] - times[0] : null

  // "Proven" binds to the SUBMITTED contract, not any passing test — a throwaway
  // diagnostic that happens to pass must never turn the record green. The proven
  // contract is the one the finding claims (pending.poc); we re-check that its own
  // test passed, mirroring agent-run.mjs main() exactly.
  const provenContract = pending.poc ?? null
  const pocProved = provenContract
    ? evs.some((e) => e.ev === "run_poc-done" && e.passed && e.contract === provenContract)
    : false

  // Structured proof delta — the engine's own reading of the proven exploit. When
  // a finding proved, re-run its exact test ONE more time in JSON trace mode and
  // read the real money the EVM moved, per address, straight from the trace. This
  // runs over the still-live workspace (the decide exit handler tears it down only
  // after we return). Mirrors the CLI so live and CLI records carry the same proof.
  let proof = null
  if (pocProved && provenContract) {
    const pocCalls = (summary.calls ?? []).filter(
      (c) => c.name === "run_poc" && c.args?.contract_name === provenContract && c.args?.test_source,
    )
    const source = pocCalls.at(-1)?.args?.test_source ?? null
    if (source) {
      try {
        proof = await proofDelta(run.ws, { source, contract: provenContract })
      } catch (err) {
        run.stderr += `[proof-delta] ${String(err?.message ?? err)}\n`
      }
    }
  }
  run.proof = proof

  const result = {
    alias: run.alias,
    // The scope this run was pointed at, from the target library, so history and
    // the findings ledger can show which resource was under evaluation.
    target: targetSummary(run.target),
    // The app has no manual gate: a proven run records itself. Mark approvals
    // "auto" so the ledger reads "Accepted · auto" rather than implying a click.
    approveMode: verdict === "deny" ? "deny" : "auto",
    ms,
    status: settled.status ?? null,
    reason: settled.reason ?? null,
    // The pre-pass ensembles that fed the agent its leads, kept in the record so
    // the report can show the feeder → proof story: a suspect an engine ranked,
    // then proven by replay. Null if a pre-pass stage did not run. A suspect is
    // never a finding on its own.
    static: run.static ?? null,
    fuzz: run.fuzz ?? null,
    pocRuns,
    pocProved,
    // The engine's structured proof delta for the proven exploit: real pass/fail,
    // gas, decoded logs, and the signed money-moved table read from the trace.
    // Null when nothing proved or the replay produced no parsable JSON.
    proof,
    findingSubmitted: Boolean(pending.id),
    finding: pending.id ? { title: pending.title, severity: pending.severity, poc: pending.poc } : null,
    decision: verdict === "deny" ? "denied" : "approved",
    recorded: verdict === "approve",
    killedAfterApproval: true,
    calls: (summary.calls ?? []).map((c) => c.name),
    final: summary.final?.text ?? null,
    usage: settled.usage ?? null,
    reports: settled.reports ?? [],
  }
  writeFileSync(path.join(RESULTS_DIR, `run-${run.id}.json`), JSON.stringify({ result, transcript: summary }, null, 2))
}
