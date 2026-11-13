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
import { mkdirSync, writeFileSync, appendFileSync, rmSync, readFileSync, readdirSync, renameSync, statSync, lstatSync, existsSync, realpathSync, readlinkSync, openSync, closeSync, fstatSync, constants as fsc } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { cleanupWorkspace, readTouchstone } from "../../spike/lib/sandbox.mjs"
import { closeRun } from "../../spike/lib/daytona.mjs"
import { activeProvider, allProviders, defaultAlias, readConfig } from "../../spike/lib/providers.mjs"
import { appRunBudgetUsd, appSpendCapUsd, spendCapRefusal, totalSpendState } from "./settings.mjs"
import { validateRunBudget } from "../../spike/lib/run-budget.mjs"
import { briefChange, briefOf, dropOldBriefFile, eligiblePacks, getTarget, listTargets, pickTarget, prepareMultiWorkspace, prepareRunWorkspace, scopeEnv, targetSummary, withPack } from "../../spike/lib/targets.mjs"
import { enforceReach, openReach } from "../../spike/lib/reach.mjs"
import { liveHostsRefusal } from "../../spike/lib/live-hosts.mjs"
import { readScopes, loadScopes, addBriefScope, addSourceScope, addRepoScope, addLiveScope, addScope as addMembersScope, removeScope, validateMembers, classifyPath, safeRelPath, SKIP_DIRS, MAX_FILES, MAX_BYTES } from "../../spike/lib/scopes-store.mjs"
import { planModules, modulesEvent, moduleOn } from "../../spike/lib/modules.mjs"
import { packFor, packList, PACKS } from "../../spike/packs/index.mjs"
import { sortFindings } from "../../spike/lib/record.mjs"
import { sourceCoverage, coverageFailure } from "../../spike/lib/source-coverage.mjs"
import { leadsFrom } from "../../spike/lib/leads.mjs"
import { isProven, proofKind, withProven } from "../../spike/lib/proof-view.mjs"
import { prepassFailed, prepassFromResult } from "../../spike/lib/prepass-view.mjs"
import { MULTI_DIR, prepassViewOf, shareFetched } from "../../spike/packs/multi.mjs"
import { restoreSource } from "../../spike/lib/fetch.mjs"
import { pruneReplayStore, recordReplayReruns } from "../../spike/lib/replay-bundle.mjs"

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
  return { ...totalSpendState(), budgetUsd: appRunBudgetUsd() }
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

// The target library the UI picks a scope from. The only filesystem path in it
// is one the operator typed: a folder scope the server reads in place.
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
    // `pack` is one module or the list the operator ticked.
    for (const id of pack == null || pack === "" ? [] : [pack].flat()) {
      if (typeof id !== "string" || !Object.hasOwn(PACKS, id)) throw new Error(`unknown module: ${id}`)
    }
    // A star in any spelling other than "*.example.com" would be dropped from
    // the grant without a word. Refuse it here, before anything is saved.
    const refusal = liveHostsRefusal(hosts, { pack })
    if (refusal) throw new Error(refusal)
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
  writeFileSync(next, JSON.stringify({ ws: run.ws, target: run.target, ...(run.packs ? { packs: run.packs } : {}), grantIds: run.grantIds, phase, mode: modeOf(run) ?? run.mode, modules: run.modules, budget: run.budget, provider: run.provider, model: run.model, leads: run.leads ?? {}, prepass: run.prepass ?? null, settled: run.settled ?? null }), { mode: 0o600 })
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
    if (registry.pruneOwed) pruneReplays(run)
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
    // Every module this ONE run covers. One entry for a one-module run, so a
    // reader never has to branch.
    packs: run.packs?.length ? run.packs : [scopeOf(run)?.pack ?? "contracts"],
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
      // How an error run ended (`errorInfo.kind`), so the list can tell a
      // restart's cut-off ("cutoff") from a failure.
      errorKind: r.errorInfo?.kind ?? null,
      // The target this run audits — its stable headline, so the sidebar shows a
      // real name from the first second instead of the model alias.
      target: scopeOf(r)?.title ?? null,
      // The modules the run covers, so a list row can name them all.
      packs: r.packs?.length ? r.packs : [scopeOf(r)?.pack ?? "contracts"],
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

export async function createRun({ alias, targetId, modules, budgetUsd, pack, packs, mode = "fleet" } = {}) {
  const cfg = readConfig()
  // The total spend cap comes first: at or above it, or with a ledger that
  // cannot be read, nothing is prepared and nothing is spent.
  const capRefusal = spendCapRefusal(cfg)
  if (capRefusal) throw new Error(capRefusal)
  const provider = activeProvider(cfg)
  alias ??= defaultAlias(provider, cfg)
  if (!provider.models[alias]) throw new Error(`unknown model alias for ${provider.label}: ${alias}`)
  // The modules the run covers. `packs` is the operator's ticked list from the
  // New run dialog; two or more distinct ids make ONE run over all of them. A
  // list that dedupes to one, or no list, is today's one-module run: `pack`.
  const picked = [...new Set((Array.isArray(packs) ? packs : []).map(String).filter(Boolean))]
  const multi = picked.length > 1
  const one = multi ? null : picked[0] ?? pack
  // Pick the scope from the target library: an explicit choice, or random across
  // the labs so repeated Runs stop re-breaking one prepared bug. Throws on an
  // unknown id before anything is spent.
  // The module (pack) comes from the request. With no pack, a chosen scope
  // decides it, and nothing chosen means Contracts. An unknown pack, or a scope
  // that belongs to another pack, is refused before anything is spent.
  if (one != null && one !== "" && !PACKS[one]) throw new Error(`unknown module: ${one}`)
  const unknown = picked.filter((id) => !PACKS[id])
  if (unknown.length) throw new Error(`unknown module: ${unknown.join(", ")}`)
  if (!RUN_MODES.includes(mode)) throw new Error(`unknown run mode: ${mode}`)
  // The run's own target: under the first module, so every old reader that only
  // knows `target.pack` still names a module the run really has.
  // A joined run keeps its own target under the first module for every old
  // reader, but `withPack` drops the credential of an AI/MCP scope for any other
  // module. The run's target keeps it, so the scrub, the restore and the build
  // all see the token whatever the module order.
  const target = withFreshFolders(pickTarget({ id: targetId, pack: multi ? picked[0] : one || undefined }))
  // Every module must be one the scope allows. `pickTarget` checks only the
  // first, and the engine checks again at the build; this refuses before the run
  // row exists and before the reach is opened.
  if (multi) {
    const allowed = eligiblePacks(target)
    const denied = picked.filter((id) => !allowed.includes(id))
    if (denied.length) throw new Error(`target ${target.id} belongs to pack "${allowed.join('", "')}", not "${denied.join('", "')}"`)
  }
  // A joined run keeps the credential of an AI/MCP scope, but only when it has
  // that module: otherwise the token would sit in the state file for nothing.
  if (multi && picked.includes("ai-mcp") && !target.mcp) {
    const held = getTarget(target.id)?.mcp
    if (held) target.mcp = held
  }
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
  // The pack shapes the plan (a non-contracts pack with no replay oracle drops
  // the proof step), so pass it through like the rest of main's callers. A
  // joined run passes the whole list and a manifest that says so: replay is off
  // only when no module of the run can prove.
  const manifest = multi ? { proof: picked.every((id) => PACKS[id].proof === "none") ? "none" : "multi" } : target.pack ? PACKS[target.pack] : undefined
  const plan = planModules(target, modules, manifest, multi ? picked : undefined)
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
    // Every module the run covers. One entry for a one-module run, and absent on
    // a record saved before modules existed.
    ...(multi ? { packs: picked } : {}),
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
  // The operator's scope brief this run hands the agent. Run Info shows it.
  if (briefOf(target)) broadcast(run, { t: Date.now(), ev: "brief", text: briefOf(target) })
  broadcast(run, { t: Date.now(), ev: "budget", usd: budget })
  // Fleet or Solo. A follow-up reads it back from this event.
  broadcast(run, { t: Date.now(), ev: "mode", mode })
  // The modules this ONE run covers. A follow-up, a restart and the view read
  // them back from this event, so a joined workspace is rebuilt joined.
  if (multi) broadcast(run, { t: Date.now(), ev: "packs", packs: picked })
  // The module plan for this run — which parts of the pipeline are on, and the
  // honest reason for any that are off. Also replayed to late subscribers.
  broadcast(run, modulesEvent(plan))
  // The provider and model, so a follow-up after a restart uses the same pair.
  broadcast(run, { t: Date.now(), ev: "provider", provider: provider.id, model: run.model })

  setRunStatus(run, "starting")
  try {
    run.reach = await openReach(target, { mode: target.kind === "live" ? "confine" : "proxy", grantIds: run.grantIds })
    run.ws = multi ? await prepareMultiWorkspace(target, { packs: picked, modules: plan }) : await prepareRunWorkspace(target, { modules: plan })
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
    const view = prepassViewOf(run.prepass)
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
      // The exit path may have read this same event from the engine's file.
      if (run.settled && run.settled.t === e.t) return
      run.settled = {
        t: e.t ?? null,
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
      // The module the finding came through, so a proof or a rebuild can place
      // it. The tool stamps it; an older engine leaves it absent.
      run.submitted.push({ n: e.n, title: e.title, severity: e.severity, poc: e.poc, ...(e.pack ? { pack: e.pack } : {}) })
      run.pending = sortFindings(run.submitted)[0]
      broadcast(run, { ev: "status", status: run.status, pending: run.pending })
    }
  }
}

