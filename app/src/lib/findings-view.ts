import type { CandidateSummary, FindingSummary } from "./types"

// The Findings page's filter and sort (src/components/findings-page.tsx).
// Pure, so tests/findings-page.test.tsx checks them with 500 synthetic rows.

export type SortKey = "proven" | "severity" | "newest" | "oldest" | "scope"
export type StateFilter = "all" | "proven" | "unproven" | "candidate"
// A dismissed finding is hidden until the operator asks to see it.
export type DismissedFilter = "hide" | "show"
export interface FindingsView {
  q: string
  scope: string
  module: string
  severity: string
  state: StateFilter
  // Local days, "YYYY-MM-DD", or "" for no bound.
  from: string
  to: string
  sort: SortKey
  dismissed: DismissedFilter
}
export const ALL = "all"
export const DEFAULT_VIEW: FindingsView = { q: "", scope: ALL, module: ALL, severity: ALL, state: "all", from: "", to: "", sort: "proven", dismissed: "hide" }

export const SORTS: { value: SortKey; label: string }[] = [
  { value: "proven", label: "Proven first" },
  { value: "severity", label: "Severity" },
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "scope", label: "Scope" },
]
const RANK: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, informational: 1 }
const rank = (s: string | null | undefined) => RANK[(s ?? "").toLowerCase()] ?? 0

// The scope a row shows: the run's scope title, else the record's target.
export const scopeOf = (f: FindingSummary) => f.scope || f.target || "Unknown"
// The module id: the finding's own pack (server), else none.
export const moduleOf = (f: FindingSummary) => f.pack || ""
// The local day of a time, "YYYY-MM-DD", to compare with a date input.
export function dayOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

// ── The date filter as one range (the date-range picker) ───────────────────
// The view keeps two local days, "YYYY-MM-DD" or "" for no bound. The picker
// works with Dates. These convert both ways and name the range on its button.

// A local day as a Date at local midnight, or undefined for "" or a bad day.
export function parseDay(day: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return undefined
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : undefined
}
const dayOfDate = (d: Date | undefined) => (d ? dayOf(d.getTime()) : "")

