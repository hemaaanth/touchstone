import type { Harm } from "./eth"

// The shapes the API serves. Every field is derived from a real recorded
// engine run; see server/findings.mjs.

export type Severity = "critical" | "high" | "medium" | "low"

// "auto" — recorded automatically on a passing replay. "dismissed" — the
// operator later marked it not a finding they count (the proof still stands).
export type AcceptedState = boolean | "auto" | "dismissed"

// How a run uses agents. A fleet run must split the scope across child agents.
// A solo run is one agent. The operator picks it in New run.
export type RunMode = "fleet" | "solo"

export interface FindingStages {
  hypothesis: boolean
  reproduced: boolean
  proven: boolean
  accepted: AcceptedState
}

// A candidate as the Findings page lists it (server/findings.mjs
// listCandidates). Never proven, no report, no bundle.
export interface CandidateSummary {
  id: string
  runId: string
  kind: "candidate"
  title: string | null
  severity: Severity
  module: string
  pack: string | null
  target: string
  scope: string | null
  at: number | null
  // The candidate's poc: the run view finds it by this (CANDIDATE_FOCUS).
  poc: string
  origin: "agent" | "measured"
  measured: { reason: "repeated" | "no-effect" | "harm-not-judged" | "unknown"; words: string; count: number; check: string | null; rule?: string | null } | null
  proven: false
}

export interface FindingSummary {
  id: string
  // Set only on a candidate row (the page lists candidates in the same grid).
  candidate?: CandidateSummary
  // The run that produced this finding. Lets findings be scoped to their own
  // run instead of a global rail. Optional for back-compat with recorded
  // findings written before the engine stamped it (server/findings.mjs).
  runId?: string
  title: string
  severity: Severity
  module: string
  target: string
  stages: FindingStages
  proven: boolean
  dismissed: boolean
  ms: number | null
  // The passing test contract this finding names. Lets the transcript match a
  // submitted finding to its recorded (replayed) one. Absent on old records.
  poc?: string
  // The module id that made it (the finding's own pack, else the run's), the
  // scope title the run used, and when the run started (ms). The list
  // (GET /api/findings) sends these; null when the record has none.
  pack?: string | null
  scope?: string | null
  at?: number | null
  // Which replay proves it, from the finding's own module (the run's `finding`
  // event). Absent on an older record.
  proofKind?: ProofKind
}

export interface PocRun {
  n: number
  pass: boolean
  test: string | null
  // The test contract this attempt ran. Lets a finding bind its proof to the
  // exact contract it claims, so a throwaway test passing never reads as green.
  contract: string | null
  gas: number | null
  passed: number | null
  failed: number | null
  compiler: string | null
  raw: string
}

export interface Balance {
  label: string
  before: string
  after: string | null
}

// A signed net-ETH delta for one address, read by the engine from the real
// Foundry trace of the proving replay. `net` is the display string ("+1 ETH");
// `gained` is true when that address ended richer.
export interface Transfer {
  label: string
  address: string
  net: string
  gained: boolean
  // The exact signed wei, when the server passes it (the record has it).
  netWei?: string
}

export interface Proof {
  tool: string
  compiler: string | null
  test: string | null
  contract: string | null
  gas: number | null
  pass: boolean
  runs: PocRun[]
  // Engine-read money-moved table (real trace deltas). Empty for older runs that
  // predate the structured proof delta — those fall back to `balances`.
  transfers: Transfer[]
  // Real runtime log lines the proving test emitted. Empty for older runs.
  logs: string[]
  balances: Balance[]
  assertions: string[]
  rerunCommand: string | null
  testSource: string | null
  // What the proof gate says was lost (spike/lib/proof.mjs), when the server
  // passes it: an ETH or token drain, or a control takeover.
  harm?: Harm | null
}

export interface Usage {
  usd: number | null
  in: number | null
  out: number | null
  reasoning: number | null
}

// One suspect the static analyzer ranked before the agent ran. A lead, never a
// verdict — the replay is what makes it real.
export interface StaticSuspect {
  check: string
  impact: string
  where: string | null
  line: number | null
  // Which independent engines flagged this spot. When more than one did, the
  // suspect is corroborated and ranks higher — agreement sharpens attention, it
  // never substitutes for the replay that makes a finding real.
  engines: string[]
  corroborated: boolean
}

