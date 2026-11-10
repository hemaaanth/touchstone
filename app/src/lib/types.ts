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
  title: string
  severity: Severity
  module: string
  target: string
  stages: FindingStages
  proven: boolean
  dismissed: boolean
  ms: number | null
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

export interface Proof {
  tool: string
  compiler: string | null
  test: string | null
  contract: string | null
  gas: number | null
  pass: boolean
  runs: PocRun[]
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

export interface Finding extends FindingSummary {
  decision: string | null
  recorded: boolean
  proof: Proof
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

export interface SpendState {
  usd: number
  cap: number
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

export interface PendingApproval {
  id: string
  title: string
  severity: Severity
  poc: string
}

export interface RunView {
  id: string
  alias: string
  model: string
  target: string
  status: RunStatus
  startedAt: number
  events: RunEvent[]
  pending: PendingApproval | null
  decision: "approve" | "deny" | null
  findingId: string | null
  error: string | null
}

export interface RunSummary {
  id: string
  alias: string
  status: RunStatus
  startedAt: number
  title: string | null
  severity: Severity | null
}

export type Verdict = "approve" | "deny"
