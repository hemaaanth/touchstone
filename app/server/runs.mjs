// The live run orchestrator — the real heart of the app.
//
// This drives the SAME engine the CLI vertical slice drives (spike/agent-run.mjs):
// a real NEAR AI agent, over a real per-run Foundry sandbox, proving a real
// exploit. Nothing here is a mock. Clicking "Run" in the UI spawns the agent;
// the events you watch are the agent's actual tool calls as they happen.
//
// Lifecycle. One audit can prove several findings.
//   1. Spawn the agent worker. It ranks every suspect, worst first, then writes
//      and runs a Foundry PoC for each one. We stream every EVENT line it prints.
//      Each passing test it submits arrives as a `finding-submitted` event. The
//      worker does not block on a finding; it keeps auditing.
//   2. The worker settles on its own. It hands back every submitted finding with
//      the exact test source that passed.
//   3. We replay each finding's test once more for its proof delta, persist the
//      run as spike/results/agent/run-<id>.json, and broadcast one `finding`
//      event plus one replay-proof artifact per finding. A proven run records
//      itself; the operator can dismiss any finding later from the ledger.
import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { cleanupWorkspace } from "../../spike/lib/sandbox.mjs"
import { guard, spent, MODELS, CAP_USD, PROVIDER_ID, PROVIDER_LABEL } from "../../spike/lib/inference.mjs"
import { listTargets, pickTarget, prepareWorkspace, targetSummary } from "../../spike/lib/targets.mjs"
import { readScopes, addBriefScope, removeScope } from "../../spike/lib/scopes-store.mjs"
import { planModules, modulesEvent, moduleOn } from "../../spike/lib/modules.mjs"
import { runPrepass } from "../../spike/lib/prepass.mjs"
import { proveFindings, sortFindings } from "../../spike/lib/record.mjs"

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
const MAX_POC = process.env.MAX_POC ?? "12"

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

// Operator-configured scopes (briefs). Summarized like the target library, so the
// brief markdown never leaves the server; the summary carries only the links a run
// will fetch. These three back the /api/scopes routes.
export function listScopes() {
  return readScopes().map(targetSummary)
}

// Add a brief scope from pasted markdown. Returns its summary so the UI can select
// it immediately. Throws (surfaced as 400) when the title or markdown is empty.
export function addScope({ title, brief, blurb } = {}) {
  return targetSummary(addBriefScope({ title, brief, blurb }))
}

