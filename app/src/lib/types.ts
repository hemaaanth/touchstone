// The shapes the API serves. Every field is derived from a real recorded
// engine run; see server/findings.mjs.

export type Severity = "critical" | "high" | "medium" | "low"

// "auto" — recorded automatically on a passing replay. "dismissed" — the
// operator later marked it not a finding they count (the proof still stands).
export type AcceptedState = boolean | "auto" | "dismissed"

export interface FindingStages {
  hypothesis: boolean
  reproduced: boolean
  proven: boolean
  accepted: AcceptedState
}

export interface FindingSummary {
  id: string
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

// Total spent across all runs, and the default budget for one run.
export interface SpendState {
  usd: number
  budgetUsd: number
}

// Where a finding for a target may be proven WITHOUT real-world harm. "kind"
// names the surface ("sandbox-foundry" today); "note" is the human sentence the
// UI shows so the operator can see a run can never touch live funds.
export interface ProofSurface {
  kind: string
  note: string
}

// One scope from the target library. `kind` is lab | local-source | brief;
// `signal` names the submodule expected to surface the lead first (static /
// fuzz / agent) — descriptive, never the thing that makes a finding real.
export interface TargetScope {
  id: string
  title: string
  kind: "lab" | "local-source" | "brief"
  // The module (pack) this scope belongs to. Absent on a record saved before modules.
  pack?: string
  blurb: string
  entry: string
  files?: string[]
  links?: string[]
  signal: string
  proofSurface: ProofSurface
}

// A module the New run dialog offers: one pack from the engine's loader.
export interface PackChoice {
  id: string
  title: string
  tier?: string
  proof: string
}

// A target as the launcher offers it: a scope plus whether it can run right now.
export interface TargetChoice extends TargetScope {
  runnable: boolean
}

// The active inference gateway (NEAR / Boundless / Lyber), so the UI can label
// the spend meter with whichever provider a run will actually drive.
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
//   list_sources     {}                                           listed sources
//   read_source      { file }                                     read a file
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
//   subagent-spawned { id, parent?, area, title }                 child conversation
//   subagent-done    { id, status }                               child settles
//   agent-graph      { nodes: AgentNode[] }                       owner→child tree
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
  state: "spawning" | "working" | "done" | "failed"
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
}

export interface RunView {
  id: string
  alias: string
  model: string
  // A label for back-compat; `scope` carries the structured target descriptor.
  target: string | null
  scope: TargetScope | null
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
  // A follow-up worker is answering an operator message right now.
  replying?: boolean
}

export interface RunSummary {
  id: string
  alias: string
  status: RunStatus
  startedAt: number
  title: string | null
  severity: Severity | null
  archived?: boolean
}

export type Verdict = "approve" | "deny"

// ---- Settings. API keys never come back from the server: only this state.
export interface KeyState {
  set: boolean
  source: "settings" | "env" | null
  envName?: string | null
  last4: string | null
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
  builtIn: boolean
  saved: boolean
  key: KeyState
  models: ProviderModel[]
}

export interface SettingsState {
  providers: ProviderSetting[]
  default: { provider: string; model: string | null }
  envOverride: string | null
  spend: SpendState
  fallbackPrice: { input: number; output: number }
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