// The static pre-pass summary: what the analyzers flagged that fed the agent.
export interface StaticScan {
  tool: string
  // Which engines ran this pass (e.g. ["Slither", "Aderyn"]).
  engines: string[]
  // How the source was compiled: "unit" (one compilation unit) or "per-file".
  mode: string | null
  suspects: number
  top: StaticSuspect[]
}

// One invariant the property fuzzers broke before the agent ran, with the exact
// call sequence that broke it. A lead, never a verdict — the replay is what makes
// it real.
export interface FuzzSuspect {
  check: string
  impact: string
  property: string
  where: string | null
  sequence: string[]
  // Which independent fuzzers broke this invariant. When both did, it is
  // corroborated and ranks higher — agreement sharpens attention, it never
  // substitutes for the replay that makes a finding real.
  engines: string[]
  corroborated: boolean
}

// The fuzz pre-pass summary: which invariant the fuzzers broke that fed the agent.
// What a pack's tool scan found before the agent started, the same shape for
// every pack (built by spike/lib/prepass-view.mjs). Leads are not findings.
export interface PrepassTool {
  name: string
  status: "ran" | "unavailable"
  reason: string | null
  leads: number
}
export interface PrepassLead {
  check: string
  impact: string
  where: string
  // Rule id and CWE, e.g. "10038 · CWE-693". Older records have none.
  rule?: string
  detail: string
  tools: string[]
  corroborated: boolean
}
export interface PrepassView {
  total: number
  tools: PrepassTool[]
  leads: PrepassLead[]
  failed?: boolean
}

export interface FuzzScan {
  tool: string
  // Which fuzz engines ran this pass (e.g. ["Echidna", "Medusa"]).
  engines: string[]
  template: string | null
  suspects: number
  top: FuzzSuspect[]
}

// A value on a proof card. A secret arrives redacted with its hash, never whole.
export type ProofCell =
  | { name: string; redacted: false; value: string }
  | { name: string; redacted: true; sha256: string }

// One request the replay sent and the response it got back.
export interface HttpExchange {
  label: string
  request: { method: string; url: string; headers: ProofCell[]; body: string | null }
  response: { status: number | null; headers: ProofCell[]; body: string | null }
}

// The `http` proof: the replay ran the request script against the practice
// service, and the oracle checked the harm in the responses.
export interface HttpProof {
  kind: "http"
  pass: boolean
  oracle: { name: string; detail: string; passed: boolean }
  exchanges: HttpExchange[]
  detail: string
}

// The `evidence` proof: the replay checked the cited evidence again against the
// pinned snapshot.
export interface EvidenceProof {
  kind: "evidence"
  pass: boolean
  check: string
  snapshotHash: string
  commit: string | null
  cited: ProofCell[]
  detail: string
}

export type ProofKind = "forge" | "http" | "evidence"

export interface FindingBase extends FindingSummary {
  // Which replay made the proof. Absent on a record from before kinds existed.
  proofKind?: ProofKind
  pack?: string
  // The pack's own pre-pass record, as the run kept it.
  prepass?: unknown
  decision: string | null
  recorded: boolean
  // The static pre-pass that produced the agent's leads, or null if none ran.
  staticScan: StaticScan | null
  // The fuzz pre-pass that produced the agent's accounting leads, or null if the
  // fuzzer broke nothing (or no fuzz template fit the target).
  fuzzScan: FuzzScan | null
  hypothesis: string | null
  explanation: string | null
  calls: string[]
  model: string | null
  usage: Usage
  // The agent's saved step stream (run-<id>.events), replayed read-only in the
  // finding's Conversation tab. Empty when no transcript was saved for the run.
  events: RunEvent[]
}

// The proof field follows the kind: one card per kind.
export type Finding = FindingBase &
  (
    | { proofKind?: "forge"; proof: Proof }
    | { proofKind: "http"; proof: HttpProof }
    | { proofKind: "evidence"; proof: EvidenceProof }
  )

// ---- Live runs. A run is one real agent session driving real inference and a
// real Foundry sandbox. These shapes mirror server/runs.mjs.

export type RunStatus =
  | "starting"
  | "running"
  | "awaiting-approval"
  | "deciding"
  | "recorded"
  | "denied"
  | "no-finding"
  | "error"