// The engine writes each event to its own file before it writes it to stdout.
// A `settled` that did not arrive on stdout (the pipe was cut at the worker's
// exit) is still in that file. Read it, so a finished turn is never shown as a
// crash. `since` is when this worker started: an older turn's settle is not its.
function recoverSettled(run, since) {
  if (run.settled || !run.eventsFile || !existsSync(run.eventsFile)) return
  const e = readJsonl(run.eventsFile).findLast((x) => x.ev === "settled" && !x.agent && x.t >= since)
  if (e) engineEvents(run)(e)
}

// How a worker process ended, in plain words, for the card or the reply error.
function exitWords(code, signal) {
  if (signal) return `it was killed by the signal ${signal}`
  if (code) return `it exited with the code ${code}`
  return "it exited without an error code"
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
// Every worker also gets the total spend cap, so its guard stops at the cap.
export function budgetEnv(run) {
  const set = run.events.findLast((e) => e.ev === "budget")
  // A charge may reach the worker's files before its stdout reaches the server.
  // Use the highest cumulative total from all three copies.
  const charged = run.events.filter((e) => e.ev === "spend")
  if (run.eventsFile && existsSync(run.eventsFile)) charged.push(...readJsonl(run.eventsFile).filter((e) => e.ev === "spend"))
  const chargeFile = path.join(RESULTS_DIR, `run-${run.id}.charges.jsonl`)
  if (existsSync(chargeFile)) charged.push(...readJsonl(chargeFile))
  return { RUN_BUDGET_USD: String(set?.usd ?? appRunBudgetUsd()), RUN_SPENT_USD: String(Math.max(0, ...charged.map((e) => Number(e.usd) || 0))), SPEND_CAP_USD: String(appSpendCapUsd()) }
}

// A transient provider fault: the gateway was busy, slow, or briefly down. The
// engine already retried it with backoff; another run usually just works.
const TRANSIENT_ERR = /overload|server[_ ]?busy|rate.?limit|\b(429|500|502|503|504|520|524)\b|timeout|timed out|network|connection|terminated|fetch.?failed|socket hang up|econnreset|etimedout|eai_again|unavailable/i
// A genuine account fault: the request will keep failing until the operator
// fixes billing/quota or the key, so retrying is pointless.
const ACCOUNT_ERR = /quota|billing|insufficient|payment|credit|usage[_ ]?limit|invalid.?api.?key|unauthorized|forbidden|\b401\b|\b403\b/i

// Did this run read every GitHub member of its scope? A refused or skipped
// fetch is a gap, never a clean result: if there is one, set the run's error
// (kind "coverage") and return true, so the caller ends it as an error instead
// of no-finding. See spike/lib/source-coverage.mjs. Exported so every end path
// that could end a run no-finding (for example a restart) can gate on it.
function runCoverage(run) {
  return sourceCoverage(run.target?.links ?? scopeOf(run)?.links ?? [], run.events)
}
export function coverageGap(run) {
  const spentUsd = Number(run.events.findLast((e) => e.ev === "spend")?.usd ?? 0)
  const info = coverageFailure(runCoverage(run), { spentUsd })
  if (!info) return false
  run.errorInfo = info
  run.error = info.message
  return true
}
// A run that recorded a finding keeps it, but if part of its scope was not read
// the operator must know: broadcast a coverage note (a warning, not an error).
// `always` also sends a cleared note (info null), for a follow-up that may have
// read the rest.
function noteCoverage(run, { always = false } = {}) {
  const cov = runCoverage(run)
  const spentUsd = Number(run.events.findLast((e) => e.ev === "spend")?.usd ?? 0)
  const info = coverageFailure(cov, { spentUsd, found: true })
  if (info || (always && cov)) broadcast(run, { t: Date.now(), ev: "coverage", info })
}

// Turn a settled-but-nothing-proved run into an honest, operator-readable
// failure. The engine's `detail` is the real gateway/model error text; we use
// it to tell a transient fault (just retry) from a genuine one (fix config),
// report the spend that ACTUALLY happened (never "nothing was spent" when it
// did), and give one concrete next step. The structured shape drives the UI's
// error card; `message` stays a plain string for older clients and logs.
export function failureInfo(run) {
  const s = run.settled
  const spentUsd = Number(run.events.findLast((e) => e.ev === "spend")?.usd ?? 0)
  const detail = String(s?.detail ?? "").trim()
  const reason = s?.reason ?? s?.status ?? "unknown"
  const spentNote =
    spentUsd > 0 ? `About $${spentUsd.toFixed(4)} was spent on the work it did complete.` : "Nothing was spent."

  // The total spend cap (the shared ledger) stopped the run, or the ledger or
  // cap could not be read. A ceiling, not a model fault: another run would stop
  // the same way, so it is not retryable.
  // The ledger lock was held too long, so a paid call's cost was not recorded.
  // Not a cap stop; its own sentence (LEDGER_LOCKED in spike/lib/inference.mjs).
  if (/The spend ledger stayed locked/.test(`${detail} ${run.error ?? ""}`)) {
    return {
      kind: "budget", retryable: false, reason, spentUsd, detail: detail || (run.error ?? ""),
      title: "Run stopped: the spend ledger stayed locked",
      hint: "Another process held the spend ledger's lock too long, so the cost of a paid call could not be recorded. Make sure no run is active, delete the spend.json.lock and spend.json.lock.break files next to the ledger, then start a new run.",
      message: `the run stopped because its spend could not be recorded in the ledger — ${spentNote}`,
    }
  }
  // Only our own cap messages carry this exact sentence (spike/lib/inference.mjs).
  if (/This call is out of budget\./.test(`${detail} ${run.error ?? ""}`)) {
    return {
      kind: "budget", retryable: false, reason, spentUsd, detail: detail || (run.error ?? ""),
      title: "Run stopped at the total spend cap",
      hint: "All runs together reached the total spend cap, or the spend ledger could not be read. Settings shows the ledger and the cap. Raise the cap or fix the ledger before starting a new run.",
      message: `the run stopped at the total spend cap before proving a finding — ${spentNote}`,
    }
  }

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
  const env = { ...process.env, TOUCHSTONE_PARENT_PIPE: "1", PROVIDER: runProvider(run), ALIAS: run.alias, EVENTS_FILE: run.eventsFile, RUN_CHARGE_FILE: path.join(RESULTS_DIR, `run-${run.id}.charges.jsonl`), ATTEMPT_BASE: attemptBase(run), ...budgetEnv(run), ...fleetEnv(run), ...scopeEnv(run.target, run.packs), ...(run.reach?.env ?? {}), ...leads }
  // stdin is a pipe (not "ignore") so the operator can steer the live run: we
  // write one JSON line per message to the worker, which injects it into the
  // agent's current turn. Swallow EPIPE if we race a worker that just exited.
  const since = Date.now()
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
  child.on("exit", async (code, signal) => {
    if (run.status !== "running" && run.status !== "starting") return
    if (!run.stopping) recoverSettled(run, since)
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
    if (run.stopping) {
      endStopped(run)
      return
    }
    if (s && s.status === "done" && coverageGap(run)) {
      // The agent finished, but part of the scope was never read. Keep its
      // final answer; the status says the result is not clean.
      if (s.final) broadcast(run, { ev: "no-finding", final: s.final })
      setRunStatus(run, "error")
    } else if (s && s.status === "done") {
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
      // The worker died before it settled anything, on stdout or in its own
      // file. Say how the process ended; the tail of its stderr is the evidence.
      const how = `The engine process ended before it reported a result: ${exitWords(code, signal)}.`
      const tail = run.stderr.slice(-800).trim()
      run.errorInfo = {
        kind: "crash", retryable: true, reason: "no-settle",
        spentUsd: Number(run.events.findLast((e) => e.ev === "spend")?.usd ?? 0),
        detail: tail ? `${how}\n\n${tail}` : how,
        title: "The run stopped unexpectedly",
        hint: "Press Run again to continue in this chat. The run keeps its history and its files. If it keeps happening, the error output below is the place to look.",
        message: tail || how,
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
        // The module this finding came through. The Findings page shows its pill
        // and, since one run can hold several modules, it must be the tool's.
        ...(f.pack ? { pack: f.pack } : {}),
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
    noteCoverage(run)
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

// ---- Kept workspaces. A run's workspace outlives the run, so a follow-up
// finds the files the agent wrote and the sources it fetched. One small record
// names the workspace and holds the run's own scope snapshot. It survives a
// restart, and it moves to the trash with the run's other files.
const workspaceFile = (id) => path.join(RESULTS_DIR, `run-${id}.workspace.json`)
// undefined: the run has no record. null: the record file is there but cannot
// be read (torn, closed to this user, or not a record). The two are not the
// same. A record that cannot be read may name a workspace, so no reader may
// take it as "not there".
function readWorkspace(id) {
  try {
    if (!lstatSync(workspaceFile(id), { throwIfNoEntry: false })) return undefined
    const rec = JSON.parse(readFileSync(workspaceFile(id), "utf8"))
    return rec && typeof rec === "object" && !Array.isArray(rec) ? rec : null
  } catch {
    return null
  }
}

function writeWorkspace(id, rec) {
  const file = workspaceFile(id)
  writeFileSync(`${file}.tmp`, JSON.stringify(rec), { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
}

// The names a run workspace can have (spike/lib/sandbox.mjs, the generated lab).
const WS_NAME = /^(redteam-run|touchstone-supply)-[A-Za-z0-9]{6}$/
// The server writes the run id into this file when it keeps a workspace. A
// record alone does not bind a directory to a run: the directory names the run too.
// A second line names the results folder of the server that wrote the mark (a
// hash, so the agent does not learn the path). The temp folder is shared with
// other servers and with tests, and the boot sweep must know its own folders.
const WS_MARK = ".touchstone-run"
function resultsHome() {
  let dir = path.resolve(RESULTS_DIR)
  try {
    dir = realpathSync(dir)
  } catch {
    // not made yet
  }
  return createHash("sha256").update(dir).digest("hex").slice(0, 32)
}
const markText = (id) => `${id}\n${resultsHome()}`
// The mark of a folder: { id, home }, or null when it has no real mark file.
// `home` is undefined for a mark from before the second line.
function readMark(dir) {
  try {
    const file = path.join(dir, WS_MARK)
    if (!lstatSync(file).isFile()) return null // a link is not a mark
    const [id, home] = readFileSync(file, "utf8").split("\n")
    return id ? { id, home } : null
  } catch {
    return null
  }
}
// Where a joined run keeps one sub-workspace per module (spike/packs/multi.mjs).
const MODULES_DIR = MULTI_DIR

// The one check before the server keeps, reuses or deletes a workspace. The path
// can come from a record file, so it proves nothing by itself. The directory
// must be a real directory of this user, directly inside the temp folder, with a
// workspace name. With an id it must also carry that run's mark. Returns the
// canonical path, or null.
function checkedWorkspace(ws, id) {
  try {
    if (typeof ws !== "string" || !ws) return null
    const st = lstatSync(ws) // lstat: a symlink is refused, not followed
    if (!st.isDirectory() || st.uid !== (process.getuid?.() ?? st.uid)) return null
    const real = realpathSync(ws)
    if (path.dirname(real) !== realpathSync(tmpdir()) || !WS_NAME.test(path.basename(real))) return null
    if (id === undefined) return real
    return readMark(real)?.id === id ? real : null
  } catch {
    return null
  }
}

// Delete the kept workspace of a run. A path that fails the check is left alone.
const removeKept = (id) => removeChecked(readWorkspace(id)?.ws, id)

// The checked delete: only a folder that passes the check and carries the mark of `id`.
function removeChecked(dir, id) {
  const ws = checkedWorkspace(dir, id)
  if (!ws) return
  try {
    rmSync(ws, { recursive: true, force: true })
  } catch (err) {
    // A part stayed. Put the mark back, so a later delete still passes the check.
    try {
      writeFileSync(path.join(ws, WS_MARK), markText(id), { flag: "wx", mode: 0o600 }) // wx: a link here is not followed
    } catch {
      // the mark is still there, or the folder itself is gone or closed
    }
    throw err
  }
}

// Take the path out of a run's record. The scope snapshot stays, so a follow-up
// still builds a new workspace from the run's own scope.
function unbindWorkspace(id) {
  const rec = readWorkspace(id)
  if (!rec?.ws) return
  delete rec.ws
  delete rec.restored
  try {
    writeWorkspace(id, rec)
  } catch {
    rmSync(workspaceFile(id), { force: true })
  }
}

// ---- The credential of a live AI/MCP scope. The scope library holds it
// (spike/data/scopes.json, fields mcp.token and mcp.tokens). A run's workspace
// gets a copy in .touchstone.json (the agent gets it in its instructions, see
// targets.mjs scopeEnv), and the agent may write it into files. A kept workspace must not hold
// one, so the copies leave when the run ends and come back for a follow-up.
const secretsOf = (target) => [...new Set([target?.mcp?.token, ...Object.keys(target?.mcp?.tokens ?? {})])].filter((s) => typeof s === "string" && s)
function withoutSecrets(target) {
  if (!target?.mcp) return target
  const mcp = { ...target.mcp }
  delete mcp.token
  delete mcp.tokens
  return { ...target, mcp }
}
const placeholder = (i) => `[touchstone: credential ${i + 1} removed when the run ended]`
const bytes = (s) => Buffer.from(s, "utf8").toString("latin1") // files are read as bytes

// Swap exact texts in every file of a workspace. Links are not followed.
// shortcut: only an exact copy is found, not an encoded or split one, and a file
// is read whole. Scan the encoded forms too if agents start to store them.
function swapInFiles(dir, pairs) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, e.name)
    if (e.isDirectory()) swapInFiles(file, pairs)
    else if (e.isFile()) {
      const before = readFileSync(file, "latin1")
      const text = pairs.reduce((t, [from, to]) => t.split(from).join(to), before)
      if (text !== before) writeFileSync(file, text, "latin1")
    }
  }
}

// The run's sub-workspaces, or null when any of them is not a real path inside
// the workspace. `modules` and every `modules/<id>` must be a REAL directory
// (`lstat`, never `stat`), and must resolve inside the workspace root: a link at
// `modules` otherwise sends a scrub or a restore into a folder the delete will
// never reach. On the checked root, links below `modules/` are skipped by
// `swapInFiles` already, so only these three levels are checked.
function subWorkspaces(ws) {
  const dir = path.join(ws, MODULES_DIR)
  const st = lstatSync(dir, { throwIfNoEntry: false })
  if (!st) return [] // a one-module workspace has none
  let root
  try {
    root = realpathSync(ws)
  } catch {
    return null
  }
  const real = (p, kind) => {
    const s = lstatSync(p, { throwIfNoEntry: false })
    if (!s || !s[kind]()) return null
    return realpathSync(p).startsWith(root + path.sep) ? p : null
  }
  const top = real(dir, "isDirectory")
  if (!top) return null
  const out = []
  for (const name of readdirSync(top)) {
    const sub = real(path.join(top, name), "isDirectory")
    if (!sub) return null
    out.push(sub)
  }
  return out
}

// Every workspace config a credential can sit in: the run's own, and the one of
// each module of a joined run. Null when the sub-workspace paths are not safe.
function workspaceConfigs(ws) {
  const subs = subWorkspaces(ws)
  if (!subs) return null
  const files = []
  for (const dir of [ws, ...subs]) {
    const file = path.join(dir, ".touchstone.json")
    const st = lstatSync(file, { throwIfNoEntry: false })
    if (!st) continue
    if (!st.isFile()) return null // a link (or a folder) where a config belongs
    files.push(file)
  }
  return files
}

const WS_LINK = "The modules folder of this workspace is not a real folder (a link, or outside the workspace), so nothing can safely be written into it."

// Change the `mcp` part of every workspace config, which the AI/MCP tools read.
// A credential in a kept workspace is scrubbed and restored in all of them: the
// root of a joined run carries no `mcp`, only its ai-mcp module does. Throws
// before writing anything when a path is unsafe, so a caller can drop the folder.
function editMcp(ws, change) {
  const files = workspaceConfigs(ws)
  if (!files) throw new Error(WS_LINK)
  for (const file of files) {
    const cfg = JSON.parse(readFileSync(file, "utf8"))
    if (!cfg.mcp || typeof cfg.mcp !== "object") continue
    change(cfg.mcp)
    writeFileSync(file, JSON.stringify(cfg, null, 2))
  }
}

// The config write goes first: it refuses an unsafe path before any text change.
function scrubSecrets(ws, secrets) {
  editMcp(ws, (mcp) => {
    delete mcp.token
    delete mcp.tokens
  })
  swapInFiles(ws, secrets.map((s, i) => [bytes(s), placeholder(i)]).sort((a, b) => b[0].length - a[0].length))
}

function restoreSecrets(ws, target) {
  editMcp(ws, (mcp) => Object.assign(mcp, credentialOf(target)))
  swapInFiles(ws, secretsOf(target).map((s, i) => [placeholder(i), bytes(s)]))
}
const credentialOf = (target) => ({ ...(target?.mcp?.token ? { token: target.mcp.token } : {}), ...(target?.mcp?.tokens ? { tokens: target.mcp.tokens } : {}) })
// The target as the module that holds the credential has it. `withPack` gives
// `mcp` only to an ai-mcp copy, so a joined run asks for that copy whatever the
// module's position in the list. A run without ai-mcp has no credential at all.
const credentialTarget = (target, packs) => (Array.isArray(packs) && packs.includes("ai-mcp") ? withPack(target, "ai-mcp") : target)
// The run's scope as the library has it now, or null when the scope is gone.
// A scope store that cannot be read is not "gone": nobody knows then, so this throws.
function libraryTarget(run) {
  if (!run.scope?.id) return null
  const library = getTarget(run.scope.id)
  if (library) return withPack(library, run.packs?.includes("ai-mcp") ? "ai-mcp" : run.scope.pack ?? library.pack)
  try {
    loadScopes() // the lookup above reads a damaged store as empty; this read throws
  } catch {
    throw new Error("The scope library cannot be read, so this follow-up did not start. Repair the scope store file, then send the message again.")
  }
  return null
}

// A follow-up puts the credential back into the kept workspace, and the record
// says so first (`restored`). A server that stopped before that follow-up ended
// left the credential there. At boot, take it out: scrub with the library
// credential, or delete the workspace when the library has none. The mark
// leaves the record only after that.
function cleanRestored(run) {
  if (!run || !idle(run) || run.owner) return
  let mine = false
  try {
    const rec = readWorkspace(run.id)
    if (!rec?.restored || !(mine = own(run))) return // a live owner still answers: its own ending scrubs
    const ws = checkedWorkspace(rec.ws, run.id)
    // A joined run's credential sits in its ai-mcp module, whatever its position.
    const secrets = secretsOf(credentialTarget(libraryTarget(run), run.packs))
    try {
      if (!ws || !secrets.length) throw new Error("nothing to scrub with")
      scrubSecrets(ws, secrets)
    } catch {
      removeKept(run.id)
      delete rec.ws
    }
    delete rec.restored
    writeWorkspace(run.id, rec)
  } catch {
    // The mark stays, so the next boot tries again and a follow-up does not trust
    // the files. This is also the path when the scope store cannot be read. The
    // workspace is then left alone. That is safe: with the mark set, a follow-up
    // must look the credential up first, and that lookup is refused too, so no
    // worker gets the files and the token is not used.
  } finally {
    if (mine) release(run)
  }
}

// The record of a run's workspace: the path, the run's scope snapshot without
// the credential, and whether the scope has a credential at all.
const workspaceRecord = (run, real, target, old, secrets) => ({ ws: real, target: withoutSecrets(target), ...(run.packs ? { packs: run.packs } : {}), modules: run.modules ?? old?.modules ?? [], ...(secrets.length || old?.credential ? { credential: true } : {}) })

// A workspace that a follow-up just built belongs to the run from that moment:
// the record names it, then the folder carries the run's mark. The record comes
// first, so a marked folder is never without one. If the server stops before
// the follow-up ends, the next boot finds the folder through the record and
// takes the credential out (cleanRestored). Best effort: on a failure the
// follow-up goes on as before, and its ending keeps or deletes the workspace.
function bindWorkspace(run, ws, target, old) {
  try {
    const real = checkedWorkspace(ws)
    if (!real) return
    const secrets = secretsOf(credentialTarget(target, run.packs))
    writeWorkspace(run.id, { ...workspaceRecord(run, real, target, old, secrets), ...(secrets.length ? { restored: true } : {}) })
    const mark = path.join(real, WS_MARK)
    // The copied source can bring a file or a link with this name. It goes
    // first (a link is removed, never followed), as in keepWorkspace.
    rmSync(mark, { recursive: true, force: true })
    writeFileSync(mark, markText(run.id), { flag: "wx", mode: 0o600 })
  } catch {
    // see above
  }
}

// ---- Orphan workspaces. A folder in the temp folder that carries this
// server's mark, but that the run's record does not name, belongs to nobody: its
// run was deleted, or the record points to another folder. A follow-up never
// finds it again, and it can hold what the agent wrote. The boot removes it,
// through the checked delete. A folder without a mark is never touched: it may
// be a live run's, another server's or a test's. Neither is a folder whose
// mark another results folder wrote, nor one with a mark of the older form,
// nor one whose mark holds something that is not a run id (the id goes into
// file paths). A folder whose run has a record that cannot be read stays too:
// that record may name it. Those are only counted, in one log line.
function sweepOrphans() {
  const seen = { unmarked: 0, foreign: 0, removed: 0, unread: 0, kept: 0 }
  try {
    const tmp = realpathSync(tmpdir())
    const home = resultsHome()
    for (const name of readdirSync(tmp)) {
      if (!WS_NAME.test(name)) continue
      const dir = checkedWorkspace(path.join(tmp, name))
      if (!dir) continue // a link, or a folder of another user
      const mark = readMark(dir)
      if (!mark) seen.unmarked += 1
      else if (mark.home !== home || !isRunId(mark.id)) seen.foreign += 1
      else seen[removeOrphan(dir, mark.id)] += 1
    }
  } catch {
    // Best effort: the boot goes on.
  }
  if (seen.unmarked || seen.foreign || seen.removed || seen.unread) {
    console.warn(`[runs] temp folders with a workspace name: ${seen.removed} with this server's mark and no run record were removed; ${seen.unread} with a run record that cannot be read, ${seen.unmarked} with no mark and ${seen.foreign} with another mark were left alone.`)
  }
}

// "removed", or why the folder stays: "kept" (a run uses it, or the delete
// failed), "unread" (the run's record is there but cannot be read).
function removeOrphan(dir, id) {
  const lock = { id }
  let mine = false
  try {
    // A server may work on the run right now: this one (a run it resumes at
    // boot) or another live one. The run's lock says so.
    if (existsSync(path.join(RESULTS_DIR, `run-${id}.owner.sqlite`)) && !(mine = own(lock))) return "kept"
    // No record: the run has no workspace. A record that cannot be read may
    // name this folder, so the folder stays.
    const rec = readWorkspace(id)
    if (rec === null) return "unread"
    if (checkedWorkspace(rec?.ws, id) === dir) return "kept" // the run's own kept workspace
    removeChecked(dir, id)
    return existsSync(dir) ? "kept" : "removed"
  } catch {
    return "kept" // a part stayed: the mark is back, so the next boot tries again
  } finally {
    if (mine) release(lock)
  }
}

// Keep the workspace of a run that has an agent session: only that run can take
// a follow-up. Returns false when there is nothing to keep, or when the
// credential could not be taken out: the workspace is then deleted as before.
function keepWorkspace(run, ws) {
  const real = run?.id && existsSync(path.join(RESULTS_DIR, `run-${run.id}.sqlite`)) ? checkedWorkspace(ws) : null
  if (!real) return false
  try {
    const old = readWorkspace(run.id)
    const target = run.target ?? (run.saved ? run.saved.target : null) ?? old?.target ?? null
    const secrets = secretsOf(credentialTarget(target, run.packs))
    // A restored credential that is not known here cannot be scrubbed: do not keep.
    // The same when the old record cannot be read: it may have said `restored`.
    if ((old === null || old?.restored) && !secrets.length) return false
    if (secrets.length) scrubSecrets(real, secrets)
    const mark = path.join(real, WS_MARK)
    rmSync(mark, { recursive: true, force: true }) // the agent could have put a link here
    writeFileSync(mark, markText(run.id), { flag: "wx", mode: 0o600 })
    writeWorkspace(run.id, workspaceRecord(run, real, target, old, secrets))
  } catch {
    return false // no record, no way back to the files: remove them as before
  }
  pruneWorkspaces()
  return true
}

// shortcut: only the number of kept workspaces is capped, and they stay in the
// temp folder (RAM on some hosts, emptied at a reboot). Cap bytes or move them
// to a disk folder when runs get large. A run that lost its workspace this way
// still takes a follow-up: it gets a new workspace and is told so.
function pruneWorkspaces() {
  const keep = Number(process.env.TOUCHSTONE_KEEP_WORKSPACES) || 8
  try {
    const kept = readdirSync(RESULTS_DIR)
      .map((f) => /^run-(.+)\.workspace\.json$/.exec(f))
      .filter((m) => m && readWorkspace(m[1])?.ws)
      .map((m) => ({ id: m[1], at: statSync(path.join(RESULTS_DIR, m[0])).mtimeMs }))
      .sort((a, b) => b.at - a.at)
    for (const { id } of kept.slice(keep)) {
      const run = runs.get(id)
      if (run && !idle(run)) continue
      removeKept(id)
      unbindWorkspace(id)
    }
  } catch {
    // Best effort: a failed prune must not fail the run that just ended.
  }
}

// End a run's use of its workspace. First let the pack stop what its pre-pass
// left running there (the web lab's container), or that would outlive the run.
// The files stay when the run can take a follow-up; otherwise they are deleted.
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
  if (keepWorkspace(run, ws)) {
    // The files stay. The run's Daytona machines do not: they open again on demand.
    if (existsSync(`${ws}.daytona.json`)) await closeRun(ws).catch(() => {})
    return
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
  if (!run) throw new Error("This run was not found. It may have been deleted. Open another run or start a new one.")
  if (run.archived) throw new Error("This run is archived. Unarchive it to send it a message.")
  const msg = typeof text === "string" ? text.trim() : ""
  if (!msg) throw new Error("The message is empty. Type a message and send it again.")
  // The UI's id for the message. The echo carries it back unchanged.
  const tag = typeof clientId === "string" && /^[\w-]{1,64}$/.test(clientId) ? clientId : undefined
  if (idle(run)) return followUp(run, msg, tag)
  if (!run.child?.stdin?.writable) throw new Error(`The run cannot take a message at this moment (its status is "${run.status}"). Wait a moment and send the message again.`)
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
// status. Nothing was proven, so it reads like a run that found nothing —
// unless part of the scope was never read; then it ends as a coverage error.
function endStopped(run) {
  run.stopping = false
  run.error = null
  run.errorInfo = null
  broadcast(run, { t: Date.now(), ev: "stopped" })
  setRunStatus(run, coverageGap(run) ? "error" : "no-finding")
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

// Build a fresh workspace for the run's own scope: joined when the run covers
// several modules, plain otherwise. One function so the follow-up rebuild, the
// boot recovery and the run start never drift apart on a joined run.
function buildWorkspace(run, target, kept) {
  const packs = run.packs ?? kept?.packs ?? null
  const modules = run.modules ?? kept?.modules ?? []
  return packs?.length > 1 ? prepareMultiWorkspace(target, { packs, modules }) : prepareRunWorkspace({ ...target }, { modules })
}

// ---- The sources of a workspace that is built again. The agent fetched them
// with fetch_source, and each `source-fetch` event of the run names what was
// read: a repo's commit, or a single file's content hash. A new workspace gets
// the same code back: the pins go into its config, and each member is fetched
// at its pin. A pin stays for the rest of the run, so a later fetch_source of
// that member reads the same code or is refused; it never reads other code in
// silence. A fetch from before commits were recorded has no pin: that member is
// not put back, and the run says its code can differ.
//
// Returns the three lists for the `workspace` event. Throws when the pins
// cannot be written: the follow-up must not start without them.
async function restoreSources(run, ws) {
  const out = { same: [], missing: [], unpinned: [] }
  // The last fetch of each member that landed.
  const before = new Map()
  for (const e of run.events) if (e.ev === "source-fetch" && e.ok && e.where && typeof e.url === "string") before.set(e.url, e)
  // A commit or a hash that is in the event is a pin, whatever it holds: the
  // fetch judges it, and refuses one it cannot read. Only a missing field is "no pin".
  const pins = {}
  for (const [url, e] of before) {
    if (e.commit !== undefined) pins[url] = { commit: e.commit }
    else if (e.sha256 !== undefined) pins[url] = { sha256: e.sha256 }
    else out.unpinned.push(`${url} (was in ${e.where})`)
  }
  if (!Object.keys(pins).length) return out
  const file = path.join(ws, ".touchstone.json")
  const cfg = JSON.parse(readFileSync(file, "utf8"))
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("the config of the new workspace is not a record")
  writeFileSync(file, JSON.stringify({ ...cfg, pins }, null, 2))
  for (const [url, pin] of Object.entries(pins)) {
    try {
      const report = await restoreSource(ws, url)
      // A joined run keeps one tree for the run and a copy in each module that reads code.
      if (run.packs?.length > 1) shareFetched(ws, run.packs, report.where)
      out.same.push(`${url} (${pin.commit ? `commit ${String(pin.commit).slice(0, 12)}` : "the same file"}, in ${report.where})`)
    } catch (err) {
      out.missing.push(`${url}: ${String(err?.message ?? err)}`)
    }
  }
  return out
}

// Start a follow-up: one operator message to an idle run. The worker reopens
// the run's saved agent session in the run's own kept workspace, answers, and
// exits. Any finding it proves is replayed and added to the run record. When
// the workspace is gone, a new one is built from the run's scope, and one
// `workspace` event tells the operator and the agent the same true thing.
export function followUp(run, text, clientId) {
  const capRefusal = spendCapRefusal()
  if (capRefusal) throw new Error(capRefusal)
  const money = budgetEnv(run)
  if (Number(money.RUN_SPENT_USD) >= Number(money.RUN_BUDGET_USD)) throw new Error(`This run has spent its budget of $${money.RUN_BUDGET_USD}. Start a new run with a higher budget to continue the work.`)
  ensureFiles(run)
  if (!existsSync(run.db)) throw new Error("This run stopped before its agent session started. Start a new run to chat with an agent.")
  // The run's own snapshot comes first. Never replace it with a newer, wider
  // scope from the library. Only a run from before workspaces were kept has no
  // snapshot; its scope may allow several modules now, so it comes back under
  // the module this run used.
  const kept = readWorkspace(run.id)
  // A record that cannot be read is not a lost workspace. Nothing is built and
  // nothing is changed: the operator repairs the file, or deletes it on purpose.
  if (kept === null) throw new Error(`The workspace record of this run cannot be read, so this follow-up did not start. Repair the file ${workspaceFile(run.id)}, or delete it to continue in a new workspace. Then send the message again.`)
  // The record's path is used only when the directory passes the check and
  // carries this run's mark. Otherwise the path leaves the record.
  let ws = checkedWorkspace(kept?.ws, run.id)
  let target = run.target ?? kept?.target ?? libraryTarget(run)
  // The credential is not kept with the workspace. It comes back from the scope
  // library, where it already is. Only the credential: the rest stays the run's
  // own snapshot. A scope that is gone from the library gives none.
  let noCredential = ""
  if (target && kept?.credential && !secretsOf(credentialTarget(target, run.packs)).length) {
    const found = credentialOf(credentialTarget(libraryTarget(run), run.packs))
    if (secretsOf({ mcp: found }).length) target = { ...target, mcp: { ...target.mcp, ...found } }
    else noCredential = "The access token of this run's scope is no longer in the scope library, so this follow-up runs without it."
  }
  if (kept?.ws && !ws) unbindWorkspace(run.id) // after the lookups: a refusal above changes nothing
  if (!ws && !target) throw new Error("The workspace of this run is gone and its scope is no longer in the library, so the workspace cannot be built again. Start a new run on the scope you want.")
  if (target) run.target = target
  if (!own(run)) throw new Error("Another server is already answering this run. Wait until it finishes, then send the message again.")
  // The workspace goes, and a new one is built below, in two cases:
  //   - the server stopped during an earlier follow-up, so it still holds the
  //     credential and this follow-up has none;
  //   - a path under `modules/` is a link, so nothing may be written into the
  //     files that a scrub would reach.
  const unsafe = ws ? workspaceConfigs(ws) === null : false
  if (ws && ((kept.restored && noCredential) || unsafe)) {
    try {
      removeKept(run.id)
    } catch {
      // checked just below
    }
    if (existsSync(ws)) {
      release(run)
      throw new Error(
        unsafe
          ? `The modules folder of this run's workspace is not a real folder, and the workspace could not be removed. Delete the folder ${ws}, then send the message again.`
          : `The earlier workspace of this run still holds the access token, and it could not be removed. Delete the folder ${ws}, then send the message again.`,
      )
    }
    unbindWorkspace(run.id)
    ws = null
  }
  // The scope's current brief, from the library. When it differs from the last
  // one this run had, the follow-up message carries it and Run Info shows it.
  const brief = briefOf((target?.id ? getTarget(target.id) : null) ?? libraryTarget(run) ?? target)
  const briefNote = briefChange(run.events.findLast((e) => e.ev === "brief")?.text, brief)
  // The module rides along: a joined run's duplicate checks work per module.
  const prior = run.submitted.map(({ n, title, severity, poc, pack }) => ({ n, title, severity, poc, ...(pack ? { pack } : {}) }))
  run.settled = null
  run.error = null
  run.errorInfo = null
  run.stopping = false
  run.replying = true
  broadcast(run, { t: Date.now(), ev: "reply-start" })
  if (briefNote) broadcast(run, { t: Date.now(), ev: "brief", text: brief })

  const end = async () => {
    if (run.ws) await endWorkspace(run).catch(() => {})
    run.child = null
    run.stopping = false
    run.replying = false
    broadcast(run, { t: Date.now(), ev: "closed" })
  }
  const start = (note) => {
    const since = Date.now()
    const errFrom = run.stderr.length // the card must not quote an earlier worker's output
    const child = spawn(process.execPath, [ENGINE, "child", "chat", run.db, run.ws], {
      cwd: SPIKE,
      // No reach env: a follow-up gets no route to a live target, as before.
      env: {
        ...process.env,
        TOUCHSTONE_PARENT_PIPE: "1",
        PROVIDER: runProvider(run),
        ALIAS: run.alias,
        EVENTS_FILE: run.eventsFile,
        RUN_CHARGE_FILE: path.join(RESULTS_DIR, `run-${run.id}.charges.jsonl`),
        ...money,
        ...fleetEnv(run),
        ...scopeEnv({ ...target, brief }, run.packs),
        ...(briefNote ? { BRIEF_CHANGE: briefNote } : {}),
        FOLLOWUP: text,
        ...(clientId ? { FOLLOWUP_ID: clientId } : {}),
        ...(note ? { WORKSPACE_NOTE: note } : {}),
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
    child.on("exit", async (code, signal) => {
      if (!run.stopping) recoverSettled(run, since)
      const s = run.settled
      try {
        if (s?.findings?.length) await recordMore(run, s.findings)
        else if (run.stopping) broadcast(run, { t: Date.now(), ev: "stopped" })
        else if (!s) {
          const tail = run.stderr.slice(errFrom).slice(-800).trim()
          broadcast(run, { t: Date.now(), ev: "reply-error", error: `The agent process ended before it gave an answer: ${exitWords(code, signal)}. Send the message again to retry.${tail ? `\n\n${tail}` : ""}` })
        }
        // A failed run that a follow-up retried: if the reply finished, or the
        // operator stopped it, the old failure no longer describes the run —
        // unless part of the scope is still unread.
        if (run.status === "error" && !s?.findings?.length && (run.stopping || s?.status === "done")) {
          run.error = null
          run.errorInfo = null
          setRunStatus(run, coverageGap(run) ? "error" : "no-finding")
          finalize(run)
        }
      } catch (err) {
        broadcast(run, { t: Date.now(), ev: "reply-error", error: `The reply ended, but its result could not be saved: ${String(err?.message ?? err)} Send the message again to retry.` })
      } finally {
        await end()
      }
    })
  }

  if (ws) {
    run.ws = ws
    dropOldBriefFile(ws, target)
    if (noCredential) {
      broadcast(run, { t: Date.now(), ev: "workspace", state: "kept", message: noCredential })
      start(`Operator follow-up. Your workspace is the one you left: the files you wrote and the sources you fetched are still there. ${noCredential} A placeholder text stands where a file held it.`)
      return { ok: true, followUp: true }
    }
    try {
      if (kept?.credential) {
        writeWorkspace(run.id, { ...kept, restored: true }) // before the first file gets the credential
        restoreSecrets(ws, target)
      }
    } catch (err) {
      broadcast(run, { t: Date.now(), ev: "reply-error", error: `The access token could not be put back into the workspace: ${String(err?.message ?? err)} Send the message again to retry.` })
      end()
      return { ok: true, followUp: true }
    }
    start(null)
    return { ok: true, followUp: true }
  }
  // The workspace is gone: deleted, or left on another machine, or lost with
  // the temp folder at a reboot. Build a new one from the run's scope and say so.
  run.ws = null
  buildWorkspace(run, target, kept).then(
    async (made) => {
      run.ws = made
      bindWorkspace(run, made, target, kept)
      let sources
      try {
        sources = await restoreSources(run, made)
      } catch (err) {
        // Without the pins a fetch could read other code than before. Do not start.
        broadcast(run, { t: Date.now(), ev: "reply-error", error: `The workspace of this run is gone, and the new one could not be told which code this run read before: ${String(err?.message ?? err)} So this follow-up did not start. Send the message again to retry.` })
        await end()
        return
      }
      const message = [
        "The earlier workspace of this run is gone, so this is a new workspace built from the same scope.",
        "Files the agent wrote before are not in it.",
        sources.same.length ? `These fetched sources are in it again, as this run read them before: ${sources.same.join("; ")}.` : "",
        sources.missing.length ? `These fetched sources could not be put back, so they are not in it: ${sources.missing.join("; ")}.` : "",
        sources.unpinned.length ? `These fetched sources are not in it: ${sources.unpinned.join("; ")}. A new fetch gets the newest version, which can differ from the one read before.` : "",
        target.generated ? "The lab was generated again with new throwaway keys, so it is not the same repository as before." : "",
        noCredential,
      ].filter(Boolean).join(" ")
      broadcast(run, { t: Date.now(), ev: "workspace", state: "rebuilt", message })
      start(`Operator follow-up. ${message} Write or fetch again what you need.`)
    },
    async (err) => {
      broadcast(run, { t: Date.now(), ev: "reply-error", error: `The workspace of this run is gone, and a new one could not be built: ${String(err?.message ?? err)} Fix the cause, then send the message again.` })
      await end()
    },
  )
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
  noteCoverage(run, { always: true })
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
  // The kept workspace goes with the run. Its record moves to the trash below.
  removeKept(id)
  const trash = path.join(RESULTS_DIR, "trash")
  mkdirSync(trash, { recursive: true })
  const prefix = `run-${id}.`
  if (existsSync(RESULTS_DIR)) {
    for (const f of readdirSync(RESULTS_DIR)) {
      if (f.startsWith(prefix)) renameSync(path.join(RESULTS_DIR, f), path.join(trash, f))
    }
  }
  // The run's record is in the trash now, so it names no replay file any more.
  pruneReplays(run)
  runs.delete(id)
  return { ok: true }
}

// Remove each stored replay file (replay/<sha256>.json) that no run record
// names any more. A run in its proof check stores a replay file before its
// record names it, so nothing is removed while another run works: the prune is
// owed then, and runs when a run closes. `self` is the run that is ending.
function pruneReplays(self) {
  registry.pruneOwed = [...runs.values()].some((r) => r !== self && !idle(r))
  if (registry.pruneOwed) return
  try {
    pruneReplayStore(RESULTS_DIR) // removes nothing when a record cannot be read
  } catch {
    // Best effort: the delete or the close itself is done.
  }
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
    // Every module of a joined run, so history says what the one run covered.
    ...(run.packs ? { packs: run.packs } : {}),
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
    // Which GitHub members were read (and where) and which were not, with why.
    sourceCoverage: runCoverage(run),
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
    // Every lead an agent recorded, worst first, with its evidence (file, line,
    // reason) and the agent that found it. Saved as events the moment each lead
    // was made, so a run that failed later still keeps them. Never proven.
    leads: leadsFrom(evs),
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
  // The record is now on disk. Re-run each proven Foundry proof from its own
  // bundle files, offline, in the background, and patch the verdict onto the
  // record when the check ends — so recording is never delayed by the check.
  if (findings.length) void recordReplayReruns(RESULTS_DIR, run.id).catch(() => {})
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
// The same form, for an id that comes from file content and goes into a path.
const isRunId = (id) => APP_RUN.test(`run-${id}.json`)

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
  const view = prepassViewOf(record.prepass ?? prepassFromResult(r))
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

// ---- A fleet and a restart. A restart kills the workers, so a child that was
// mid-turn would read as working for ever. Its end is written into the stream,
// with the reason. The server starts no agent again: an agent costs money, so
// the operator decides. A message continues the run (followUp).
const CUT_OFF = "The server restarted while this agent was working. It was not started again."

// A run's children by their last lifecycle event. `working` still read as
// working. `cut` were ended by a restart and have not worked since.
function fleetChildren(events) {
  const last = new Map()
  for (const e of events) {
    if ((e.ev === "subagent-spawned" || e.ev === "agent-status" || e.ev === "subagent-done") && typeof e.id === "string") last.set(e.id, e)
  }
  const ids = (test) => [...last].filter(([, e]) => test(e)).map(([id]) => id)
  return {
    working: ids((e) => e.ev === "subagent-spawned" || (e.ev === "agent-status" && e.state !== "idle")),
    cut: ids((e) => e.ev === "subagent-done" && e.interrupted === true),
  }
}

// The end of each child that still reads as working. The view has no
// "interrupted" state yet, so the status is "failed"; `interrupted` says why.
// The time is the run's last event: the last moment the child is known to
// have worked, not the moment the server came back.
function cutOffEvents(events) {
  const t = events.findLast((e) => typeof e.t === "number")?.t ?? Date.now()
  return fleetChildren(events).working.map((id) => ({ t, ev: "subagent-done", agent: id, id, status: "failed", interrupted: true, error: CUT_OFF }))
}

// The error card of a fleet run that a restart cut off: who was mid-turn, that
// nothing was started again, and the one next step.
function fleetCutOff(id, events, saved) {
  const names = fleetChildren(events).cut.map((c) => events.find((e) => e.ev === "subagent-spawned" && e.id === c)?.name || c)
  const who = names.length > 1 ? `, and ${names.slice(0, -1).join(", ")} and ${names.at(-1)} were cut off mid-turn` : names.length ? `, and ${names[0]} was cut off mid-turn` : ""
  // Without a saved agent session there is nothing a message could continue.
  const session = existsSync(path.join(RESULTS_DIR, `run-${id}.sqlite`))
  // The files are there when a follow-up would reuse the workspace: the kept one
  // of this run, or the one the run worked in at the stop (it is kept just after).
  const files = checkedWorkspace(readWorkspace(id)?.ws, id) ?? checkedWorkspace(saved?.ws)
  return {
    kind: "cutoff", retryable: session, reason: "interrupted", detail: "",
    spentUsd: Number(events.findLast((e) => e.ev === "spend")?.usd ?? 0),
    title: "This fleet run stopped at the server restart",
    hint: session
      ? `The server restarted while this fleet was working${who}. No agent was started again, so nothing more was spent. Press Run again to continue in this chat. The run keeps its history${files ? ", its agents and its files" : " and its agents"}.`
      : "The server restarted before the agents of this fleet started. Start a new run on the same scope.",
    message: "this fleet run stopped at the server restart; its agents were not started again",
  }
}

// What the agents submitted so far, each with the test source that passed. The
// engine keeps this list beside the session (spike/lib/audit-state.mjs).
function submittedFindings(id) {
  try {
    const found = JSON.parse(readFileSync(path.join(RESULTS_DIR, `run-${id}.sqlite.audit.json`), "utf8")).found
    return Array.isArray(found) ? found : []
  } catch {
    return []
  }
}

// A `finding` event in the stream says "proven" only as a copy. The run record
// holds the replay proof. A copy that the record does not back reads as not
// proven: no record, an unreadable record, or a replay that did not pass. This
// only ever takes `proven` away. Nothing at load sets it. Ids are the ledger's
// (splitRun in findings.mjs): `<run>.<k>`, or the run id for an older record
// with one finding. The copy must also be the record's finding, not only carry
// its number: a line that keeps the id of a proven finding but names another
// title, severity or test is not proven.
const sameFinding = (e, f) => ["poc", "title", "severity"].every((k) => (e[k] ?? null) === (f?.[k] ?? null))
function provenByRecord(id, events) {
  const claims = events.filter((e) => e.ev === "finding" && e.proven !== false)
  if (!claims.length) return
  let r = {}
  try {
    r = JSON.parse(readFileSync(path.join(RESULTS_DIR, `run-${id}.json`), "utf8")).result ?? {}
  } catch {
    // no readable record: nothing is proven
  }
  const list = Array.isArray(r.findings) && r.findings.length ? r.findings : null
  for (const e of claims) {
    const k = String(e.id).startsWith(`${id}.`) ? Number(String(e.id).slice(id.length + 1)) : NaN
    const entry = list ? (Number.isInteger(k) ? list[k - 1] : null) : e.id === id ? r.finding : null
    const stored = list || !entry ? entry : { pocProved: r.pocProved, proof: r.proof }
    if (!isProven(stored) || !sameFinding(e, entry)) e.proven = false
  }
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
  // A joined run's modules, from its own event. Null on a one-module record.
  let packs = null
  let provider = null
  let model = null
  let archived = false
  let name = null
  // How the stream's last error ended, so the run list keeps its kind.
  let streamInfo = null
  const submitted = []
  for (const e of events) {
    if (e.ev === "archived") archived = Boolean(e.archived)
    if (e.ev === "renamed") name = typeof e.name === "string" && e.name ? e.name : null
    if (e.ev === "scope") scope = e.scope ?? null
    if (e.ev === "modules") modules = e.modules ?? null
    if (e.ev === "packs" && Array.isArray(e.packs) && e.packs.length > 1) packs = e.packs
    if (e.ev === "provider") ({ provider = null, model = null } = e)
    if ((e.ev === "finding-submitted" || e.ev === "approval-pending") && !submitted.some((f) => f.poc === e.poc)) {
      submitted.push({ n: e.n ?? submitted.length + 1, title: e.title, severity: e.severity, poc: e.poc, ...(e.pack ? { pack: e.pack } : {}) })
    }
    if (e.ev === "status") {
      status = e.status ?? status
      if (e.decision) decision = e.decision
      if (Array.isArray(e.findingIds)) findingIds = e.findingIds
      if (typeof e.error === "string") error = e.error
      streamInfo = e.status === "error" && e.errorInfo && typeof e.errorInfo === "object" ? e.errorInfo : null
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
  const mode = events.findLast((e) => e.ev === "mode")?.mode ?? (saved || {}).mode
  // A fleet cut off while its agents worked: the agents stay stopped, but the
  // proof check of what they had submitted is free, so it runs (resumeRun).
  if (interrupted && saved && mode !== "solo" && saved.phase === "agent" && !stopPending && existsSync(path.join(String(saved.ws), ".touchstone.json"))) {
    const found = submittedFindings(id)
    if (found.length) saved = { ...saved, phase: "proof", settled: { status: "interrupted", reason: "interrupted", findings: found } }
  }
  // A follow-up the restart cut off started after the last close.
  const lastClose = events.findLastIndex((e) => e.ev === "closed")
  const replyCut = events.findLastIndex((e) => e.ev === "reply-start") > lastClose
  // The children that were mid-turn end here. loadSavedRun writes these to the file.
  const cut = interrupted || replyCut ? cutOffEvents(events) : []
  events.push(...cut)
  // A restart ending is stamped at the run's last event, like a cut-off child,
  // so the run's time is the time it worked, not the time the server came back.
  const end = events.findLast((e) => typeof e.t === "number")?.t ?? Date.now()
  let errorInfo = null
  // Only a solo run starts its agent again. A fleet goes on by itself only from
  // its proof phase, where every agent has already ended.
  if (interrupted && (!saved || (mode !== "solo" && saved.phase !== "proof" && !stopPending))) {
    status = "error"
    // Every restart ending is a cut-off (kind "cutoff"), not a failure.
    const session = saved !== false && existsSync(path.join(RESULTS_DIR, `run-${id}.sqlite`))
    errorInfo = saved !== false && mode === "fleet" ? fleetCutOff(id, events, saved) : {
      kind: "cutoff", retryable: session, reason: "interrupted", detail: "",
      spentUsd: Number(events.findLast((e) => e.ev === "spend")?.usd ?? 0),
      title: "This run stopped at the server restart",
      hint: saved === false
        ? "The server restarted during this run, and its saved state could not be read, so it cannot go on. Start a new run on the same scope."
        : session
          ? "The server restarted during this run. It was not started again, so nothing more was spent. Press Run again to continue in this chat."
          : "The server restarted before this run started its agent. Start a new run on the same scope.",
      message: saved === false ? "saved recovery state is unreadable; start a new run" : "the server restarted during this run, so it stopped",
    }
    error = errorInfo.message
    events.push({ t: end, ev: "status", status, error, errorInfo })
  }
  if (replyCut) {
    events.push({ t: end, ev: "reply-error", error: "The server restarted during this reply, so the reply stopped. Send the message again to continue." })
    events.push({ t: end, ev: "closed" })
  }
  if (TERMINAL.includes(status) && !events.some((e) => e.ev === "closed") && !existsSync(path.join(RESULTS_DIR, `run-${id}.state.json`))) events.push({ t: end, ev: "closed" })
  return {
    id,
    alias,
    target: null,
    scope,
    modules,
    packs,
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
    errorInfo: errorInfo ?? streamInfo,
    interrupted,
    saved,
    cut,
    child: null,
    stderr: "",
  }
}

// Write the ends of the cut-off children into the stream file, so they stay in
// the run's history. Only the owner of the run calls this. The file is read
// again first, so two servers that boot together cannot write an end twice. A
// failed write leaves the ends in memory; the next boot makes them again.
function saveCut(run) {
  if (!run.cut.length) return
  try {
    ensureFiles(run)
    const working = new Set(fleetChildren(readJsonl(run.streamFile)).working)
    const lines = run.cut.filter((e) => working.has(e.id)).map((e) => JSON.stringify(e) + "\n").join("")
    // A crash can leave a torn last line. Start on a new line, or the first end joins it and is lost.
    const torn = lines && !readFileSync(run.streamFile, "utf8").endsWith("\n")
    appendFileSync(run.streamFile, (torn ? "\n" : "") + lines)
    run.cut = []
  } catch {
    // a full disk must not hide the run
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
  run.packs = state.packs ?? run.packs ?? null // The modules a joined run covers.
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
      ...(run.packs?.length ? [{ ev: "packs", packs: run.packs }] : []),
      modulesEvent(run.modules ?? []),
      { ev: "provider", provider: run.provider, model: run.model },
      { ev: "status", status: "starting" },
    ]
    for (const event of initial) if (!run.events.some((e) => e.ev === event.ev)) broadcast(run, { t: Date.now(), ...event })
    run.reach = await openReach(run.target, { mode: run.target.kind === "live" ? "confine" : "proxy", grantIds: run.grantIds })
    broadcast(run, { t: Date.now(), ev: "phase-restarted", phase: "setup" })
    run.ws = await buildWorkspace(run, run.target, null)
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
  // A run in flight across the upgrade may hold the BRIEF.md Touchstone used to
  // write. A live run has no mark yet, so the check is the path one only.
  dropOldBriefFile(checkedWorkspace(run.ws), run.target)
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
    return endRestartedRun(run)
  }
  throw new Error(`unknown saved phase: ${state.phase}`)
}

// A restarted run whose proof phase settled with no finding: end it cleanly on
// its saved verdict. One function so a later merge (fix/large-repo-scope's
// coverageGap check on clean-end paths) is a one-line change here.
async function endRestartedRun(run) {
  if (run.settled.status === "done" && run.settled.final) broadcast(run, { ev: "no-finding", final: run.settled.final })
  // A saved settle that is not "done" is a real failure (the worker died, the
  // budget ran out). Give the error card its structured reason before ending.
  if (run.settled.status !== "done") {
    run.errorInfo = failureInfo(run)
    run.error = run.errorInfo.message
  }
  setRunStatus(run, run.settled.status !== "done" || coverageGap(run) ? "error" : "no-finding")
  finalize(run)
  await endWorkspace(run)
  broadcast(run, { ev: "closed" })
}

function loadSavedRuns() {
  if (!existsSync(RESULTS_DIR)) return
  const ids = new Set()
  for (const f of readdirSync(RESULTS_DIR)) {
    const m = APP_RUN.exec(f)
    if (m && !runs.has(m[1])) ids.add(m[1])
  }
  for (const id of ids) loadSavedRun(id)
  for (const id of ids) cleanRestored(runs.get(id))
  // Once per server process, not at each reload of this module.
  if (!registry.swept) sweepOrphans()
  registry.swept = true
}

// Another process owned these runs at load. Follow their saved streams, and
// take a run over once its owner exits.
function adoptOrphans() {
  // A copy: the loop takes a run out and puts it back, and a Map visits a key
  // that is put back again, so the loop would never end.
  for (const [id, old] of [...runs]) {
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
      provenByRecord(id, events)
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
    // A restart during a follow-up leaves the run idle: no branch below owns it.
    if (!run.interrupted && run.cut.length && own(run)) {
      saveCut(run)
      release(run)
    }
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
      saveCut(run)
      if (!existsSync(recordFile)) finalize(run)
      if (run.saved === false) {
        ensureFiles(run)
        broadcast(run, { ev: "closed" }) // releases the lock and removes the torn state file
      } else if (run.saved) {
        // A valid checkpoint we will not resume (a fleet, or unknown-mode, run).
        // Drop the stale state file so a later boot does not keep seeing it
        // interrupted; it shows as ended at the restart. Its agents are not
        // started again here: the operator continues the run with a message.
        ensureFiles(run)
        run.ws = run.saved.ws ?? null
        endWorkspace(run).catch(() => {}).finally(() => broadcast(run, { ev: "closed" }))
      } else release(run)
    }
    if (run.interrupted && run.status !== "error") {
      ensureFiles(run)
      if (own(run)) {
        saveCut(run)
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
