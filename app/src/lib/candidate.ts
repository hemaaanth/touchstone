import type { RunEvent, Severity } from "./types"

// Why a measured candidate is not proven (spike/lib/proof-class.mjs), with
// the pins a reviewer can check.
export type MeasuredReason = "repeated" | "no-effect" | "harm-not-judged" | "unknown"
export interface Measured {
  reason: MeasuredReason
  words: string
  repeated: boolean
  check: string | null
  rule: string | null
  snapshotHash: string | null
  oracle: string | null
  count: number
}

// A candidate is never a finding and never counts as one. Two origins:
// - "agent": the agent ran a real attempt and saw harm, but the pack's proof
//   model does not cover it (submit_candidate). It waits for human review.
// - "measured": the engine's replay only repeated a measurement (a setting, a
//   missing record, a scanner grade), so the finding it was is not proven.
export interface Candidate {
  n: number
  pack: string
  title: string
  severity: Severity
  poc: string
  // The captured evidence: a transcript, a forge trace or a snapshot slice.
  evidence: unknown
  explanation: string
  cites: string[]
  rootCause: string | null
  origin: "agent" | "measured"
  measured: Measured | null
  kind: "candidate"
  assertedBy: "agent" | "engine"
  proven: false
  candidate: true
  provedBy: null
}

export const WHY_UNPROVEN = "Why this isn't proven: no check covers this class yet."
// A candidate keeps agent prose and raw traces, so its scrub is stricter than
// a report's (spike/lib/candidate.mjs). This line says why a hash is gone.
export const MASK_NOTE = "In a candidate, long hex values (a tx hash too) and any value after a secret-like label are shown as [REDACTED]."

// The chat note for each candidate, and the label of a run of such notes. The
// chat folds a run of notes into one row; without its own label that row
// would read "Recon & static analysis".
export const CANDIDATE_NOTE = "Recorded a candidate (unproven, needs review)"
// The short state of a measured candidate, for its row and its chat note.
export const MEASURED_SHORT: Record<MeasuredReason, string> = {
  repeated: "Measurement repeated",
  "no-effect": "No effect shown",
  "harm-not-judged": "Harm not judged",
  unknown: "Not proof of harm",
}
export const measuredNote = (m: Measured) => `Recorded as a candidate (${MEASURED_SHORT[m.reason].toLowerCase()})`
const NOTE_PREFIXES = [`${CANDIDATE_NOTE}: `, "Recorded as a candidate ("]
// One true label per kind: the agent's candidates wait for review; measured
// ones are unproven facts; a mixed run of notes says both.
export function candidateGroupLabel(labels: string[]): string | null {
  if (labels.length < 2 || !labels.every((l) => NOTE_PREFIXES.some((p) => l.startsWith(p)))) return null
  const agent = labels.filter((l) => l.startsWith(NOTE_PREFIXES[0])).length
  const tail = agent === labels.length ? "unproven, needs review" : agent === 0 ? "unproven" : "unproven, some need review"
  return `Recorded ${labels.length} candidates (${tail})`
}

const SEVERITIES = ["critical", "high", "medium", "low", "informational"]
const str = (v: unknown) => (typeof v === "string" ? v : "")
const REASONS: MeasuredReason[] = ["repeated", "no-effect", "harm-not-judged", "unknown"]
const WORDS: Record<MeasuredReason, string> = {
  repeated: "Measurement repeated: the replay found the same fact again. It shows no harm.",
  "no-effect": "The replay matched, but it shows no effect on the target.",
  "harm-not-judged": "Harm not judged: recorded before the harm check.",
  unknown: "Unknown proof kind: not counted as proof of harm.",
}