export interface ModelChoice {
  alias: string
  id: string
  abliterated: boolean
}

// Total spent across all runs (the spend ledger), the total spend cap every
// run stops at, and the default budget for one run. usd and capUsd are null
// when the ledger or the cap cannot be read; ledgerError then says why, and
// no new run can start.
export interface SpendState {
  usd: number | null
  capUsd: number | null
  ledgerError: string | null
  budgetUsd: number
}

// Where a finding for a target may be proven WITHOUT real-world harm. "kind"
// names the surface ("sandbox-foundry" today); "note" is the human sentence the
// UI shows so the operator can see a run can never touch live funds.
export interface ProofSurface {
  kind: string
  note: string
}

// One member of an operator scope, as the server summarizes it. No file
// content. `proof` is how this member's findings can be proven under the
// scope's pack: "forge" for Solidity under Contracts, else "none".
export type TargetScopeMember =
  | { kind: "repo"; url: string; proof: string }
  // `path` is set in the scope list for a folder the server reads in place.
  | { kind: "folder"; name: string; path?: string; files: number; proof: string }

// One scope from the target library. `kind` is lab | local-source | brief |
// scope (repos and folders mixed, any language);
// `signal` names the submodule expected to surface the lead first (static /
// fuzz / agent) — descriptive, never the thing that makes a finding real.
export interface TargetScope {
  id: string
  title: string
  kind: "lab" | "local-source" | "brief" | "scope" | "live"
  // A live scope's websites. `origins` is where a run sends requests (scheme,
  // host and port as typed); `hosts` is the gate's bare-host allow-list.
  hosts?: string[]
  origins?: string[]
  // The module (pack) this scope belongs to. Absent on a record saved before modules.
  pack?: string
  // Every module this scope allows. A run picks one of them at start.
  packs?: string[]
  blurb: string
  entry: string
  files?: string[]
  links?: string[]
  members?: TargetScopeMember[]
  // The operator's scope brief: text every run of the scope gets in the agent's
  // instructions. Only the scope list carries it; a run's scope event does not
  // (a run has its own `brief` event).
  brief?: string
  signal: string
  proofSurface: ProofSurface
}

// A module the New run dialog offers: one pack from the engine's loader.
export interface PackChoice {
  id: string
  title: string
  // What the module tests, in one plain sentence: the pack's own description
  // (spike/packs/index.mjs packList). Absent when a pack has none.
  description?: string
  tier?: string
  proof: string
  // The module's tools can be aimed at a real host.
  live?: boolean
  // What the pack's own lab stands in for. "rule-based" means the lab
  // assistant is a rule-based stand-in, not a model.
  labTarget?: string
  // Where the pack's tools reach. The engine sends each field only when the pack
  // sets it (spike/packs/index.mjs packList). See spike/packs/README.md.
  // true: no tool reaches a network.
  offline?: boolean
  // What the host fetches for a run: "github" (the scope's GitHub links),
  // "solc" (the compilers those files pin).
  fetches?: string[]
  // "open": a live run's scanners use the open bridge network.
  scanNet?: string
  // "github": a live grant names GitHub repos or orgs, not hosts.
  grants?: string
  // "cloud-http": one check also gets an HTTP replay on a private practice cloud.
  extraProof?: string
}

// One thing a module needs before it can run on a target (spike/lib/module-needs.mjs).
// `kind` says where the operator fixes it: "settings" (an RPC, a key) or "run"
// (the target's own chain and pinned block). The Modules page and the New run
// dialog both read this one list, so they cannot disagree.
export interface ModuleNeed {
  id: string
  label: string
  kind: "settings" | "run"
  met: boolean
  detail: string
}

// A target as the launcher offers it: a scope plus whether it can run right now.
export interface TargetChoice extends TargetScope {
  runnable: boolean
  // The unmet needs that make it unrunnable. Absent or empty when there are none.
  needs?: ModuleNeed[]
  // The unmet needs of each module on this target, keyed by module id. A target can
  // be runnable overall while one of its modules is not: a forked scope allows
  // Contracts (which reads the chain) and Review (which does not), so with no RPC
  // the target runs under Review and Contracts is the module that cannot start.
  needsByPack?: Record<string, ModuleNeed[]>
}

