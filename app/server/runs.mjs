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
import { mkdirSync, writeFileSync, appendFileSync, rmSync, readFileSync, readdirSync, renameSync, statSync, existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { cleanupWorkspace, readTouchstone } from "../../spike/lib/sandbox.mjs"
import { spent } from "../../spike/lib/inference.mjs"
import { activeProvider, allProviders, defaultAlias, readConfig, runBudgetUsd } from "../../spike/lib/providers.mjs"
import { validateRunBudget } from "../../spike/lib/run-budget.mjs"
import { getTarget, listTargets, pickTarget, prepareWorkspace, targetSummary } from "../../spike/lib/targets.mjs"
import { readScopes, addBriefScope, addSourceScope, addRepoScope, removeScope } from "../../spike/lib/scopes-store.mjs"
import { planModules, modulesEvent, moduleOn } from "../../spike/lib/modules.mjs"
import { packFor, packList, PACKS } from "../../spike/packs/index.mjs"
import { sortFindings } from "../../spike/lib/record.mjs"
import { isProven, proofKind, withProven } from "../../spike/lib/proof-view.mjs"

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

// Which models the UI may run: the active provider's price table, the Settings
// default first. A run can never name a model the engine does not know how to bill.
export function availableModels() {
  const cfg = readConfig()
  const p = activeProvider(cfg)
  const first = defaultAlias(p, cfg)
  return Object.entries(p.models)
    .map(([alias, m]) => ({ alias, id: m.id, abliterated: /-abl$|abliterat|uncensor/i.test(`${alias} ${m.id}`) }))
    .sort((a, b) => (b.alias === first) - (a.alias === first))
}

export function spendState() {
  return { usd: spent(), budgetUsd: runBudgetUsd() }
}

// The active inference provider, so the UI can show which gateway a run drives.
export function providerInfo() {
  const p = activeProvider()
  return { id: p.id, label: p.label }
}

// The provider a run used. Runs from before Settings did not record one; they
// ran on Boundless, or on the first provider that knows the alias.
function runProvider(run) {
  if (run.provider) return run.provider
  const all = allProviders()
  if (all.boundless?.models?.[run.alias]) return "boundless"
  return Object.values(all).find((p) => p.models?.[run.alias])?.id ?? activeProvider().id
}

// The target library the UI picks a scope from. No filesystem paths leak out.
export function availableTargets() {
  return listTargets()
}

// The modules (packs) the New run dialog may offer. Read from the pack loader,
// so a new pack appears here with no change to the app.
export function availablePacks() {
  return packList()
}

// Operator-configured scopes (briefs). Summarized like the target library, so the
// brief markdown never leaves the server; the summary carries only the links a run
// will fetch. These three back the /api/scopes routes.
export function listScopes() {
  return readScopes().map(targetSummary)
}

// Add a brief scope from pasted markdown. Returns its summary so the UI can select
// it immediately. Throws (surfaced as 400) when the title or markdown is empty.
export function addScope({ title, brief, blurb, files, repo } = {}) {
  const scope = files ? addSourceScope({ title, files }) : repo ? addRepoScope({ title, repo }) : addBriefScope({ title, brief, blurb })
  return { ...targetSummary(scope), runnable: true }
}

// Remove an operator scope by id. Returns whether one was removed.
export function deleteScope(id) {
  return { removed: removeScope(id) }
}

// Run registry. Live runs keep their subscribers here. Every event a run
// broadcasts is also appended to `run-<id>.stream.jsonl`, so a server restart
// loses nothing: at load, saved runs come back from disk (loadSavedRuns below).
const runs = new Map()
let seq = 0
const TERMINAL = ["recorded", "denied", "error", "no-finding"]

// No worker is running for this run: the audit is over and no follow-up is
// being answered. The operator can still message it unless it is archived.
function idle(run) {
  return TERMINAL.includes(run.status) && !run.replying
}

function monotonicId(alias) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(2, 12)
  let id
  do {
    seq += 1
    id = `${alias}-${stamp}-${seq}`
  } while (runs.has(id))
  return id
}

