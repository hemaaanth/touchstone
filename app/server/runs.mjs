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
import { DatabaseSync } from "node:sqlite"
import { mkdirSync, writeFileSync, appendFileSync, rmSync, readFileSync, readdirSync, renameSync, statSync, existsSync, realpathSync, readlinkSync, openSync, closeSync, fstatSync, constants as fsc } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { cleanupWorkspace, readTouchstone } from "../../spike/lib/sandbox.mjs"
import { spent } from "../../spike/lib/inference.mjs"
import { activeProvider, allProviders, defaultAlias, readConfig } from "../../spike/lib/providers.mjs"
import { appRunBudgetUsd } from "./settings.mjs"
import { validateRunBudget } from "../../spike/lib/run-budget.mjs"
import { getTarget, listTargets, pickTarget, prepareRunWorkspace, prepareWorkspace, targetSummary } from "../../spike/lib/targets.mjs"
import { enforceReach, openReach } from "../../spike/lib/reach.mjs"
import { readScopes, addBriefScope, addSourceScope, addRepoScope, addLiveScope, addScope as addMembersScope, removeScope, validateMembers, classifyPath, safeRelPath, SKIP_DIRS, MAX_FILES, MAX_BYTES } from "../../spike/lib/scopes-store.mjs"
import { planModules, modulesEvent, moduleOn } from "../../spike/lib/modules.mjs"
import { packFor, packList, PACKS } from "../../spike/packs/index.mjs"
import { sortFindings } from "../../spike/lib/record.mjs"
import { isProven, proofKind, withProven } from "../../spike/lib/proof-view.mjs"
import { prepassView, prepassFailed, prepassFromResult } from "../../spike/lib/prepass-view.mjs"

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
// TOUCHSTONE_RESULTS_DIR lets a test use a throwaway folder.
const RESULTS_DIR = process.env.TOUCHSTONE_RESULTS_DIR || path.join(SPIKE, "results", "agent")

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
  return { usd: spent(), budgetUsd: appRunBudgetUsd() }
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

// Add an operator scope. Returns its summary so the UI can select it at once.
// Throws (surfaced as 400) on a bad body.
//   { title, members: [{ kind:"repo", url } | { kind:"folder", name, files }], pack? }
//       the main shape: repos and folders mixed, any language. `pack` is a hint
//       that counts only for repos; the content decides (scopes-store scopePack).
//   { title, files }   one folder (legacy)
//   { title, repo }    one GitHub repo, audited as Solidity (legacy)
//   { title, brief }   pasted markdown with links (legacy)
//   { kind: "live", title, hosts, pack?, permission: true }
//       real websites. `permission` is the operator's checkbox; it becomes the
//       grant that lets a run reach these hosts.
export function addScope({ kind, title, brief, blurb, files, repo, members, pack, hosts, permission, token, tokens, toolScope, assistant, allowPrivate } = {}) {
  if (kind === "live") {
    // Checked before the grant is written, so an unknown module saves nothing.
    if (pack != null && pack !== "" && !Object.hasOwn(PACKS, pack)) throw new Error(`unknown module: ${pack}`)
    // allowPrivate reaches the store only on this live path, and only `true` opts in.
    const live = addLiveScope({ title, hosts, pack, blurb, permission, token, tokens, toolScope, assistant, allowPrivate: allowPrivate === true })
    return { ...targetSummary(live), runnable: true }
  }
  const scope = members !== undefined
    ? addMembersScope({ title, members: readLocalFolders(members), pack, blurb })
    : files ? addSourceScope({ title, files }) : repo ? addRepoScope({ title, repo }) : addBriefScope({ title, brief, blurb })
  return { ...targetSummary(scope), runnable: true }
}

// A local folder is read IN PLACE, on this machine: the operator names its path
// and nothing is uploaded. The walk skips hidden entries, dependency and build
// folders, and symlinks, and keeps only source files by name, before it reads
// any content. Then validateMembers (folderFiles) checks every file again:
// secret names and content, the file and size limits. Returns the folder's
// real path, a safe folder name, and its source files.
const MAX_SCAN = 20000

// Is the open file `fd` inside `root`? On Linux, /proc/self/fd/<fd> names the
// file the descriptor really points at. If this descriptor-anchored proof is
// unavailable, refuse the read: checking the path again can race a symlink swap.
export function openedInside(fd, _st, _full, root, readDescriptorPath = readlinkSync) {
  let where
  try {
    where = readDescriptorPath(`/proc/self/fd/${fd}`)
  } catch {
    throw new Error("Cannot prove this file is inside the scope root on this platform.")
  }
  return where.startsWith(root + path.sep)
}

// `hooks.beforeOpen(relPath)` runs just before each file is opened. Tests use
// it to swap a folder at that moment; HTTP callers cannot pass it.
export function readFolderInPlace(dir, hooks = {}) {
  let raw = String(dir ?? "").trim()
  if (raw === "~" || raw.startsWith("~/")) raw = path.join(homedir(), raw.slice(1))
  if (!raw || !path.isAbsolute(raw)) throw new Error("Use the folder's full path, like /home/me/project or ~/project.")
  let root
  try {
    root = realpathSync(raw)
  } catch {
    throw new Error(`No folder at ${raw}.`)
  }
  if (!statSync(root).isDirectory()) throw new Error(`${raw} is not a folder.`)
  const names = []
  let seen = 0
  const walk = (rel) => {
    for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (++seen > MAX_SCAN) throw new Error(`${raw} has more than ${MAX_SCAN} entries. Pick the project folder itself.`)
      if (e.name.startsWith(".")) continue
      const p = rel ? `${rel}/${e.name}` : e.name
      // A Dirent for a symlink is neither a file nor a folder here: not followed.
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p)
      } else if (e.isFile()) names.push(p)
    }
  }
  walk("")
  const solidity = names.some((n) => n.endsWith(".sol"))
  const keep = names.filter((n) => safeRelPath(n) && classifyPath(n, { solidity }) === "keep")
  if (!keep.length) throw new Error(`No source files found in ${raw}.`)
  if (keep.length > MAX_FILES) throw new Error(`${raw} has ${keep.length} source files. A scope takes up to ${MAX_FILES}.`)
  let bytes = 0
  const files = keep.map((n) => {
    const full = path.join(root, n)
    hooks.beforeOpen?.(n)
    // The walk saw a plain file, but any part of its path may have been swapped
    // for a symlink since. O_NOFOLLOW guards only the last part, so after the
    // open we check where the open file really is, and read only through that
    // same descriptor.
    const fd = openSync(full, fsc.O_RDONLY | fsc.O_NOFOLLOW)
    try {
      const st = fstatSync(fd)
      if (!st.isFile()) throw new Error(`${n} is no longer a file.`)
      if (!openedInside(fd, st, full, root)) throw new Error(`${n} is no longer inside ${raw}.`)
      bytes += st.size
      if (bytes > MAX_BYTES) throw new Error(`${raw} is over 2 MB of source. Pick a smaller folder.`)
      return { path: n, content: readFileSync(fd, "utf8") }
    } finally {
      closeSync(fd)
    }
  })
  const name = path.basename(root).replace(/[^\w.-]+/g, "-").replace(/^[.-]+/, "").slice(0, 64) || "folder"
  return { path: root, name, files }
}