// The measured block of an event's candidate. The words come from the reason,
// never from the event, so no event can say more than its reason.
function measuredFrom(v: unknown): Measured {
  const m = v && typeof v === "object" ? (v as Record<string, unknown>) : {}
  const reason = (REASONS.includes(str(m.reason) as MeasuredReason) ? str(m.reason) : "unknown") as MeasuredReason
  return {
    reason,
    words: WORDS[reason],
    repeated: m.repeated === true,
    check: str(m.check) || null,
    rule: str(m.rule) || null,
    snapshotHash: /^[0-9a-f]{64}$/.test(str(m.snapshotHash)) ? str(m.snapshotHash) : null,
    oracle: str(m.oracle) || null,
    count: Math.max(1, Number(m.count) || 1),
  }
}

// The pocs of the submitted findings a measured candidate folds.
export function measuredPocs(c: Candidate): string[] {
  if (c.origin !== "measured") return []
  const items = (c.evidence as { items?: unknown } | null)?.items
  return Array.isArray(items) ? items.map((i) => str((i as { poc?: unknown })?.poc)).filter(Boolean) : []
}

// The candidate a `candidate-submitted` event carries, or null. The fixed
// fields are set here, so no event can make a candidate look proven.
export function candidateFrom(e: RunEvent): Candidate | null {
  if (e.ev !== "candidate-submitted" || !e.candidate || typeof e.candidate !== "object") return null
  const c = e.candidate as Record<string, unknown>
  const poc = str(c.poc)
  if (!poc) return null
  return {
    n: typeof c.n === "number" ? c.n : 1,
    pack: str(c.pack),
    title: str(c.title) || "Candidate",
    severity: (SEVERITIES.includes(str(c.severity)) ? str(c.severity) : "medium") as Severity,
    poc,
    evidence: c.evidence ?? null,
    explanation: str(c.explanation),
    cites: Array.isArray(c.cites) ? c.cites.map(String) : [],
    rootCause: str(c.rootCause) || null,
    origin: c.origin === "measured" ? "measured" : "agent",
    measured: c.origin === "measured" ? measuredFrom(c.measured) : null,
    kind: "candidate",
    assertedBy: c.origin === "measured" ? "engine" : "agent",
    proven: false,
    candidate: true,
    provedBy: null,
  }
}

// The Candidates section's short state: one true word for the list. The
// agent's candidates wait for review; measured ones are unproven facts.
export function candidatesStatus(items: Candidate[]): string {
  if (!items.length) return ""
  const measured = items.filter((c) => c.measured).length
  if (measured === 0) return "Needs review"
  if (measured === items.length) return "Unproven"
  return "Unproven · some need review"
}

// ── Landing on a candidate (N3, M2) ─────────────────────────────────────────
// The focus form for a candidate: the Findings page opens a run at it.
export const CANDIDATE_FOCUS = "candidate:"
// How long a candidate the run landed on stays marked.
export const MARK_MS = 2400

// The run view, once a candidate focus finds its candidate: the panel opens
// at its Candidates section and is told which row to open.
export function applyCandidateFocus(
  set: { panelOpen: (open: boolean) => void; section: (s: "candidates") => void; candidateOpen: (v: { poc: string; at: number }) => void },
  poc: string,
  at: number,
): void {
  set.panelOpen(true)
  set.section("candidates")
  set.candidateOpen({ poc, at })
}

// The row, on a new focus: open and marked. Null when the focus is not new.
export function rowFocusStep(focusAt: number | null, seen: number | null): { seen: number; open: true; marked: true } | null {
  return focusAt != null && focusAt !== seen ? { seen: focusAt, open: true, marked: true } : null
}

// After the row opened: scroll it into view at once, and clear its mark after
// MARK_MS. Returns the cleanup. `timers` is injectable for a test.
export function scheduleRowFocus(
  act: { scroll: () => void; unmark: () => void },
  timers: { set: (f: () => void, ms: number) => unknown; clear: (t: unknown) => void } = {
    set: (f, ms) => setTimeout(f, ms),
    clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  },
): () => void {
  const t0 = timers.set(act.scroll, 0)
  const t1 = timers.set(act.unmark, MARK_MS)
  return () => {
    timers.clear(t0)
    timers.clear(t1)
  }
}