function broadcast(run, event) {
  run.events.push(event)
  if (run.streamFile) {
    try {
      appendFileSync(run.streamFile, JSON.stringify(event) + "\n")
    } catch {
      /* a full disk must not stop a live run */
    }
  }
  for (const send of run.subscribers) {
    try {
      send(event)
    } catch {
      run.subscribers.delete(send)
    }
  }
}

// A live run holds its target object; a run loaded from disk holds only the
// scope summary its first event carried (or none, for a run older than scopes).
function scopeOf(run) {
  return run.target ? targetSummary(run.target) : (run.scope ?? null)
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
    target: scopeOf(run)?.title ?? null,
    scope: scopeOf(run),
    // The module (pack) this run uses. A run saved before modules existed is Contracts.
    pack: scopeOf(run)?.pack ?? "contracts",
    // The module plan for this run — which parts of the pipeline are on and why,
    // so a reconnecting client can render it without replaying the event stream.
    modules: run.modules ?? null,
    status: run.status,
    archived: Boolean(run.archived),
    replying: Boolean(run.replying),
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
    // The pack's whole pre-pass record, whatever its shape. Contracts keeps its
    // static and fuzz parts above as well.
    prepass: run.prepass ?? null,
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
      archived: Boolean(r.archived),
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

// `since` skips events the client already holds (it loaded a snapshot first).
export function subscribe(id, send, since = 0) {
  const run = runs.get(id)
  if (!run) return null
  // Replay what already happened so a late subscriber is never behind.
  for (const e of run.events.slice(since)) send(e)
  send({ ev: "status", status: run.status, pending: run.pending, decision: run.decision })
  // An idle run has nothing more to stream. A follow-up message makes it busy
  // again; the client then loads it fresh and follows the new stream.
  if (idle(run)) {
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

export function createRun({ alias, targetId, modules, budgetUsd, pack } = {}) {
  const cfg = readConfig()
  const provider = activeProvider(cfg)
  alias ??= defaultAlias(provider, cfg)
  if (!provider.models[alias]) throw new Error(`unknown model alias for ${provider.label}: ${alias}`)
  // Pick the scope from the target library: an explicit choice, or random across
  // the labs so repeated Runs stop re-breaking one prepared bug. Throws on an
  // unknown id before anything is spent.
  // The module (pack) comes from the request. With no pack, a chosen scope
  // decides it, and nothing chosen means Contracts. An unknown pack, or a scope
  // that belongs to another pack, is refused before anything is spent.
  if (pack != null && pack !== "" && !PACKS[pack]) throw new Error(`unknown module: ${pack}`)
  const target = pickTarget({ id: targetId, pack: pack || undefined })
  // Resolve the module plan from the scope and the operator's request. A module
  // the scope cannot support (static/fuzz on a brief with no local source yet) is
  // off with a reason, never silently dropped. The plan rides into the workspace
  // config, so the run worker builds exactly the tools this plan enables.
  const plan = planModules(target, modules)
  // Each run has its own budget. The worker stops the run when it is spent.
  const budget = budgetUsd == null || budgetUsd === "" ? runBudgetUsd(cfg) : validateRunBudget(budgetUsd)

  mkdirSync(RESULTS_DIR, { recursive: true })
  const id = monotonicId(alias)
  const db = path.join(RESULTS_DIR, `run-${id}.sqlite`)
  const eventsFile = path.join(RESULTS_DIR, `run-${id}.events`)
  const streamFile = path.join(RESULTS_DIR, `run-${id}.stream.jsonl`)
  for (const f of [db, `${db}-wal`, `${db}-shm`, eventsFile, streamFile]) rmSync(f, { force: true })
  const ws = prepareWorkspace(target, { modules: plan })

  const run = {
    id,
    alias,
    provider: provider.id,
    target,
    modules: plan,
    model: provider.models[alias].id,
    status: "starting",
    startedAt: Date.now(),
    events: [],
    subscribers: new Set(),
    db,
    ws,
    eventsFile,
    streamFile,
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
  broadcast(run, { t: Date.now(), ev: "budget", usd: budget })
  // The module plan for this run — which parts of the pipeline are on, and the
  // honest reason for any that are off. Also replayed to late subscribers.
  broadcast(run, modulesEvent(plan))
  // The provider and model, so a follow-up after a restart uses the same pair.
  broadcast(run, { t: Date.now(), ev: "provider", provider: provider.id, model: run.model })

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
  const e = { t: Date.now(), ev: "status", status, pending: run.pending, decision: run.decision }
  if (run.error) e.error = run.error
  broadcast(run, e)
}

// Run the pack's pre-pass before starting the agent with its leads.
async function startEngine(run) {
  let leads = {}
  try {
    const prep = await packFor(readTouchstone(run.ws)).prepass?.(run.ws, {
      emit: (ev) => broadcast(run, ev),
    })
    run.prepass = prep?.record ?? null
    run.static = prep?.record?.static
    run.fuzz = prep?.record?.fuzz
    leads = prep?.env ?? {}
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

// Handle one engine event for a run. Shared by the audit worker and the
// follow-up worker.
function engineEvents(run) {
  return (e) => {
    if (e.ev === "budget-reached") run.error = e.error
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
  }
}

// The run's budget and what it has spent so far, from its own events. A
// follow-up carries the spent amount forward, so the budget covers the whole run.
function budgetEnv(run) {
  const set = run.events.findLast((e) => e.ev === "budget")
  const spend = run.events.findLast((e) => e.ev === "spend")
  return { RUN_BUDGET_USD: String(set?.usd ?? runBudgetUsd()), RUN_SPENT_USD: String(spend?.usd ?? 0) }
}

// Spawn the agent worker over the prepared workspace, with the pre-pass leads in
// its env, and wire its event stream into the run.
function spawnAgent(run, leads) {
  const env = { ...process.env, PROVIDER: runProvider(run), ALIAS: run.alias, EVENTS_FILE: run.eventsFile, MAX_POC, ...budgetEnv(run), ...leads }
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

  pipeEvents(child, engineEvents(run), (line) => {
    run.stderr += line + "\n"
  })
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

// Broadcast one `finding` event, and one replay-proof document if it passed, per
// recorded finding. `first` is the index of the first one in the run record.
function announceFindings(run, findings, first) {
  findings.forEach((f, k) => {
    const id = run.findingIds[first + k]
    broadcast(run, {
      ev: "finding",
      id,
      runId: run.id,
      title: f.title,
      severity: f.severity,
      poc: f.poc,
      proofKind: proofKind(f),
      proven: isProven(f),
      target: scopeOf(run)?.title ?? null,
    })
    // Each proven finding's replay proof is a pane document. Its body is
    // fetched by finding id via /api/findings/:id, which the record now holds.
    if (!isProven(f)) return
    broadcast(run, { ev: "artifact-open", id: `proof-${id}`, title: `Replay proof — ${f.poc ?? f.title}`, kind: "proof", findingId: id })
    broadcast(run, { ev: "artifact-done", id: `proof-${id}` })
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
    const findings = withProven(await packFor(readTouchstone(run.ws)).prove?.(run.ws, found, run.events, (m) => {
      run.stderr += `[proof-delta] ${m}\n`
    }))
    persistRun(run, findings)
    run.findingIds = findings.map((_, k) => `${run.id}.${k + 1}`)
    run.proof = findings[0]?.proof ?? null
    announceFindings(run, findings, 0)
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

// Message a run. While a worker is running, the message is written to its
// stdin as one JSON line; the worker injects it into the agent's in-flight turn
// (native pi-durable steering) and echoes it back as an `operator-message`
// event once it lands. When the run is idle, the message starts a follow-up
// worker that reopens the saved session. Only an archived run refuses.
export function steerRun(id, text) {
  const run = runs.get(id)
  if (!run) throw new Error("no such run")
  if (run.archived) throw new Error("this run is archived")
  const msg = typeof text === "string" ? text.trim() : ""
  if (!msg) throw new Error("empty message")
  if (idle(run)) return followUp(run, msg)
  if (!run.child?.stdin?.writable) throw new Error(`the run is ${run.status}; try again in a moment`)
  run.child.stdin.write(JSON.stringify({ text: msg }) + "\n")
  return { ok: true }
}

// A run loaded from disk has no file paths on it yet. Set them from its id.
// A run rebuilt from an older record has no stream file, so write its events
// there first: new events must append to the full history, not replace it.
function ensureFiles(run) {
  run.db ??= path.join(RESULTS_DIR, `run-${run.id}.sqlite`)
  run.eventsFile ??= path.join(RESULTS_DIR, `run-${run.id}.events`)
  if (!run.streamFile) {
    run.streamFile = path.join(RESULTS_DIR, `run-${run.id}.stream.jsonl`)
    if (!existsSync(run.streamFile)) writeFileSync(run.streamFile, run.events.map((e) => JSON.stringify(e) + "\n").join(""))
  }
}

// Start a follow-up: one operator message to an idle run. The worker reopens
// the run's saved agent session in a fresh workspace, answers, and exits. Any
// finding it proves is replayed and added to the run record.
function followUp(run, text) {
  const money = budgetEnv(run)
  if (Number(money.RUN_SPENT_USD) >= Number(money.RUN_BUDGET_USD)) throw new Error("this run has spent its budget")
  ensureFiles(run)
  if (!existsSync(run.db)) throw new Error("this run has no saved agent session to resume")
  const target = run.target ?? (run.scope?.id ? getTarget(run.scope.id) : null)
  if (!target) throw new Error("this run's scope is no longer in the library")
  run.target = target
  run.ws = prepareWorkspace(target, { modules: run.modules ?? [] })
  // Steps from earlier turns are keyed by attempt; start past the last one.
  const attempts = run.events.filter((e) => e.ev === "thinking-delta" || e.ev === "assistant-delta").map((e) => Number(e.attempt) || 0)
  const prior = run.submitted.map(({ n, title, severity, poc }) => ({ n, title, severity, poc }))
  run.settled = null
  run.replying = true
  broadcast(run, { t: Date.now(), ev: "reply-start" })

  const child = spawn(process.execPath, [ENGINE, "child", "chat", run.db, run.ws], {
    cwd: SPIKE,
    env: {
      ...process.env,
      PROVIDER: runProvider(run),
      ALIAS: run.alias,
      EVENTS_FILE: run.eventsFile,
      MAX_POC,
      ...money,
      FOLLOWUP: text,
      PRIOR_FOUND: JSON.stringify(prior),
      ATTEMPT_BASE: String(Math.max(-1, ...attempts) + 1),
    },
    stdio: ["pipe", "pipe", "pipe"],
  })
  child.stdin.on("error", () => {})
  run.child = child
  pipeEvents(child, engineEvents(run), (line) => {
    run.stderr += line + "\n"
  })
  child.stderr.on("data", (d) => {
    run.stderr += d
  })
  child.on("exit", async () => {
    const s = run.settled
    try {
      if (s?.findings?.length) await recordMore(run, s.findings)
      else if (!s) broadcast(run, { t: Date.now(), ev: "reply-error", error: run.stderr.slice(-800) || "the follow-up worker exited early" })
    } catch (err) {
      broadcast(run, { t: Date.now(), ev: "reply-error", error: String(err?.message ?? err) })
    } finally {
      cleanupWorkspace(run.ws)
      run.child = null
      run.replying = false
      broadcast(run, { t: Date.now(), ev: "closed" })
    }
  })
  return { ok: true, followUp: true }
}

// Add findings a follow-up proved to the run record, after the ones it holds,
// so earlier finding ids stay the same.
async function recordMore(run, found) {
  const findings = withProven(await packFor(readTouchstone(run.ws)).prove?.(run.ws, found, run.events, (m) => {
    run.stderr += `[proof-delta] ${m}\n`
  }))
  const file = path.join(RESULTS_DIR, `run-${run.id}.json`)
  let first = 0
  if (existsSync(file)) {
    const rec = JSON.parse(readFileSync(file, "utf8"))
    const r = rec.result
    first = r.findings?.length ?? 0
    r.findings = [...(r.findings ?? []), ...findings]
    r.findingSubmitted = true
    if (!r.finding) {
      const worst = findings[0]
      r.finding = { title: worst.title, severity: worst.severity, poc: worst.poc }
      r.pocProved = isProven(worst)
      r.proof = worst.proof ?? null
    }
    writeFileSync(file, JSON.stringify(rec, null, 2))
  } else {
    persistRun(run, findings)
  }
  run.findingIds = [...run.findingIds.slice(0, first), ...findings.map((_, k) => `${run.id}.${first + k + 1}`)]
  announceFindings(run, findings, first)
  run.status = "recorded"
  run.decision = "approve"
  broadcast(run, { t: Date.now(), ev: "status", status: run.status, decision: "approve", findingId: run.findingIds[0], findingIds: run.findingIds })
}

// Archive a run, or bring it back. An archived run is locked: it takes no more
// messages. The flag is an event in the run's own stream file, so it survives
// a restart with no second store.
export function archiveRun(id, archived) {
  const run = runs.get(id)
  if (!run) throw new Error("no such run")
  if (archived && !idle(run)) throw new Error("the agent is still working; archive it once it stops")
  ensureFiles(run)
  run.archived = Boolean(archived)
  broadcast(run, { t: Date.now(), ev: "archived", archived: run.archived })
  return { ok: true, archived: run.archived }
}

// Delete a run. Its files (stream, record, engine log, session) move to a
// trash folder beside them rather than being erased, so a mistake can be put
// back by hand. The run's findings live in its record, so they leave the
// ledger with it. A run the agent is still working on cannot be deleted.
export function deleteRun(id) {
  const run = runs.get(id)
  if (!run) throw new Error("no such run")
  if (!idle(run)) throw new Error("the agent is still working; delete it once it stops")
  const trash = path.join(RESULTS_DIR, "trash")
  mkdirSync(trash, { recursive: true })
  const prefix = `run-${id}.`
  if (existsSync(RESULTS_DIR)) {
    for (const f of readdirSync(RESULTS_DIR)) {
      if (f.startsWith(prefix)) renameSync(path.join(RESULTS_DIR, f), path.join(trash, f))
    }
  }
  runs.delete(id)
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
    provider: runProvider(run),
    // The scope this run was pointed at, from the target library, so history and
    // the findings ledger can show which resource was under evaluation.
    target: scopeOf(run),
    pack: scopeOf(run)?.pack ?? "contracts",
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
    // The pack's whole pre-pass record, kept as it came.
    prepass: run.prepass ?? null,
    pocRuns,
    // Every proven finding, worst first, each with its own replay proof: real
    // pass/fail, gas, decoded logs, and the signed money-moved table.
    findings,
    // Back-compat single-finding fields: the worst finding.
    findingSubmitted: findings.length > 0,
    finding: worst ? { title: worst.title, severity: worst.severity, poc: worst.poc } : null,
    pocProved: isProven(worst),
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

// ---------------------------------------------------------------------------
// Saved runs. At load, every app run on disk comes back into the registry as a
// settled run, so the sidebar lists real history and a restart loses nothing.
//
// A run started by this server has `run-<id>.stream.jsonl`: the exact events
// it broadcast. An older app run has only the engine's `run-<id>.events` plus
// its `run-<id>.json` record; we rebuild the same event shape from those two.
// CLI runs (`run-<alias>.json`, no stamp) are not app runs and are skipped.
const APP_RUN = /^run-([a-z0-9-]+-\d{10}-\d+)\.(stream\.jsonl|json)$/

function readJsonl(file) {
  const out = []
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      /* a torn last line from a crash */
    }
  }
  return out
}

// Rebuild the broadcast stream of an older app run from its record and its
// engine events. Mirrors what createRun, startEngine and recordRun broadcast.
function rebuildEvents(id, record, engineEvents) {
  const r = record.result ?? {}
  const t0 = engineEvents[0]?.t ?? Date.now()
  const tN = engineEvents[engineEvents.length - 1]?.t ?? t0
  const evs = []
  if (r.target) evs.push({ t: t0, ev: "scope", scope: r.target })
  if (Array.isArray(r.modules)) evs.push({ ...modulesEvent(r.modules), t: t0 })
  if (r.static) evs.push({ t: t0, ev: "static-scan", failed: 0, ...r.static })
  if (r.fuzz) evs.push({ t: t0, ev: "fuzz-scan", ...r.fuzz })
  // Older engines did not stream each PoC as a file. The settled summary still
  // holds every run_poc call in order, so give each attempt its file back.
  const settled = engineEvents.find((e) => e.ev === "settled")
  const sources = (settled?.summary?.calls ?? []).filter((c) => c.name === "run_poc" && c.args?.test_source)
  const hasFile = new Set(engineEvents.filter((e) => e.ev === "artifact-open" && e.kind === "poc").map((e) => `${e.contract}#${e.attempt}`))
  for (const e of engineEvents) {
    if (e.ev === "settled") continue
    evs.push(e)
    if (e.ev !== "run_poc" || !e.contract) continue
    const k = sources.findIndex((c) => c.args.contract_name === e.contract)
    const call = k >= 0 ? sources.splice(k, 1)[0] : null
    if (!call || hasFile.has(`${e.contract}#${e.attempt}`)) continue
    const artId = `poc-${e.contract}-${e.attempt}`
    evs.push({ t: e.t, ev: "artifact-open", id: artId, fileId: `poc-${e.contract}`, title: `${e.contract}.t.sol`, kind: "poc", lang: "solidity", attempt: e.attempt, contract: e.contract })
    evs.push({ t: e.t, ev: "artifact-delta", id: artId, text: call.args.test_source })
    evs.push({ t: e.t, ev: "artifact-done", id: artId })
  }
  evs.push({ t: tN, ev: "status", status: "deciding" })
  // New records list every finding (ids `<runId>.<k>`); an older record has
  // one finding whose id is the run id (see splitRun in findings.mjs).
  const list = Array.isArray(r.findings) && r.findings.length
    ? r.findings.map((f, k) => ({ id: `${id}.${k + 1}`, title: f.title, severity: f.severity, poc: f.poc, proven: isProven(f) }))
    : r.finding
      ? [{ id, title: r.finding.title, severity: r.finding.severity, poc: r.finding.poc, proven: isProven({ pocProved: r.pocProved, proof: r.proof }) }]
      : []
  for (const f of list) {
    evs.push({ t: tN, ev: "finding", id: f.id, runId: id, title: f.title, severity: f.severity, poc: f.poc, proven: f.proven, target: r.target?.title ?? null })
    if (!f.proven) continue
    evs.push({ t: tN, ev: "artifact-open", id: `proof-${f.id}`, title: `Replay proof — ${f.poc ?? f.title}`, kind: "proof", findingId: f.id })
    evs.push({ t: tN, ev: "artifact-done", id: `proof-${f.id}` })
  }
  const ids = list.map((f) => f.id)
  if (ids.length) {
    evs.push({ t: tN, ev: "status", status: "recorded", decision: "approve", findingId: ids[0], findingIds: ids })
  } else if (r.final) {
    evs.push({ t: tN, ev: "no-finding", final: r.final })
    evs.push({ t: tN, ev: "status", status: "no-finding" })
  } else {
    evs.push({ t: tN, ev: "status", status: "error", error: "the run did not complete" })
  }
  evs.push({ t: tN, ev: "closed" })
  return evs
}

// Turn a saved event list into a settled registry entry. Status, headline and
// finding ids are read back from the events themselves.
function savedRun(id, events, mtime) {
  const alias = id.replace(/-\d{10}-\d+$/, "")
  let status = "error"
  let decision = null
  let error = null
  let findingIds = []
  let scope = null
  let modules = null
  let provider = null
  let model = null
  let archived = false
  const submitted = []
  for (const e of events) {
    if (e.ev === "archived") archived = Boolean(e.archived)
    if (e.ev === "scope") scope = e.scope ?? null
    if (e.ev === "modules") modules = e.modules ?? null
    if (e.ev === "provider") ({ provider = null, model = null } = e)
    if ((e.ev === "finding-submitted" || e.ev === "approval-pending") && !submitted.some((f) => f.poc === e.poc)) {
      submitted.push({ n: e.n ?? submitted.length + 1, title: e.title, severity: e.severity, poc: e.poc })
    }
    if (e.ev === "status") {
      status = e.status ?? status
      if (e.decision) decision = e.decision
      if (Array.isArray(e.findingIds)) findingIds = e.findingIds
      if (typeof e.error === "string") error = e.error
    }
  }
  // A terminal status always lands in the stream file. Without one, the server
  // stopped mid-run. Mark it in memory only: the file stays the true record.
  if (!TERMINAL.includes(status)) {
    status = "error"
    error = "the server restarted during this run, so it stopped"
    events.push({ t: Date.now(), ev: "status", status, error })
  }
  // Same for a follow-up the restart cut off: it started after the last close.
  const lastClose = events.findLastIndex((e) => e.ev === "closed")
  if (events.findLastIndex((e) => e.ev === "reply-start") > lastClose) {
    events.push({ t: Date.now(), ev: "reply-error", error: "the server restarted during this reply, so it stopped" })
    events.push({ t: Date.now(), ev: "closed" })
  }
  if (!events.some((e) => e.ev === "closed")) events.push({ t: Date.now(), ev: "closed" })
  return {
    id,
    alias,
    target: null,
    scope,
    modules,
    provider,
    model: model ?? Object.values(allProviders()).find((p) => p.models?.[alias])?.models[alias].id ?? alias,
    status,
    archived,
    startedAt: events.find((e) => e.t)?.t ?? mtime,
    events,
    subscribers: new Set(),
    pending: sortFindings(submitted)[0] ?? null,
    submitted,
    findingIds,
    decision,
    error,
    child: null,
    stderr: "",
  }
}

function loadSavedRuns() {
  if (!existsSync(RESULTS_DIR)) return
  const ids = new Set()
  for (const f of readdirSync(RESULTS_DIR)) {
    const m = APP_RUN.exec(f)
    if (m) ids.add(m[1])
  }
  for (const id of ids) {
    try {
      const streamFile = path.join(RESULTS_DIR, `run-${id}.stream.jsonl`)
      const recordFile = path.join(RESULTS_DIR, `run-${id}.json`)
      let events
      let mtime
      if (existsSync(streamFile)) {
        events = readJsonl(streamFile)
        mtime = statSync(streamFile).mtimeMs
      } else {
        const engineFile = path.join(RESULTS_DIR, `run-${id}.events`)
        const engine = existsSync(engineFile) ? readJsonl(engineFile) : []
        events = rebuildEvents(id, JSON.parse(readFileSync(recordFile, "utf8")), engine)
        mtime = statSync(recordFile).mtimeMs
      }
      if (!events.length) continue
      runs.set(id, savedRun(id, events, mtime))
    } catch (err) {
      console.warn(`[runs] skipped saved run ${id}: ${String(err?.message ?? err).slice(0, 200)}`)
    }
  }
}

loadSavedRuns()