// Members as POST /api/scopes sends them. A folder with a `path` is read from
// disk here, and any files sent with it are ignored, so the stored files always
// match the stored path. A folder with only `files` is the upload fallback.
function readLocalFolders(members) {
  if (!Array.isArray(members)) return members
  return members.map((m) => {
    if (m?.kind !== "folder" || m.path == null) return m
    const read = readFolderInPlace(m.path)
    const name = /^[\w-][\w.-]{0,63}$/.test(String(m.name ?? "")) ? m.name : read.name
    return { kind: "folder", name, path: read.path, files: read.files }
  })
}

// A run reads a local folder fresh from its path, so an edit since the scope
// was added is what the run sees. A folder that is gone fails the run start.
export function withFreshFolders(target) {
  if (target?.kind !== "scope" || !target.members?.some((m) => m.kind === "folder" && m.path)) return target
  return { ...target, members: validateMembers(readLocalFolders(target.members)) }
}

// True when a scopes body names a local folder path: the server would read the
// host's disk, so the HTTP route asks for the console token.
export function namesLocalPath(body) {
  return Array.isArray(body?.members) && body.members.some((m) => m?.kind === "folder" && m.path != null)
}

// Remove an operator scope by id. Returns whether one was removed.
export function deleteScope(id) {
  return { removed: removeScope(id) }
}

// Run registry. Live runs keep their subscribers here. Every event a run
// broadcasts is also appended to `run-<id>.stream.jsonl`, so a server restart
// loses nothing: at load, saved runs come back from disk (loadSavedRuns below).
// Vite can re-evaluate this module inside the same process. Keep live runs,
// their workers and their locks in one process-wide registry so the new copy adopts them.
const registry = (globalThis.__touchstoneRuns ??= { runs: new Map(), retry: null })
const runs = registry.runs
let seq = 0
const TERMINAL = ["recorded", "denied", "error", "no-finding"]

// A SQLite write transaction is a process-owned lock. The OS releases it on a
// crash, unlike a PID file. Keep it until the run is terminal, not just boot.
function own(run) {
  const db = new DatabaseSync(path.join(RESULTS_DIR, `run-${run.id}.owner.sqlite`), { timeout: 0 })
  try {
    db.exec("BEGIN IMMEDIATE")
    run.owner = db
    return true
  } catch (err) {
    db.close()
    if (err.code === "ERR_SQLITE_ERROR" && /locked|busy/i.test(err.message)) return false
    throw err
  }
}

function release(run) {
  if (!run.owner) return
  run.owner.close()
  run.owner = null
}