// Remove an operator scope by id. Returns whether one was removed.
export function deleteScope(id) {
  return { removed: removeScope(id) }
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
    // The module plan for this run — which parts of the pipeline are on and why,
    // so a reconnecting client can render it without replaying the event stream.
    modules: run.modules ?? null,
    status: run.status,
    startedAt: run.startedAt,
    events: run.events,
    // The worst finding submitted so far, as the run's headline.
    pending: run.pending,
    // Every finding submitted so far, in submit order.
    submitted: run.submitted,
    decision: run.decision,
    findingId: run.status === "recorded" ? (run.findingIds?.[0] ?? null) : null,
    findingIds: run.findingIds ?? [],
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
      findings: r.submitted.length,
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

export function createRun({ alias = Object.keys(MODELS)[0], targetId, modules } = {}) {
  if (!MODELS[alias]) throw new Error(`unknown model alias: ${alias}`)
  // Pick the scope from the target library: an explicit choice, or random across
  // the labs so repeated Runs stop re-breaking one prepared bug. Throws on an
  // unknown id before anything is spent.
  const target = pickTarget({ id: targetId })
  // Resolve the module plan from the scope and the operator's request. A module
  // the scope cannot support (static/fuzz on a brief with no local source yet) is
  // off with a reason, never silently dropped. The plan rides into the workspace
  // config, so the run worker builds exactly the tools this plan enables.
  const plan = planModules(target, modules)
  // Respect the hard spend cap before spending a cent of real inference.
  guard(0.02)

  mkdirSync(RESULTS_DIR, { recursive: true })
  const id = monotonicId(alias)
  const db = path.join(RESULTS_DIR, `run-${id}.sqlite`)
  const eventsFile = path.join(RESULTS_DIR, `run-${id}.events`)
  for (const f of [db, `${db}-wal`, `${db}-shm`, eventsFile]) rmSync(f, { force: true })
  const ws = prepareWorkspace(target, { modules: plan })

  const run = {
    id,
    alias,
    target,
    modules: plan,
    model: MODELS[alias].id,
    status: "starting",
    startedAt: Date.now(),
    events: [],
    subscribers: new Set(),
    db,
    ws,
    eventsFile,
    pending: null,
    submitted: [],
    findingIds: [],
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
  // The module plan for this run — which parts of the pipeline are on, and the
  // honest reason for any that are off. Also replayed to late subscribers.
  broadcast(run, modulesEvent(plan))

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
      // Gate each half on this run's module plan. A brief starts with no local
      // source, so both are off and the scanners never spin up; the agent fetches
      // the code and audits it directly.
      runStatic: moduleOn(run.modules, "static"),
      runFuzz: moduleOn(run.modules, "fuzz"),
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
        // Internal: carries the summary and every finding with its passing
        // source. Persistence reads it on exit; it is not a UI step.
        run.settled = {
          final: e.summary?.final?.text ?? null,
          status: e.status ?? null,
          reason: e.reason ?? null,
          calls: (e.summary?.calls ?? []).length,
          summary: e.summary ?? {},
          findings: e.findings ?? [],
          usage: e.usage ?? null,
          reports: e.reports ?? [],
        }
        return
      }
      broadcast(run, e)
      if (e.ev === "finding-submitted") {
        // The agent proved one more bug and keeps going. Track it, and keep the
        // worst one as the run's headline for the sidebar.
        run.submitted.push({ n: e.n, title: e.title, severity: e.severity, poc: e.poc })
        run.pending = sortFindings(run.submitted)[0]
        broadcast(run, { ev: "status", status: run.status, pending: run.pending })
      }
    },
    (line) => {
      run.stderr += line + "\n"
    },
  )
  child.stderr.on("data", (d) => {
    run.stderr += d
  })
  child.on("exit", async () => {
    if (run.status !== "running" && run.status !== "starting") return
    const s = run.settled
    // Findings come from the settled event, which carries each passing source.
    // If the worker died before settling, fall back to the live list: those
    // findings still record, but without a fresh replay proof.
    const found = s?.findings?.length ? s.findings : run.submitted
    if (found.length) {
      await recordRun(run, found)
      return
    }
    cleanupWorkspace(run.ws)
    if (s && s.status === "done") {
      // Terminal, but not an error: the agent audited and found nothing to prove.
      run.error = null
      if (s.final) broadcast(run, { ev: "no-finding", final: s.final })
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

// Record every finding of a settled run. Replays each finding's test for its
// proof delta (over the still-live workspace), writes the run record, then
// broadcasts one `finding` and one replay-proof artifact per finding, worst
// first. The workspace is torn down only after the replays finish.
async function recordRun(run, found) {
  run.status = "deciding"
  broadcast(run, { ev: "status", status: run.status, pending: run.pending })
  try {
    const findings = await proveFindings(run.ws, found, run.events, (m) => {
      run.stderr += `[proof-delta] ${m}\n`
    })
    persistRun(run, findings)
    run.findingIds = findings.map((_, k) => `${run.id}.${k + 1}`)
    run.proof = findings[0]?.proof ?? null
    findings.forEach((f, k) => {
      const id = run.findingIds[k]
      broadcast(run, {
        ev: "finding",
        id,
        runId: run.id,
        title: f.title,
        severity: f.severity,
        poc: f.poc,
        proven: f.pocProved,
        target: run.target.title,
      })
      // Each proven finding's replay proof is a pane document. Its body is
      // fetched by finding id via /api/findings/:id, which persistRun just wrote.
      if (!f.pocProved) return
      broadcast(run, { ev: "artifact-open", id: `proof-${id}`, title: `Replay proof — ${f.poc}`, kind: "proof", findingId: id })
      broadcast(run, { ev: "artifact-done", id: `proof-${id}` })
    })
    run.status = "recorded"
    run.decision = "approve"
    broadcast(run, { ev: "status", status: run.status, decision: "approve", findingId: run.findingIds[0], findingIds: run.findingIds })
  } catch (err) {
    run.error = String(err?.message ?? err)
    run.status = "error"
    broadcast(run, { ev: "status", status: run.status, error: run.error })
  } finally {
    cleanupWorkspace(run.ws)
    broadcast(run, { ev: "closed" })
  }
}

// Steer a live run. The operator's message is written to the worker's stdin as
// one JSON line; the worker injects it into the agent's in-flight turn (native
// pi-durable steering) and echoes it back as an `operator-message` event once it
// lands. Only valid while the worker is actually running — a settled run has no
// turn to join.
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

// Assemble the engine's canonical { result, transcript } record and write it
// where the findings reader looks. This mirrors agent-run.mjs main(), so a live
// run and a CLI run produce the same history shape.
function persistRun(run, findings) {
  const evs = run.events
  const s = run.settled ?? {}
  const summary = s.summary ?? {}
  const pocRuns = evs.filter((e) => e.ev === "run_poc").length
  const times = evs.map((e) => e.t).filter(Boolean)
  const ms = times.length ? times[times.length - 1] - times[0] : null
  const worst = findings[0] ?? null
  const result = {
    alias: run.alias,
    // The scope this run was pointed at, from the target library, so history and
    // the findings ledger can show which resource was under evaluation.
    target: targetSummary(run.target),
    // The module plan this run used — which parts of the pipeline were on, and the
    // reason for any that were off — so history shows the honest configuration.
    modules: run.modules ?? null,
    // The app has no manual gate: a proven run records itself. Mark approvals
    // "auto" so the ledger reads "Accepted · auto" rather than implying a click.
    approveMode: "auto",
    ms,
    status: s.status ?? null,
    reason: s.reason ?? null,
    // The pre-pass ensembles that fed the agent its leads: a suspect an engine
    // ranked, then proven by replay. A suspect is never a finding on its own.
    static: run.static ?? null,
    fuzz: run.fuzz ?? null,
    pocRuns,
    // Every proven finding, worst first, each with its own replay proof: real
    // pass/fail, gas, decoded logs, and the signed money-moved table.
    findings,
    // Back-compat single-finding fields: the worst finding.
    findingSubmitted: findings.length > 0,
    finding: worst ? { title: worst.title, severity: worst.severity, poc: worst.poc } : null,
    pocProved: worst?.pocProved ?? false,
    proof: worst?.proof ?? null,
    decision: "approved",
    recorded: true,
    calls: (summary.calls ?? []).map((c) => c.name),
    final: summary.final?.text ?? null,
    usage: s.usage ?? null,
    reports: s.reports ?? [],
  }
  writeFileSync(path.join(RESULTS_DIR, `run-${run.id}.json`), JSON.stringify({ result, transcript: summary }, null, 2))
}
