import type { FindingSummary } from "./types"

// The Findings page's filter and sort (src/components/findings-page.tsx).
// Pure, so tests/findings-page.test.tsx checks them with 500 synthetic rows.

export type SortKey = "proven" | "severity" | "newest" | "oldest" | "scope"
export type StateFilter = "all" | "proven" | "unproven"
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
}
export const ALL = "all"
export const DEFAULT_VIEW: FindingsView = { q: "", scope: ALL, module: ALL, severity: ALL, state: "all", from: "", to: "", sort: "proven" }

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

export function isFiltered(v: FindingsView): boolean {
  return v.q.trim() !== "" || v.scope !== ALL || v.module !== ALL || v.severity !== ALL || v.state !== "all" || v.from !== "" || v.to !== ""
}

export function filterFindings(rows: FindingSummary[], v: FindingsView): FindingSummary[] {
  const q = v.q.trim().toLowerCase()
  return rows.filter((f) => {
    if (q && !(f.title ?? "").toLowerCase().includes(q)) return false
    if (v.scope !== ALL && scopeOf(f) !== v.scope) return false
    if (v.module !== ALL && moduleOf(f) !== v.module) return false
    if (v.severity !== ALL && (f.severity ?? "").toLowerCase() !== v.severity) return false
    if (v.state === "proven" && !f.proven) return false
    if (v.state === "unproven" && f.proven) return false
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

export function sortFindings(rows: FindingSummary[], sort: SortKey): FindingSummary[] {
  const cmp =
    sort === "severity"
      ? (a: FindingSummary, b: FindingSummary) => bySeverity(a, b) || provenFirst(a, b) || newest(a, b)
      : sort === "newest"
        ? (a: FindingSummary, b: FindingSummary) => newest(a, b) || byDefault(a, b)
        : sort === "oldest"
          ? (a: FindingSummary, b: FindingSummary) => (a.at ?? Infinity) - (b.at ?? Infinity) || byDefault(a, b)
          : sort === "scope"
            ? (a: FindingSummary, b: FindingSummary) => scopeOf(a).localeCompare(scopeOf(b)) || byDefault(a, b)
            : byDefault
  return [...rows].sort(cmp)
}

// The redaction cap (server/redact.mjs): a text over 64 KB is replaced whole by
// this mark. A copy that holds it says so.
export const TOO_LONG = /\[REDACTED: text of \d+ characters too long to check\]/