// The active inference gateway (NEAR / Boundless / Lyber) that new runs will
// drive. The app no longer shows it; the API still sends it.
export interface ProviderInfo {
  id: string
  label: string
}

// One raw event as the engine prints it. `ev` names the step; the rest varies.
export interface RunEvent {
  t?: number
  ev: string
  [k: string]: unknown
}

// ---- The streaming cognition / subagent / finding / steering vocabulary.
//
// This is the ONE source of truth for the live event names the engine emits and
// the reducer folds into RunState. The engine (spike/*) and the reducer
// (lib/runModel.ts) are both built against THIS list, so they match by
// construction. Fields a reducer reads are named here; the engine must emit them
// under the same keys.
//
//   scope            { scope: TargetScope }                        header target
//   opened           { mode: "run" | "decide" }                   session begins
//   static-scan      { suspects, engines[], top[] }               static pre-pass
//   fuzz-scan        { suspects, engines[], top[] }               fuzz pre-pass
//   prepass          PrepassView                                  tool scan summary
//   list_sources     {}                                           listed sources
//   read_source      { file }                                     read a file
//   brief            { text }                                     the scope brief the
//                                                                  agent got ("" = removed)
//   thinking-delta   { conv, attempt?, text }                     reasoning SNAPSHOT
//   assistant-delta  { conv, attempt?, text }                     prose SNAPSHOT
//   say              { conv, attempt?, text }                      finalized prose
//   artifact-open    { id, fileId?, title, kind, lang?,           a doc version opens
//                      attempt?, contract? }                      in the pane
//   artifact-delta   { id, text }                                 version content SNAPSHOT
//   artifact-done    { id }                                       version finished writing
//   run_poc          { attempt, contract }                        exploit attempt
//   run_poc-done     { contract, passed, failed?, timedOut? }     attempt resolves
//   run_poc-capped   { attempts }                                 attempt budget hit
//   subagent-spawned { id, parent?, area, title,                 child conversation
//                      name?, tier?, conv? }                      (fleet fields below)
//   subagent-done    { id, status, error? }                       child settles
//   agent-graph      { nodes: AgentNode[] }                       owner→child tree
//   agent-status     { id, state }                                fleet: child's lifecycle
//   agent-message    { id, from, to, text }                       fleet: one agent → another
//   bulletin-post    { id, author, text, kind?, severity?,        fleet: a Bulletin note
//                      tags?, lane? }
//   agent-spend      { id, usd }                                  fleet: child's spend SNAPSHOT
//   lead             { id, severity, file, line, title, reason,   a recorded lead with its
//                      proof?, agent? }                           evidence; never proven
//   finding-submitted { n, title, severity, poc }                 agent submits one of
//                                                                 many; audit goes on
//   submit-rejected  { poc, reason }                              not passed / duplicate
//   audit-continue   { found, left }                              nudge to keep auditing
//   finding          { id, runId?, title, severity, module?,      a recorded finding,
//                      target?, proven, poc?, stages? }           one per submission
//   artifact-open    (kind "proof") also carries findingId
//   steer-pending    { id, text }                                 operator steer queued
//   operator-message { id?, text }                                steer admitted to turn
//   steer-rejected   { id, reason? }                              steer dropped
//   approval-pending { id, title, severity, poc }                 legacy: one finding
//   host-deciding    { status }                                   legacy decide phase
//   approval-decided { status }                                   legacy gate settled
//   no-finding       { final }                                    agent's closing words
//   run-complete     { status, findingId? }                       run settled
//   closed           {}                                           stream ends
//
// ---- Fleet contract (multi-agent runs).
//
// One coordinator talks to the operator. It spawns child agents. Children work
// in parallel, message each other, and post to a shared Bulletin.
//
// 1. ANY event may carry `agent: <child id>`. It means "a child did this". No
//    `agent` field means the coordinator did it. Tool events (`read_source`,
//    `run_poc`, `artifact-open`, ...) and cognition deltas from a child MUST
//    carry it. A child's cognition deltas also carry the child's own `conv`.
// 2. `subagent-spawned` is emitted by the coordinator (no `agent` field).
//    `id` is the child id. Every later event about that child uses it.
//    `name` is the display name ("Recon-Alpha"). `title` is its task in one
//    line. `area` is the module or angle. `tier` is "T1" (trusted) or "T2"
//    (untrusted attacker worker). Missing `tier` means "T1".
// 3. `agent-status { id, state }` moves a child between "working" and "idle"
//    (waiting for a message). `subagent-done { id, status: "done"|"failed",
//    error? }` ends it. `error` is the plain failure text ("Provider returned
//    503"). A failed child adds an "agent-error" step to the main chat.
// 4. `agent-message { id, from, to, text }`: `from` and `to` are a child id or
//    "coordinator". `id` is unique per message. Emit it ONCE, from the sender.
//    The reducer shows the one step in both agents' threads, so its step key
//    is the shared jump target.
// 5. `bulletin-post { id, author, text, kind: "note"|"lead", severity?, tags?,
//    lane: "trusted"|"evidence" }`. `author` is a child id or "coordinator".
//    T2 authors post to "evidence" only. Nothing in "evidence" is trusted
//    until a replay proves it.
// 6. `agent-spend { id, usd }` is the child's cumulative spend so far. The
//    run's total spend stays where it is today.
//
// The main chat shows coordinator steps plus messages to or from the
// coordinator. A child's thread shows its own steps plus messages to or from
// it. See `threadSteps` in runModel.ts.
//
// `-delta` events carry the FULL current text each time (a throttled snapshot of
// the in-flight message), NOT an increment — the reducer REPLACES, keyed by
// (conv, attempt) for cognition and by id for an artifact, so a dropped tick
// never loses prose.