function savePhase(run, phase) {
  run.phase = phase
  if (!run.stateFile) return
  const next = `${run.stateFile}.tmp`
  writeFileSync(next, JSON.stringify({ ws: run.ws, target: run.target, grantIds: run.grantIds, phase, mode: modeOf(run) ?? run.mode, modules: run.modules, budget: run.budget, provider: run.provider, model: run.model, leads: run.leads ?? {}, prepass: run.prepass ?? null, settled: run.settled ?? null }), { mode: 0o600 })
  renameSync(next, run.stateFile)
}

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
    id = `${alias}-${stamp}-${process.pid}${String(seq).padStart(4, "0")}`
  } while (runs.has(id) || existsSync(path.join(RESULTS_DIR, `run-${id}.owner.sqlite`)) || existsSync(path.join(RESULTS_DIR, `run-${id}.stream.jsonl`)))
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
  if (event.ev === "closed") {
    release(run)
    if (TERMINAL.includes(run.status) && !run.replying) {
      if (run.stateFile) rmSync(run.stateFile, { force: true })
      if (run.db) rmSync(`${run.db}.audit.json`, { force: true })
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
    // "fleet", "solo", or null for a run from before the choice.
    mode: modeOf(run),
    status: run.status,
    archived: Boolean(run.archived),
    // The operator's own name for the run, or null. Set by renameRun.
    name: run.name ?? null,
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
    // Structured failure for the error card: kind, retryable, real detail, spend
    // and a next step. Null unless the run ended in error.
    errorInfo: run.errorInfo ?? null,
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
      name: r.name ?? null,
      scopeTitle: scopeOf(r)?.title ?? null,
      title: r.pending?.title ?? null,
      // The target this run audits — its stable headline, so the sidebar shows a
      // real name from the first second instead of the model alias.
      target: scopeOf(r)?.title ?? null,
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

export async function createRun({ alias, targetId, modules, budgetUsd, pack, mode = "fleet" } = {}) {
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
  if (!RUN_MODES.includes(mode)) throw new Error(`unknown run mode: ${mode}`)
  const target = withFreshFolders(pickTarget({ id: targetId, pack: pack || undefined }))
  // The reach gate (default-deny by kind). Before anything is spent or any
  // workspace is prepared: an offline kind (lab/local-source/brief/scope) with no
  // host passes inert; EVERY other kind — and any kind that names a host — must
  // carry a grant, or openReach throws a clear refusal naming the first uncovered
  // host. For a live run openReach stands up the confinement boundary and
  // returns the env that routes the module's network seam through it, so egress
  // is ENFORCED, not just pre-refused. A grant never widens what a run DOES; it
  // only clears the host the network seam may reach.
  // Checkpoint the setup before opening the gate. A restart during gate or
  // workspace preparation can retry with the same target and module plan.
  // Resolve modules and budget before the setup checkpoint; nothing is spent.
  const plan = planModules(target, modules)
  const budget = budgetUsd == null || budgetUsd === "" ? appRunBudgetUsd(cfg) : validateRunBudget(budgetUsd)
  const grantIds = enforceReach(target).grants.map((g) => g.id)
  mkdirSync(RESULTS_DIR, { recursive: true })
  const id = monotonicId(alias)
  const db = path.join(RESULTS_DIR, `run-${id}.sqlite`)
  const eventsFile = path.join(RESULTS_DIR, `run-${id}.events`)
  const streamFile = path.join(RESULTS_DIR, `run-${id}.stream.jsonl`)
  for (const f of [db, `${db}-wal`, `${db}-shm`, eventsFile, streamFile]) rmSync(f, { force: true })

  const run = {
    reach: null,
    id,
    alias,
    provider: provider.id,
    target,
    grantIds,
    modules: plan,
    mode,
    budget,
    model: provider.models[alias].id,
    status: "starting",
    startedAt: Date.now(),
    events: [],
    subscribers: new Set(),
    db,
    ws: null,
    eventsFile,
    streamFile,
    pending: null,
    submitted: [],
    findingIds: [],
    decision: null,
    error: null,
    child: null,
    stderr: "",
    stateFile: path.join(RESULTS_DIR, `run-${id}.state.json`),
  }
  if (!own(run)) throw new Error("another server already owns this run")
  try {
    savePhase(run, "setup")
  } catch (err) {
    release(run)
    throw err
  }
  runs.set(id, run)

  // The first event names the scope under evaluation. RunView only sees the
  // event stream, not the run object, so without this it cannot show which
  // resource this run is pointed at — the reason every run used to look the
  // same. It lands in run.events, so a late subscriber replays it too.
  broadcast(run, { t: Date.now(), ev: "scope", scope: targetSummary(run.target) })
  broadcast(run, { t: Date.now(), ev: "budget", usd: budget })
  // Fleet or Solo. A follow-up reads it back from this event.
  broadcast(run, { t: Date.now(), ev: "mode", mode })
  // The module plan for this run — which parts of the pipeline are on, and the
  // honest reason for any that are off. Also replayed to late subscribers.
  broadcast(run, modulesEvent(plan))
  // The provider and model, so a follow-up after a restart uses the same pair.
  broadcast(run, { t: Date.now(), ev: "provider", provider: provider.id, model: run.model })

  setRunStatus(run, "starting")
  try {
    run.reach = await openReach(target, { mode: target.kind === "live" ? "confine" : "proxy", grantIds: run.grantIds })
    run.ws = await prepareRunWorkspace(target, { modules: plan })
    savePhase(run, "prepass")
  } catch (err) {
    run.error = String(err?.message ?? err)
    if (run.ws) await endWorkspace(run).catch(() => {})
    else await run.reach?.stop?.().catch(() => {})
    setRunStatus(run, "error")
    finalize(run)
    broadcast(run, { ev: "closed" })
    throw err
  }
  if (run.stopping) {
    await endWorkspace(run)
    endStopped(run)
    return view(run)
  }
  setRunStatus(run, "running")
  // Drive the full engine asynchronously: the pre-pass ensemble first (so the
  // agent starts with leads), then the agent worker. This takes minutes — docker
  // scanners run before any inference — exactly what the CLI does. We do NOT await
  // it: the run is already in the registry, so the HTTP response returns now and
  // the UI watches the scan events, then the agent events, stream in live.
  startEngine(run).catch((err) => {
    run.error = String(err?.message ?? err)
    setRunStatus(run, "error")
    finalize(run)
    broadcast(run, { ev: "closed" })
  })

  return view(run)
}

function setRunStatus(run, status) {
  run.status = status
  const e = { t: Date.now(), ev: "status", status, pending: run.pending, decision: run.decision }
  if (run.error) e.error = run.error
  if (run.errorInfo) e.errorInfo = run.errorInfo
  broadcast(run, e)
}

// Run the pack's pre-pass before starting the agent with its leads.
async function startEngine(run) {
  let leads = {}
  try {
    const prep = await packFor(readTouchstone(run.ws)).prepass?.(run.ws, {
      emit: (ev) => broadcast(run, ev),
      reach: run.reach,
    })
    run.prepass = prep?.record ?? null
    run.static = prep?.record?.static
    run.fuzz = prep?.record?.fuzz
    leads = prep?.env ?? {}
    // One neutral summary of what the tools found, for every pack. The raw
    // static-scan and fuzz-scan events above stay for the finding panels.
    const view = prepassView(run.prepass)
    if (view) broadcast(run, { t: Date.now(), ev: "prepass", ...view })
  } catch (err) {
    // A pre-pass failure must not sink the run: the agent can still audit from
    // source with no leads. Record the reason as diagnostic noise and continue.
    run.stderr += `[prepass] ${String(err?.message ?? err)}\n`
    // The view gets a generic note only: scanner error text can hold a secret.
    broadcast(run, { t: Date.now(), ev: "prepass", ...prepassFailed() })
  }
  // The run may have been torn down while scanning (e.g. process restart); only
  // start the agent if it is still live.
  if (run.status !== "running") return
  if (run.stopping) {
    await endWorkspace(run)
    endStopped(run)
    return
  }
  run.leads = leads
  savePhase(run, "agent")
  spawnAgent(run, leads)
}

// The part of the engine's `settled` event the run view may see: the whole final text.
function slimSettled(e) {
  const text = e.summary?.final?.text
  return { t: e.t ?? Date.now(), ev: "settled", summary: typeof text === "string" ? { final: { text } } : {} }
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
        // The engine's real failure text (the gateway/model error message), so
        // the UI can show what actually went wrong instead of a canned line.
        detail: e.detail ?? null,
        calls: (e.summary?.calls ?? []).length,
        summary: e.summary ?? {},
        findings: e.findings ?? [],
        usage: e.usage ?? null,
        reports: e.reports ?? [],
      }
      savePhase(run, "proof")
      // The view gets only the final text, so it can repair prose that ended one
      // chunk short. The findings and sources stay on the server.
      broadcast(run, slimSettled(e))
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

// Fleet runs split the scope across children; solo runs have one agent. A run
// from before the choice has no mode event, so the engine leaves it to the model.
const RUN_MODES = ["fleet", "solo"]
function modeOf(run) {
  return run.events.findLast((e) => e.ev === "mode")?.mode ?? null
}
function fleetEnv(run) {
  const mode = modeOf(run)
  return mode ? { FLEET: mode === "solo" ? "0" : "1" } : {}
}

// The run's budget and what it has spent so far, from its own events. A
// follow-up carries the spent amount forward, so the budget covers the whole run.
function budgetEnv(run) {
  const set = run.events.findLast((e) => e.ev === "budget")
  // A charge may reach the worker's files before its stdout reaches the server.
  // Use the highest cumulative total from all three copies.
  const charged = run.events.filter((e) => e.ev === "spend")
  if (run.eventsFile && existsSync(run.eventsFile)) charged.push(...readJsonl(run.eventsFile).filter((e) => e.ev === "spend"))
  const chargeFile = path.join(RESULTS_DIR, `run-${run.id}.charges.jsonl`)
  if (existsSync(chargeFile)) charged.push(...readJsonl(chargeFile))
  return { RUN_BUDGET_USD: String(set?.usd ?? appRunBudgetUsd()), RUN_SPENT_USD: String(Math.max(0, ...charged.map((e) => Number(e.usd) || 0))) }
}

// A transient provider fault: the gateway was busy, slow, or briefly down. The
// engine already retried it with backoff; another run usually just works.
const TRANSIENT_ERR = /overload|server[_ ]?busy|rate.?limit|\b(429|500|502|503|504|520|524)\b|timeout|timed out|network|connection|terminated|fetch.?failed|socket hang up|econnreset|etimedout|eai_again|unavailable/i
// A genuine account fault: the request will keep failing until the operator
// fixes billing/quota or the key, so retrying is pointless.
const ACCOUNT_ERR = /quota|billing|insufficient|payment|credit|usage[_ ]?limit|invalid.?api.?key|unauthorized|forbidden|\b401\b|\b403\b/i

// Turn a settled-but-nothing-proved run into an honest, operator-readable
// failure. The engine's `detail` is the real gateway/model error text; we use
// it to tell a transient fault (just retry) from a genuine one (fix config),
// report the spend that ACTUALLY happened (never "nothing was spent" when it
// did), and give one concrete next step. The structured shape drives the UI's
// error card; `message` stays a plain string for older clients and logs.
function failureInfo(run) {
  const s = run.settled
  const spentUsd = Number(run.events.findLast((e) => e.ev === "spend")?.usd ?? 0)
  const detail = String(s?.detail ?? "").trim()
  const reason = s?.reason ?? s?.status ?? "unknown"
  const spentNote =
    spentUsd > 0 ? `About $${spentUsd.toFixed(4)} was spent on the work it did complete.` : "Nothing was spent."

  // The budget guard fired: not an error, a ceiling. run.error is set from the
  // budget-reached event; keep that text but classify it so the UI is calm.
  if (reason === "budget-reached" || /budget/i.test(detail) || /budget/i.test(run.error ?? "")) {
    return {
      kind: "budget", retryable: false, reason, spentUsd, detail: detail || (run.error ?? ""),
      title: "Run stopped at its budget",
      hint: "This run reached the spend cap before it proved a finding. Raise the per-run budget in Settings, or narrow the scope, then start a new run.",
      message: `the run reached its budget cap before proving a finding — ${spentNote}`,
    }
  }

  // The agent was cut short (operator restart, interrupt) rather than the model
  // failing. Nothing is broken; the run can simply be started again.
  if (reason === "aborted" || reason === "interrupted" || reason === "faulted" || reason === "restart_limit") {
    return {
      kind: "cutoff", retryable: true, reason, spentUsd, detail,
      title: "Run was cut off before it finished",
      hint: "The run was stopped mid-way (a restart or interruption), not a model failure. Start it again — your scope and settings are unchanged.",
      message: `the run was cut off before it finished (${reason}) — ${spentNote}`,
    }
  }

  if (reason === "model_error") {
    if (ACCOUNT_ERR.test(detail)) {
      return {
        kind: "account", retryable: false, reason, spentUsd, detail,
        title: "The provider rejected the request",
        hint: "This is an account problem — billing, quota, or the API key — so retrying will not help. Check the provider's balance and key in Settings, or switch to another provider, then start a new run.",
        message: `the provider rejected the request (account/billing) — ${spentNote}`,
      }
    }
    if (TRANSIENT_ERR.test(detail) || !detail) {
      return {
        kind: "transient", retryable: true, reason, spentUsd, detail,
        title: "The model gateway had a temporary hiccup",
        hint: "This was a transient provider fault — the engine already retried it several times with backoff and it still did not clear. It almost always works on the next run. Press Run again; your scope and settings are unchanged.",
        message: `a transient model-gateway error ended the run after automatic retries — ${spentNote}`,
      }
    }
    return {
      kind: "model", retryable: true, reason, spentUsd, detail,
      title: "The model call failed",
      hint: "The model returned an error the run could not recover from. Try again; if it repeats, check the provider and model in Settings. The exact error is shown below.",
      message: `the model call failed — ${spentNote}`,
    }
  }

  return {
    kind: "unknown", retryable: true, reason, spentUsd, detail,
    title: "The run did not complete",
    hint: "The run ended before proving a finding. Try again; if it repeats, check the provider and model in Settings.",
    message: `the run did not complete (${reason}) — ${spentNote}`,
  }
}

// Steps from earlier turns, or from a worker a restart killed, are keyed by
// attempt; a new worker starts past the last one.
function attemptBase(run) {
  const attempts = run.events.filter((e) => e.ev === "thinking-delta" || e.ev === "assistant-delta").map((e) => Number(e.attempt) || 0)
  return String(Math.max(-1, ...attempts) + 1)
}

// Spawn the agent worker over the prepared workspace, with the pre-pass leads in
// its env, and wire its event stream into the run.
function spawnAgent(run, leads) {
  // reach.env confines a live run: it carries the scope proxy's URL and allow-list
  // so the module's network seam routes target-bound traffic through the gate. It
  // is empty for an offline run, so a lab child's env is unchanged.
  const env = { ...process.env, TOUCHSTONE_PARENT_PIPE: "1", PROVIDER: runProvider(run), ALIAS: run.alias, EVENTS_FILE: run.eventsFile, RUN_CHARGE_FILE: path.join(RESULTS_DIR, `run-${run.id}.charges.jsonl`), ATTEMPT_BASE: attemptBase(run), ...budgetEnv(run), ...fleetEnv(run), ...(run.reach?.env ?? {}), ...leads }
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
    if (run.stopping) {
      await endWorkspace(run)
      endStopped(run)
      return
    }
    // Findings come from the settled event, which carries each passing source.
    // If the worker died before settling, fall back to the live list: those
    // findings still record, but without a fresh replay proof.
    const found = s?.findings?.length ? s.findings : run.submitted
    if (found.length) {
      await recordRun(run, found)
      return
    }
    await endWorkspace(run)
    if (s && s.status === "done") {
      // Terminal, but not an error: the agent audited and found nothing to prove.
      run.error = null
      if (s.final) broadcast(run, { ev: "no-finding", final: s.final })
      setRunStatus(run, "no-finding")
    } else if (s) {
      // Settled "unanswered" — the inference did not complete. Report the real
      // reason (classified, with the actual spend and a next step) rather than
      // pretending the agent chose not to find anything, or that nothing ran.
      const info = failureInfo(run)
      run.errorInfo = info
      run.error = info.message
      setRunStatus(run, "error")
    } else {
      // The worker died before it settled anything. The tail of its stderr is
      // the best evidence; present it as an unexpected-crash card.
      const tail = run.stderr.slice(-800).trim()
      run.errorInfo = {
        kind: "crash", retryable: true, reason: "no-settle",
        spentUsd: Number(run.events.findLast((e) => e.ev === "spend")?.usd ?? 0),
        detail: tail,
        title: "The run stopped unexpectedly",
        hint: "The engine exited before it could report a result. Start the run again; if it keeps happening, the error output below is the place to look.",
        message: tail || "the agent exited before proving a finding",
      }
      run.error = run.errorInfo.message
      setRunStatus(run, "error")
    }
    finalize(run)
    broadcast(run, { ev: "closed" })
  })
}

