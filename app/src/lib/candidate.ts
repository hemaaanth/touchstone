import type { RunEvent, Severity } from "./types"

// A candidate: the agent ran a real attempt and saw harm, but the pack's proof
// model does not cover it. It is unproven and agent-asserted, and it waits for
// human review. It is never a finding and never counts as one.
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
  kind: "candidate"
  assertedBy: "agent"
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
export function candidateGroupLabel(labels: string[]): string | null {
  if (labels.length < 2 || !labels.every((l) => l.startsWith(`${CANDIDATE_NOTE}: `))) return null
  return `Recorded ${labels.length} candidates (unproven, needs review)`
}

const SEVERITIES = ["critical", "high", "medium", "low", "informational"]
const str = (v: unknown) => (typeof v === "string" ? v : "")

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
    kind: "candidate",
    assertedBy: "agent",
    proven: false,
    candidate: true,
    provedBy: null,
  }
}