// What the agent is visibly doing right now, derived from the latest cognition
// event. Drives the live AgentStatus pill between the thread and the composer.
export type Activity = "thinking" | "working" | "typing" | "idle"

// One node in the owner→subagent tree (`agent-graph`). `area` is the module or
// angle the child owns ("Contracts", "re-entrancy"); `state` tracks its life.
export interface AgentNode {
  id: string
  parent: string | null
  area: string
  title: string
  state: "spawning" | "working" | "idle" | "done" | "failed"
  // Fleet fields. Older runs and plain subagents lack them.
  name?: string // display name, "Recon-Alpha"; falls back to title
  tier?: "T1" | "T2" // T2 = untrusted attacker worker
  conv?: string // the child's conversation id
  activity?: Activity // what the child is doing right now
  error?: string // why it failed, when state is "failed"
  spendUsd?: number | null // cumulative; null = unknown
  startedAt?: number | null
  endedAt?: number | null
  loadout?: "confined" | "free-roam"
  options?: ("wallet" | "email")[]
  model?: string
}

// The coordinator's id in `agent-message` and `bulletin-post`.
export const COORDINATOR = "coordinator"

// One note on the run's Bulletin. `lane: "evidence"` is the quarantined lane
// for T2 posts: it is never trusted until a replay proves it.
export interface BulletinNote {
  id: string
  author: string // child id or COORDINATOR
  t: number | null
  text: string
  kind: "note" | "lead"
  severity?: Severity
  tags: string[]
  lane: "trusted" | "evidence"
  stepKey: string // key of the event that posted it, for linking back
}

// One lead an agent recorded (Review's record_lead), with its evidence. A lead
// is not a finding: nothing marks it proven. `author` is a child id or
// COORDINATOR (the root agent, also a solo run's one agent).
export interface RunLead {
  id: string
  author: string
  t: number | null
  severity: Severity | null
  file: string
  line: number
  title: string
  reason: string
  proof: string | null
  stepKey: string
}

// One operator steer across its two-phase life. "pending" — typed, shown as a
// chip over the composer, not yet in the turn. "admitted" — the agent took it
// in; it now reads as a normal operator message. "rejected" — dropped unused.
export interface SteerEntry {
  id: string
  text: string
  state: "pending" | "admitted" | "rejected"
}

// One saved version of an artifact file — a single write the agent made. When
// the agent rewrites the same PoC across attempts, each rewrite lands as its own
// version of one file, so the operator sees v1, v2, v3 instead of a single card
// mutating in place. `artifact-delta` carries the FULL text each tick (a
// snapshot, like the cognition deltas), so the reducer REPLACES, keyed by the
// version id. `writing` stays true until this version's `artifact-done` lands.
// `attempt`/`contract` tie a PoC version to its run_poc attempt, so `state` can
// mark the one rewrite that actually passed its replay.
export interface ArtifactVersion {
  id: string
  text: string
  writing: boolean
  attempt?: number
  contract?: string
  state?: "running" | "pass" | "fail"
}