// Broadcast one `finding` event, and one replay-proof document if it passed, per
// recorded finding. `first` is the index of the first one in the run record.
function announceFindings(run, findings, first) {
  findings.forEach((f, k) => {
    const id = run.findingIds[first + k]
    if (!run.events.some((e) => e.ev === "finding" && e.id === id)) {
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
    }
    // A crash can land between finding and artifact; only add the missing part.
    if (!isProven(f)) return
    if (!run.events.some((e) => e.ev === "artifact-open" && e.id === `proof-${id}`)) {
      broadcast(run, { ev: "artifact-open", id: `proof-${id}`, title: `Replay proof — ${f.poc ?? f.title}`, kind: "proof", findingId: id })
    }
    if (!run.events.some((e) => e.ev === "artifact-done" && e.id === `proof-${id}`)) broadcast(run, { ev: "artifact-done", id: `proof-${id}` })
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
    finalize(run)
  } finally {
    await endWorkspace(run)
    broadcast(run, { ev: "closed" })
  }
}

// Delete a run's workspace. First let the pack stop what its pre-pass left
// running there (the web lab's container), or that would outlive the run.
async function endWorkspace(run) {
  const ws = run?.ws ?? run
  try {
    await packFor(readTouchstone(ws)).teardown?.(ws)
  } catch {
    // Best effort: the workspace still goes.
  }
  // Stop the scope proxy the reach gate started for a live run FIRST, so a slow
  // Daytona teardown (deleteMachine can retry for minutes) cannot keep a finished
  // run's gate listening or delay the `closed` broadcast. Inert for an offline run.
  try {
    await run?.reach?.stop?.()
  } catch {
    // already closed
  }
  await cleanupWorkspace(ws)
}

// Message a run. While a worker is running, the message is written to its
// stdin as one JSON line; the worker injects it into the agent's in-flight turn
// (native pi-durable steering) and echoes it back as an `operator-message`
// event once it lands. The echo carries the UI's id for the message, if sent. When the run is idle, the message starts a follow-up
// worker that reopens the saved session. Only an archived run refuses.
export function steerRun(id, text, clientId) {
  const run = runs.get(id)
  if (!run) throw new Error("no such run")
  if (run.archived) throw new Error("this run is archived")
  const msg = typeof text === "string" ? text.trim() : ""
  if (!msg) throw new Error("empty message")
  // The UI's id for the message. The echo carries it back unchanged.
  const tag = typeof clientId === "string" && /^[\w-]{1,64}$/.test(clientId) ? clientId : undefined
  if (idle(run)) return followUp(run, msg, tag)
  if (!run.child?.stdin?.writable) throw new Error(`the run is ${run.status}; try again in a moment`)
  run.child.stdin.write(JSON.stringify({ text: msg, id: tag }) + "\n")
  return { ok: true }
}

// Stop a run's work: the live audit or a follow-up reply. The worker process
// is killed. A stop wins over any findings waiting in the exit handler;
// the run ends as stopped, not failed. The saved agent session
// stays, so a message continues the work. Before the agent starts (the
// pre-pass), the stop lands as soon as the pre-pass returns.
export function stopRun(id) {
  const run = runs.get(id)
  if (!run) throw new Error("no such run")
  if (idle(run)) throw new Error("the run is not working")
  if (!run.owner) throw new Error("another server owns this run; stop it there")
  const child = run.child
  const alive = child && child.exitCode == null && child.signalCode == null
  if (!alive && run.status !== "running" && run.status !== "starting") throw new Error(`the run is ${run.status}; it ends on its own`)
  run.stopping = true
  broadcast(run, { t: Date.now(), ev: "stop-requested" })
  if (alive) child.kill("SIGTERM")
  return { ok: true }
}

// End a run the operator stopped: a `stopped` marker, then a quiet terminal
// status. Nothing was proven, so it reads like a run that found nothing.
function endStopped(run) {
  run.stopping = false
  run.error = null
  run.errorInfo = null
  broadcast(run, { t: Date.now(), ev: "stopped" })
  setRunStatus(run, "no-finding")
  finalize(run)
  broadcast(run, { ev: "closed" })
}

// A run loaded from disk has no file paths on it yet. Set them from its id.
// A run rebuilt from an older record has no stream file, so write its events
// there first: new events must append to the full history, not replace it.
function ensureFiles(run) {
  run.db ??= path.join(RESULTS_DIR, `run-${run.id}.sqlite`)
  run.stateFile ??= path.join(RESULTS_DIR, `run-${run.id}.state.json`)
  run.eventsFile ??= path.join(RESULTS_DIR, `run-${run.id}.events`)
  if (!run.streamFile) {
    run.streamFile = path.join(RESULTS_DIR, `run-${run.id}.stream.jsonl`)
    if (!existsSync(run.streamFile)) writeFileSync(run.streamFile, run.events.map((e) => JSON.stringify(e) + "\n").join(""))
  }
}

// Start a follow-up: one operator message to an idle run. The worker reopens
// the run's saved agent session in a fresh workspace, answers, and exits. Any
// finding it proves is replayed and added to the run record.
function followUp(run, text, clientId) {
  const money = budgetEnv(run)
  if (Number(money.RUN_SPENT_USD) >= Number(money.RUN_BUDGET_USD)) throw new Error("this run has spent its budget")
  ensureFiles(run)
  if (!existsSync(run.db)) throw new Error("This run stopped before its agent session started. Start a new run to chat with an agent.")
  const target = run.target ?? (run.scope?.id ? getTarget(run.scope.id) : null)
  if (!target) throw new Error("this run's scope is no longer in the library")
  run.target = target
  // A generated lab is new on every run, with its own throwaway keys, so a reopened
  // session would meet a different repository than the one it audited.
  if (target.generated) throw new Error("this run's lab was generated for that run only, so it cannot be reopened for a follow-up")
  if (!own(run)) throw new Error("another server is already answering this run; try again when it finishes")
  try {
    run.ws = prepareWorkspace(target, { modules: run.modules ?? [] })
  } catch (err) {
    release(run)
    throw err
  }
  const prior = run.submitted.map(({ n, title, severity, poc }) => ({ n, title, severity, poc }))
  run.settled = null
  run.error = null
  run.errorInfo = null
  run.stopping = false
  run.replying = true
  broadcast(run, { t: Date.now(), ev: "reply-start" })

  const child = spawn(process.execPath, [ENGINE, "child", "chat", run.db, run.ws], {
    cwd: SPIKE,
    env: {
      ...process.env,
      TOUCHSTONE_PARENT_PIPE: "1",
      PROVIDER: runProvider(run),
      ALIAS: run.alias,
      EVENTS_FILE: run.eventsFile,
      RUN_CHARGE_FILE: path.join(RESULTS_DIR, `run-${run.id}.charges.jsonl`),
      ...money,
      ...fleetEnv(run),
      FOLLOWUP: text,
      ...(clientId ? { FOLLOWUP_ID: clientId } : {}),
      PRIOR_FOUND: JSON.stringify(prior),
      ATTEMPT_BASE: attemptBase(run),
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
      else if (run.stopping) broadcast(run, { t: Date.now(), ev: "stopped" })
      else if (!s) broadcast(run, { t: Date.now(), ev: "reply-error", error: run.stderr.slice(-800) || "the follow-up worker exited early" })
      // A failed run that a follow-up retried: if the reply finished, or the
      // operator stopped it, the old failure no longer describes the run.
      if (run.status === "error" && !s?.findings?.length && (run.stopping || s?.status === "done")) {
        run.error = null
        run.errorInfo = null
        setRunStatus(run, "no-finding")
        finalize(run)
      }
    } catch (err) {
      broadcast(run, { t: Date.now(), ev: "reply-error", error: String(err?.message ?? err) })
    } finally {
      await endWorkspace(run)
      run.child = null
      run.stopping = false
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
    // A run that ended with no finding has a record already; it now records one.
    r.outcome = "recorded"
    r.error = null
    r.errorInfo = null
    r.decision = "approved"
    r.recorded = true
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

// Name a run. The name is the operator's label for the sidebar and the top
// bar; it changes nothing the agent sees. It is a `renamed` event in the
// run's stream, so it survives a restart like `archived`. An empty name
// clears it, and the run falls back to its finding or scope title.
export function renameRun(id, name) {
  const run = runs.get(id)
  if (!run) throw new Error("no such run")
  const clean = String(name ?? "").replace(/\s+/g, " ").trim()
  if (clean.length > 120) throw new Error("use a name of up to 120 characters")
  ensureFiles(run)
  run.name = clean || null
  broadcast(run, { t: Date.now(), ev: "renamed", name: run.name })
  return { ok: true, name: run.name }
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
  const recorded = findings.length > 0
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
    // How the run ended: recorded, no-finding or error. An error keeps its
    // reason, so a crashed run reads as a failure, never as a clean scan.
    outcome: recorded ? "recorded" : run.status ?? null,
    error: recorded ? null : (run.error ?? null),
    errorInfo: recorded ? null : (run.errorInfo ?? null),
    stopped: evs.some((e) => e.ev === "stopped"),
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
    // What the agent submitted. With no recorded finding these are claims
    // that were never proven, so the findings ledger does not read them.
    submitted: (run.submitted ?? []).map(({ title, severity, poc }) => ({ title, severity, poc })),
    decision: recorded ? "approved" : null,
    recorded,
    calls: (summary.calls ?? []).map((c) => c.name),
    final: summary.final?.text ?? null,
    usage: s.usage ?? null,
    reports: s.reports ?? [],
  }
  const file = path.join(RESULTS_DIR, `run-${run.id}.json`)
  writeFileSync(`${file}.tmp`, JSON.stringify({ result, transcript: summary }, null, 2))
  renameSync(`${file}.tmp`, file)
}

// Write the record of a run that ends with no finding to record: a clean
// no-finding, an error, a crash or a stop. It keeps what the run did get (the
// pre-pass leads and coverage, with any tool that was unavailable and why), so
// the run is readable afterward. Call it after the terminal status is set. A
// record that already holds findings is kept. A failed write never throws.
function finalize(run) {
  try {
    const file = path.join(RESULTS_DIR, `run-${run.id}.json`)
    if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).result?.findings?.length) return
    persistRun(run, [])
  } catch (err) {
    run.stderr = `${run.stderr ?? ""}[finalize] ${String(err?.message ?? err)}\n`
  }
}

// ---------------------------------------------------------------------------
// Saved runs. At load, every app run on disk comes back into the registry as a
// settled run, so the sidebar lists real history and a restart loses nothing.
//
// A run started by this server has `run-<id>.stream.jsonl`: the exact events
// it broadcast. An older app run has only the engine's `run-<id>.events` plus
// its `run-<id>.json` record; we rebuild the same event shape from those two.
// CLI runs (`run-<alias>.json`, no stamp) are not app runs and are skipped.
const APP_RUN = /^run-([a-z0-9.-]+-\d{10}-\d+)\.(stream\.jsonl|state\.json|json)$/

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
  const view = prepassView(record.prepass ?? prepassFromResult(r))
  if (view) evs.push({ t: t0, ev: "prepass", ...view })
  // Older engines did not stream each PoC as a file. The settled summary still
  // holds every run_poc call in order, so give each attempt its file back.
  const settled = engineEvents.find((e) => e.ev === "settled")
  const sources = (settled?.summary?.calls ?? []).filter((c) => c.name === "run_poc" && c.args?.test_source)
  const hasFile = new Set(engineEvents.filter((e) => e.ev === "artifact-open" && e.kind === "poc").map((e) => `${e.contract}#${e.attempt}`))
  for (const e of engineEvents) {
    if (e.ev === "settled") {
      evs.push(slimSettled(e))
      continue
    }
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
  let status = existsSync(path.join(RESULTS_DIR, `run-${id}.state.json`)) ? "starting" : "error"
  let decision = null
  let error = null
  let findingIds = []
  let scope = null
  let modules = null
  let provider = null
  let model = null
  let archived = false
  let name = null
  const submitted = []
  for (const e of events) {
    if (e.ev === "archived") archived = Boolean(e.archived)
    if (e.ev === "renamed") name = typeof e.name === "string" && e.name ? e.name : null
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
  const interrupted = !TERMINAL.includes(status)
  const stopPending = events.findLastIndex((e) => e.ev === "stop-requested") > events.findLastIndex((e) => e.ev === "stopped")
  const stateFile = path.join(RESULTS_DIR, `run-${id}.state.json`)
  // A torn state file must not hide the run: it ends as an error instead.
  let saved = null
  if (existsSync(stateFile)) {
    try {
      saved = JSON.parse(readFileSync(stateFile, "utf8"))
    } catch (err) {
      console.error(`[runs] saved recovery state for ${id} is unreadable: ${String(err?.message ?? err).slice(0, 200)}`)
      saved = false
    }
  }
  if (interrupted && (!saved || ((events.findLast((e) => e.ev === "mode")?.mode ?? saved.mode) !== "solo" && !stopPending))) {
    status = "error"
    error = saved === false
      ? "saved recovery state is unreadable; start a new run"
      : events.findLast((e) => e.ev === "mode")?.mode === "fleet"
        ? "this fleet run stopped at the server restart; its coordinator cannot safely resume yet"
        : "the server restarted during this run, so it stopped"
    events.push({ t: Date.now(), ev: "status", status, error })
  }
  // Same for a follow-up the restart cut off: it started after the last close.
  const lastClose = events.findLastIndex((e) => e.ev === "closed")
  if (events.findLastIndex((e) => e.ev === "reply-start") > lastClose) {
    events.push({ t: Date.now(), ev: "reply-error", error: "the server restarted during this reply, so it stopped" })
    events.push({ t: Date.now(), ev: "closed" })
  }
  if (TERMINAL.includes(status) && !events.some((e) => e.ev === "closed") && !existsSync(path.join(RESULTS_DIR, `run-${id}.state.json`))) events.push({ t: Date.now(), ev: "closed" })
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
    name,
    startedAt: events.find((e) => e.t)?.t ?? mtime,
    events,
    subscribers: new Set(),
    pending: sortFindings(submitted)[0] ?? null,
    submitted,
    findingIds,
    decision,
    error,
    interrupted,
    saved,
    child: null,
    stderr: "",
  }
}

// A phase that crashes the server would otherwise restart on every boot.
const MAX_RESTARTS = 3
function checkRestarts(run) {
  const restarts = run.events.filter((e) => e.ev === "phase-restarted").length
  if (restarts >= MAX_RESTARTS) throw new Error(`recovery gave up after ${restarts} restarts; start a new run`)
}

async function resumeRun(run) {
  const state = run.saved
  if (!state.target || (state.phase !== "setup" && !state.ws)) throw new Error("the saved workspace or target is missing; start a new run")
  run.ws = state.ws
  run.target = state.target // Never replace this snapshot with a newer, wider scope.
  run.grantIds = state.grantIds ?? [] // Missing live grant snapshots fail closed.
  run.leads = state.leads ?? {}
  run.prepass = state.prepass ?? null
  run.static = run.prepass?.static ?? null
  run.fuzz = run.prepass?.fuzz ?? null
  run.settled = state.settled ?? null
  if (state.phase === "setup") {
    checkRestarts(run)
    run.modules = state.modules ?? run.modules
    run.provider = state.provider ?? run.provider
    run.model = state.model ?? run.model
    const initial = [
      { ev: "scope", scope: targetSummary(run.target) },
      { ev: "budget", usd: state.budget },
      { ev: "mode", mode: state.mode },
      modulesEvent(run.modules ?? []),
      { ev: "provider", provider: run.provider, model: run.model },
      { ev: "status", status: "starting" },
    ]
    for (const event of initial) if (!run.events.some((e) => e.ev === event.ev)) broadcast(run, { t: Date.now(), ...event })
    run.reach = await openReach(run.target, { mode: run.target.kind === "live" ? "confine" : "proxy", grantIds: run.grantIds })
    broadcast(run, { t: Date.now(), ev: "phase-restarted", phase: "setup" })
    run.ws = await prepareRunWorkspace(run.target, { modules: run.modules ?? [] })
    savePhase(run, "prepass")
    if (run.stopping) {
      await endWorkspace(run)
      return endStopped(run)
    }
    setRunStatus(run, "running")
    return startEngine(run)
  }
  const recordFile = path.join(RESULTS_DIR, `run-${run.id}.json`)
  if (state.phase === "proof" && existsSync(recordFile)) {
    // The record is the commit point. A crash after its write must not replay
    // proof or overwrite it, even if the workspace has already been removed.
    const result = JSON.parse(readFileSync(recordFile, "utf8")).result
    if (result?.outcome === "recorded" && result.findings?.length) {
      run.findingIds = result.findings.map((_, k) => `${run.id}.${k + 1}`)
      announceFindings(run, result.findings, 0)
      run.status = "recorded"
      run.decision = "approve"
      broadcast(run, { ev: "status", status: "recorded", decision: "approve", findingId: run.findingIds[0], findingIds: run.findingIds })
      await endWorkspace(run)
      broadcast(run, { ev: "closed" })
      return
    }
  }
  checkRestarts(run)
  if (!existsSync(path.join(run.ws, ".touchstone.json"))) throw new Error("the saved workspace is missing; start a new run")
  run.reach = await openReach(run.target, { mode: run.target.kind === "live" ? "confine" : "proxy", grantIds: run.grantIds })
  // This event is a real retry marker. The old stream is never renumbered.
  broadcast(run, { t: Date.now(), ev: "phase-restarted", phase: state.phase })
  if (state.phase === "prepass") {
    await packFor(readTouchstone(run.ws)).teardown?.(run.ws)
    return startEngine(run)
  }
  if (state.phase === "agent") return spawnAgent(run, run.leads)
  if (state.phase === "proof" && run.settled) {
    const found = run.settled.findings?.length ? run.settled.findings : run.submitted
    if (found.length) return recordRun(run, found)
    if (run.settled.status === "done" && run.settled.final) broadcast(run, { ev: "no-finding", final: run.settled.final })
    setRunStatus(run, run.settled.status === "done" ? "no-finding" : "error")
    finalize(run)
    await endWorkspace(run)
    broadcast(run, { ev: "closed" })
    return
  }
  throw new Error(`unknown saved phase: ${state.phase}`)
}

function loadSavedRuns() {
  if (!existsSync(RESULTS_DIR)) return
  const ids = new Set()
  for (const f of readdirSync(RESULTS_DIR)) {
    const m = APP_RUN.exec(f)
    if (m && !runs.has(m[1])) ids.add(m[1])
  }
  for (const id of ids) loadSavedRun(id)
}

// Another process owned these runs at load. Follow their saved streams, and
// take a run over once its owner exits.
function adoptOrphans() {
  for (const [id, old] of runs) {
    if (old.owner || !old.interrupted || TERMINAL.includes(old.status)) continue
    runs.delete(id)
    loadSavedRun(id)
    const run = runs.get(id)
    if (!run) {
      runs.set(id, old)
      continue
    }
    for (const send of old.subscribers) {
      for (const e of run.events.slice(old.events.length)) send(e)
      if (!idle(run)) run.subscribers.add(send)
    }
  }
}

function loadSavedRun(id) {
  try {
    const streamFile = path.join(RESULTS_DIR, `run-${id}.stream.jsonl`)
    const recordFile = path.join(RESULTS_DIR, `run-${id}.json`)
    let events
    let mtime
    if (existsSync(streamFile)) {
      events = readJsonl(streamFile)
      mtime = statSync(streamFile).mtimeMs
    } else if (existsSync(recordFile)) {
      const engineFile = path.join(RESULTS_DIR, `run-${id}.events`)
      const engine = existsSync(engineFile) ? readJsonl(engineFile) : []
      events = rebuildEvents(id, JSON.parse(readFileSync(recordFile, "utf8")), engine)
      mtime = statSync(recordFile).mtimeMs
    } else if (existsSync(path.join(RESULTS_DIR, `run-${id}.state.json`))) {
      events = []
      mtime = statSync(path.join(RESULTS_DIR, `run-${id}.state.json`)).mtimeMs
    } else return
    if (!events.length && !existsSync(path.join(RESULTS_DIR, `run-${id}.state.json`))) return
    const run = savedRun(id, events, mtime)
    // Never hide an interrupted-error run: list it so a later boot can finish
    // it. Acquire its lock here (as the non-error paths below already rely on)
    // so the TERMINAL branch does not try to own it a second time. A run a live
    // owner still holds gets listed but left for that owner.
    const ownedError = run.interrupted && run.status === "error" && own(run)
    runs.set(id, run)
    if (TERMINAL.includes(run.status) && !run.events.some((e) => e.ev === "closed") && existsSync(path.join(RESULTS_DIR, `run-${id}.state.json`))) {
      ensureFiles(run)
      if (own(run)) {
        try {
          run.ws = run.saved?.ws ?? null
          endWorkspace(run).catch(() => {}).finally(() => broadcast(run, { ev: "closed" }))
        } catch (err) {
          release(run)
          throw err
        }
      }
    }
    // The server stopped during this run, so no record was written. Write
    // one now from the stream: the run is an error, with its reason.
    if (run.interrupted && run.status === "error") {
      if (!ownedError) return // a live owner still holds it; leave the cleanup to that owner
      if (!existsSync(recordFile)) finalize(run)
      if (run.saved === false) {
        ensureFiles(run)
        broadcast(run, { ev: "closed" }) // releases the lock and removes the torn state file
      } else if (run.saved) {
        // A valid checkpoint we will not resume (a fleet, or unknown-mode, run).
        // Drop the stale state file so a later boot does not keep seeing it
        // interrupted; it shows as ended at the restart. Fleet resume itself is
        // unsupported — the coordinator's state lives in memory.
        ensureFiles(run)
        run.ws = run.saved.ws ?? null
        endWorkspace(run).catch(() => {}).finally(() => broadcast(run, { ev: "closed" }))
      } else release(run)
    }
    if (run.interrupted && run.status !== "error") {
      ensureFiles(run)
      if (own(run)) {
        const stopped = run.events.findLastIndex((e) => e.ev === "stop-requested") > run.events.findLastIndex((e) => e.ev === "stopped")
        if (stopped) {
          run.ws = run.saved.ws
          endWorkspace(run).catch(() => {}).finally(() => endStopped(run))
        } else resumeRun(run).catch(async (err) => {
          run.error = `Recovery could not continue: ${String(err?.message ?? err)}`
          await endWorkspace(run).catch(() => {})
          setRunStatus(run, "error")
          finalize(run)
          broadcast(run, { ev: "closed" })
        })
      }
    }
  } catch (err) {
    console.warn(`[runs] skipped saved run ${id}: ${String(err?.message ?? err).slice(0, 200)}`)
  }
}

loadSavedRuns()
clearInterval(registry.retry)
registry.retry = setInterval(adoptOrphans, Number(process.env.TOUCHSTONE_OWNER_RETRY_MS) || 5000)
registry.retry.unref()