export interface DayRange {
  from: Date | undefined
  to?: Date
}
// The view's two days as the picker's range; undefined when neither is set.
export function toDayRange(from: string, to: string): DayRange | undefined {
  const f = parseDay(from)
  const t = parseDay(to)
  return f || t ? { from: f, to: t } : undefined
}
// The picker's range as the view's two days. No range clears both.
export function fromDayRange(range: DayRange | undefined): { from: string; to: string } {
  return { from: dayOfDate(range?.from), to: dayOfDate(range?.to) }
}
// The button's text: "Any date", "Nov 1 – Nov 13", "From Nov 1", "Until Nov 13",
// one day as "Nov 13". A day outside `now`'s year carries its year.
export function rangeLabel(from: string, to: string, now = new Date()): string {
  const name = (d: Date) =>
    d.toLocaleDateString("en-US", d.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" })
  const f = parseDay(from)
  const t = parseDay(to)
  if (f && t) return from === to ? name(f) : `${name(f)} – ${name(t)}`
  if (f) return `From ${name(f)}`
  if (t) return `Until ${name(t)}`
  return "Any date"
}

export function isFiltered(v: FindingsView): boolean {
  return v.q.trim() !== "" || v.scope !== ALL || v.module !== ALL || v.severity !== ALL || v.state !== "all" || v.from !== "" || v.to !== ""
}

export function filterFindings(rows: FindingSummary[], v: FindingsView): FindingSummary[] {
  const q = v.q.trim().toLowerCase()
  return rows.filter((f) => {
    if (v.dismissed === "hide" && f.dismissed) return false
    if (q && !(f.title ?? "").toLowerCase().includes(q)) return false
    if (v.scope !== ALL && scopeOf(f) !== v.scope) return false
    if (v.module !== ALL && moduleOf(f) !== v.module) return false
    if (v.severity !== ALL && (f.severity ?? "").toLowerCase() !== v.severity) return false
    if (v.state === "proven" && !f.proven) return false
    // "Not proven" is a finding whose replay did not prove it; a candidate is
    // its own state (N3).
    if (v.state === "unproven" && (f.proven || f.candidate)) return false
    if (v.state === "candidate" && !f.candidate) return false
    if (v.from || v.to) {
      // A finding with no recorded time cannot be in a date range.
      if (f.at == null) return false
      const day = dayOf(f.at)
      if (v.from && day < v.from) return false
      if (v.to && day > v.to) return false
    }
    return true
  })
}

// Newest first; a finding with no time goes last.
const newest = (a: FindingSummary, b: FindingSummary) => (b.at ?? -Infinity) - (a.at ?? -Infinity)
const provenFirst = (a: FindingSummary, b: FindingSummary) => Number(b.proven) - Number(a.proven)
const bySeverity = (a: FindingSummary, b: FindingSummary) => rank(b.severity) - rank(a.severity)
const byDefault = (a: FindingSummary, b: FindingSummary) => provenFirst(a, b) || bySeverity(a, b) || newest(a, b)

// A dismissed finding sorts after every open one, whatever the sort.
const openFirst = (a: FindingSummary, b: FindingSummary) => Number(a.dismissed) - Number(b.dismissed)

export function sortFindings(rows: FindingSummary[], sort: SortKey): FindingSummary[] {
  const by =
    sort === "severity"
      ? (a: FindingSummary, b: FindingSummary) => bySeverity(a, b) || provenFirst(a, b) || newest(a, b)
      : sort === "newest"
        ? (a: FindingSummary, b: FindingSummary) => newest(a, b) || byDefault(a, b)
        : sort === "oldest"
          ? (a: FindingSummary, b: FindingSummary) => (a.at ?? Infinity) - (b.at ?? Infinity) || byDefault(a, b)
          : sort === "scope"
            ? (a: FindingSummary, b: FindingSummary) => scopeOf(a).localeCompare(scopeOf(b)) || byDefault(a, b)
            : byDefault
  return [...rows].sort((a, b) => openFirst(a, b) || by(a, b))
}

// The redaction cap (server/redact.mjs): a text over 64 KB is replaced whole by
// this mark. A copy that holds it says so.
export const TOO_LONG = /\[REDACTED: text of \d+ characters too long to check\]/

// "18 KB": a replay bundle's size, for its download button.
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// The replay bundle's one action word, in the row menu and the proof view.
export const BUNDLE_LABEL = "Download replay bundle"

// A finding has a replay bundle when a replay proved it and it is not an
// evidence finding: the server refuses a bundle for one, so the control would
// end in that refusal.
export function hasBundle(f: { stages: { proven: boolean }; proofKind?: string }): boolean {
  return f.stages.proven === true && f.proofKind !== "evidence"
}

// A candidate as a list row. It keeps its own fields under `candidate`, so the
// same filters and sorts work, and it is never proven (N3).
export function candidateRow(c: CandidateSummary): FindingSummary {
  return {
    id: c.id,
    runId: c.runId,
    title: c.title ?? "Candidate",
    severity: c.severity,
    module: c.module,
    target: c.target,
    stages: { hypothesis: false, reproduced: false, proven: false, accepted: false },
    proven: false,
    dismissed: false,
    ms: null,
    pack: c.pack,
    scope: c.scope,
    at: c.at,
    candidate: c,
  }
}

// The candidate's state words on its row.
export const CANDIDATE_STATE: Record<string, string> = {
  repeated: "Candidate · measurement repeated",
  "no-effect": "Candidate · no effect shown",
  "harm-not-judged": "Candidate · harm not judged",
  unknown: "Candidate · not proof of harm",
}
export const candidateState = (c: CandidateSummary) => (c.measured ? (CANDIDATE_STATE[c.measured.reason] ?? CANDIDATE_STATE.unknown) : "Candidate · needs review")