// A workspace document the agent writes while it works — the PoC contract it
// drafts, the replay trace it proves with. It streams into the artifact pane
// beside the chat instead of scrolling past in the transcript, so the operator
// reads the whole file as it is written. A file is version-controlled: each
// `artifact-open` for the same `id` (the file id) appends a new version, so
// rewriting the same PoC across attempts reads as v1/v2/v3 behind a switcher,
// not one card quietly changing under the operator. The pane opens a file and
// shows one selected version.
export type ArtifactKind = "poc" | "proof" | "source" | "report"

export interface ArtifactDoc {
  id: string // the stable file id; the pane opens a file by this
  title: string
  kind: ArtifactKind
  lang?: string
  versions: ArtifactVersion[]
  // A proof artifact names the recorded finding it proves, so each finding card
  // opens its own replay. Absent on old runs (one finding, one proof).
  findingId?: string
}

// A finding the agent submitted mid-audit. `n` is its order of submission.
// (The name is historical: findings used to wait on an approval gate.)
export interface PendingApproval {
  id: string
  title: string
  severity: Severity
  poc: string
  n?: number
  // The module the finding came through (the `finding-submitted` event).
  pack?: string
}

export interface RunView {
  id: string
  alias: string
  model: string
  // A label for back-compat; `scope` carries the structured target descriptor.
  target: string | null
  scope: TargetScope | null
  // Every module this ONE run covers. One entry for a one-module run and for a
  // record from before modules existed; the server always sends it.
  packs: string[]
  status: RunStatus
  startedAt: number
  events: RunEvent[]
  pending: PendingApproval | null
  decision: "approve" | "deny" | null
  findingId: string | null
  // Every finding the agent submitted, in order, and the recorded ids (worst
  // first) once the run settles.
  submitted?: PendingApproval[]
  findingIds?: string[]
  error: string | null
  // Archived runs are locked: they take no more messages.
  archived?: boolean
  // The operator's name for the run, or null.
  name?: string | null
  // A follow-up worker is answering an operator message right now.
  replying?: boolean
}

export type RoamOption = "wallet" | "email"
export interface RoamSelection { freeRoam: boolean; options: RoamOption[] }
export type AskAnswer = { ask: string; done: boolean } | { ask: string; reply: string }

export interface AskOption {
  id: string
  label: string
  description?: string
}
export type AskPresentation =
  | { options: AskOption[]; select: "single"; min?: never; max?: never }
  | { options: AskOption[]; select: "multiple"; min?: number; max?: number }
export function formatAskChoiceReply(presentation: AskPresentation, ids: readonly string[]) {
  const choices = presentation.options.filter((option) => ids.includes(option.id))
  const min = presentation.select === "single" ? 1 : presentation.min ?? 1
  const max = presentation.select === "single" ? 1 : presentation.max ?? presentation.options.length
  if (new Set(ids).size !== ids.length || choices.length !== ids.length || choices.length < min || choices.length > max) throw new Error("Choose the required number of options.")
  const reply = presentation.select === "single"
    ? `Selected option: ${choices[0].id} (${choices[0].label})`
    : `Selected options:\n${choices.map((option) => `- ${option.id} (${option.label})`).join("\n")}`
  if (reply.length > 4000) throw new Error("The selected answer exceeds 4,000 characters. Use a shorter free-text Reply.")
  return reply
}

const presentationEncoder = new TextEncoder()
const askObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)

// Saved events may predate server validation. Never turn malformed metadata into controls.
export function isAskPresentation(value: unknown): value is AskPresentation {
  if (!askObject(value) || Object.keys(value).some((k) => !["options", "select", "min", "max"].includes(k))) return false
  const options = value.options
  if (!Array.isArray(options) || options.length < 2 || options.length > 12 || (value.select !== "single" && value.select !== "multiple")) return false
  if (value.select === "single" && ("min" in value || "max" in value)) return false
  const min = value.min === undefined ? 1 : value.min, max = value.max === undefined ? options.length : value.max
  if (value.select === "multiple" && (typeof min !== "number" || typeof max !== "number" || !Number.isInteger(min) || !Number.isInteger(max) || min < 1 || min > max || max > options.length)) return false
  const seen = new Set<string>()
  for (const option of options) {
    if (!askObject(option) || Object.keys(option).some((k) => !["id", "label", "description"].includes(k))) return false
    if (typeof option.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(option.id) || seen.has(option.id)) return false
    if (typeof option.label !== "string" || !option.label.trim() || option.label.trim().length > 200 || ("description" in option && (typeof option.description !== "string" || option.description.length > 500))) return false
    seen.add(option.id)
  }
  try { return presentationEncoder.encode(JSON.stringify(value)).length <= 16384 }
  catch { return false }
}
export interface HumanAsk {
  id: string
  agent: string
  kind: string
  question: string
  detail?: string
  presentation?: AskPresentation
  t: number
  answer?: "done" | "cancel" | "reply"
  interrupted?: boolean
}
export type SandboxDesktopView = { kind: "closed" } | { kind: "open"; agent: string; url: string; expires: number; viewOnly: boolean }
export interface SessionArtifact {
  id: string
  kind: "transcript" | "har" | "screenshot"
  sha256: string
  bytes: number
  mime: string
  approval: "not-required" | "pending" | "released"
}
export interface SessionManifest {
  version: 1
  run: string
  agent: string
  sequence: number
  files: SessionArtifact[]
}

export interface RunSummary {
  id: string
  alias: string
  status: RunStatus
  startedAt: number
  title: string | null
  severity: Severity | null
  archived?: boolean
  // The operator's name for the run (POST /api/runs/:id/rename), or null.
  name?: string | null
  // The title of the scope the run attacks, for runs with no name or finding.
  scopeTitle?: string | null
  // The run's target headline (the list sends the scope's title, else none).
  target?: string | null
  // Every module the run covers, so a list row can name them all.
  packs?: string[]
  // How an error run ended (the server's errorInfo.kind). "cutoff" is a server
  // restart that cut the run off: it reads Interrupted, not failed.
  errorKind?: string | null
}

export type Verdict = "approve" | "deny"

// ---- Settings. API keys never come back from the server: only this state.
export interface KeyState {
  set: boolean
  source: "settings" | "env" | null
  envName?: string | null
  last4: string | null
  // Where the provider's env key may go (its built-in base URL), or null.
  envHome?: string | null
  // Why an env key is set but not used (the base URL is on another server).
  held?: string | null
}

export interface ProviderModel {
  alias: string
  id: string
  input: number
  output: number
  context: number | null
  priced: boolean
}

export interface ProviderSetting {
  id: string
  label: string
  baseUrl: string
  // The server cut a user name, password, query or #part from baseUrl.
  baseUrlHidden?: boolean
  builtIn: boolean
  saved: boolean
  key: KeyState
  models: ProviderModel[]
}

// One chain RPC for a forked replay. The URL itself never leaves the server: this
// is the chain, whether a URL is set, where it came from, and its last 4
// characters, the same rule the provider keys follow.
export interface RpcSetting {
  chain: string
  chainId: number
  envName: string
  set: boolean
  source: "settings" | "env" | null
  last4: string | null
  saved: boolean
}

export interface SettingsState {
  providers: ProviderSetting[]
  default: { provider: string; model: string | null }
  envOverride: string | null
  spend: SpendState
  fallbackPrice: { input: number; output: number }
  rpc: RpcSetting[]
}

export interface DiscoveredModel {
  id: string
  input: number | null
  output: number | null
  context: number | null
}

// One model row in the provider editor. Prices are USD per 1M tokens; an empty
// price means "unknown", and the server bills it at the fallback price.
export interface ModelDraft {
  id: string
  input: string
  output: string
  context: number | null
}

// ---- Module plan. One entry per pipeline step, from the `modules` event the
// engine emits at run start (spike/lib/modules.mjs). `fixed` steps cannot be
// turned off: the agent always runs, and the replay is always the gate. A step
// that is off says why in `reason`.
export interface ModulePlanEntry {
  id: string
  on: boolean
  available: boolean
  fixed: boolean
  reason: string | null
}
