// Candidates in the run record. A candidate is an agent-asserted, unproven
// record: the agent ran a real attempt and saw harm, but the pack's proof
// model does not cover it. It waits for human review.
//
// The engine emits one `candidate-submitted` event per candidate, with the
// whole record. The server keeps them on `run.candidates`, writes them to the
// run record as `result.candidates`, and reads them back from the saved event
// stream on reload. A candidate is never a finding: it is not in `submitted`,
// `pending`, `findingIds`, the run status or `result.findings`.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { isMeasured, makeCandidate, priorCandidate, splitMeasured, supersededBy } from "../../spike/lib/candidate.mjs"
import { redactSecrets } from "./redact.mjs"
import { sortFindings } from "../../spike/lib/record.mjs"

// The one shape the server stores and sends. makeCandidate sets the fixed
// fields, so no input can make a candidate proven, and cuts the evidence to
// size. Evidence the engine already cut comes through unchanged.
// The engine scrubs a candidate before it sends it, and no agent can write
// the event line. The free text still passes the server's own redactor, so
// the store stays masked if that ever changes. Masked text stays the same.
const masked = (v) => (typeof v === "string" ? redactSecrets(v) : v)
export const normalizeCandidate = (c) => {
  const x = c ?? {}
  return makeCandidate({ ...x, title: masked(x.title), explanation: masked(x.explanation), cites: Array.isArray(x.cites) ? x.cites.map(masked) : x.cites })
}

// The candidates in an event list, in submit order, one per poc, without
// the ones a later event ended.
export function candidatesOf(events) {
  const out = []
  for (const e of events ?? []) addCandidate(out, e)
  return out
}

// The one event that ends a candidate: a proven finding took its place. The
// engine sends it when a pack's finding is proven at submit; supersedeProven
// sends it after the final proof. A finding that is only submitted (a keys or
// chain-watch test that passed) does not end it: its proof may still fail.
const ENDS_CANDIDATE = ["candidate-superseded"]

// Apply one event to the list: add the candidate it carries if it is a new one,
// or drop the candidate it ends. Returns true if the list changed.
export function addCandidate(list, e) {
  if (ENDS_CANDIDATE.includes(e?.ev)) {
    const i = e.poc ? list.findIndex((x) => x.poc === e.poc) : -1
    if (i < 0) return false
    list.splice(i, 1)
    return true
  }
  if (e?.ev !== "candidate-submitted" || !e.candidate) return false
  const c = normalizeCandidate(e.candidate)
  if (list.some((x) => x.poc === c.poc)) return false
  list.push(c)
  return true
}

// Track one engine event on the live run.
export function trackCandidate(run, e) {
  run.candidates ??= []
  return addCandidate(run.candidates, e)
}

// After the final proof: end each candidate a proven finding takes the place
// of (same poc or root cause, pocProved: true). Call it before the record is
// written, so the record holds only the candidates that are left.
export function supersedeProven(run, findings, send) {
  for (const { poc, by } of supersededBy(run.candidates ?? [], findings)) {
    const e = { t: Date.now(), ev: "candidate-superseded", poc, by }
    trackCandidate(run, e)
    send(e)
  }
}

// What a follow-up worker gets, so its cap, numbering and guards count the
// candidates the run already holds. Only the agent's: a measured candidate is
// the engine's and never counts toward the agent's cap.
export function priorCandidatesEnv(run) {
  return JSON.stringify((run.candidates ?? []).filter((c) => c.origin !== "measured").map(priorCandidate))
}

// After the final proof: a finding whose replay only repeated a measurement
// leaves the findings and becomes a measured candidate (spike/lib/candidate.mjs
// splitMeasured). Each one is sent as a candidate-submitted event, so the run
// view, the saved stream and the record all hold it. Returns the findings left.
export function recordMeasured(run, findings, send) {
  const from = Math.max(0, ...(run.candidates ?? []).map((c) => Number(c.n) || 0))
  const split = splitMeasured(findings, { from })
  for (const candidate of split.candidates) {
    const e = { t: Date.now(), ev: "candidate-submitted", candidate }
    if (trackCandidate(run, e)) send(e)
  }
  dropMeasuredSubmitted(run)
  return split.findings
}

// The pocs of the findings that became measured candidates (their evidence
// lists each one it folds).
export function measuredPocs(candidates) {
  const out = new Set()
  for (const c of candidates ?? []) {
    if (c?.origin !== "measured") continue
    for (const item of c.evidence?.items ?? []) if (item?.poc != null) out.add(String(item.poc))
  }
  return out
}

// A submitted finding that became a measured candidate is no longer one of
// the run's findings: it leaves `submitted` (the sidebar count) and the
// headline is the worst finding left. Live, and when a saved run loads.
export function dropMeasuredSubmitted(run) {
  const gone = measuredPocs(run.candidates)
  if (!gone.size || !Array.isArray(run.submitted)) return
  run.submitted = run.submitted.filter((s) => !gone.has(String(s.poc)))
  run.pending = sortFindings(run.submitted)[0] ?? null
}

// The candidates field of the run record. A derived candidate (an older
// record's finding read as one, at load) is never written: the record keeps
// that row as a finding, and every read derives it again.
export const recordCandidates = (run) => (run.candidates ?? []).filter((c) => c?.derived !== true).map(normalizeCandidate)

// Write the run's candidates into an existing run record, leaving every
// other field as it is. Returns false if there is no record yet. The write
// goes to a temp file, then a rename, so a crash never leaves half a record
// (the same pattern as bug/run-durability's persistRun).
export function writeCandidates(file, run) {
  if (!existsSync(file)) return false
  const rec = JSON.parse(readFileSync(file, "utf8"))
  rec.result = { ...(rec.result ?? {}), candidates: recordCandidates(run) }
  writeFileSync(`${file}.tmp`, JSON.stringify(rec, null, 2))
  renameSync(`${file}.tmp`, file)
  return true
}

// For an older run with no saved stream: the candidate events its record
// holds that the engine events do not already have.
export function candidateEvents(result, have, t) {
  const seen = candidatesOf(have)
  return (result?.candidates ?? [])
    .map(normalizeCandidate)
    .filter((c) => !seen.some((x) => x.poc === c.poc))
    .map((candidate) => ({ t, ev: "candidate-submitted", candidate }))
}

// The rows of a run record, each with its ledger id: `<run>.<k>`, or the run
// id for an older record with one finding (splitRun in findings.mjs).
export function recordRows(id, result) {
  const r = result ?? {}
  if (Array.isArray(r.findings) && r.findings.length) return r.findings.map((f, k) => ({ id: `${id}.${k + 1}`, finding: f }))
  if (r.finding) return [{ id, finding: { ...r.finding, pocProved: r.pocProved, proof: r.proof } }]
  return []
}

// The measured candidates an older record's findings read as (N3). The
// record keeps them as findings; nothing rewrites it. Numbered after `from`.
export function measuredOfRecord(id, result, from = 0) {
  const rows = recordRows(id, result).filter((x) => isMeasured(x.finding))
  const candidates = splitMeasured(rows.map((x) => x.finding), { from }).candidates.map((c) => makeCandidate({ ...c, derived: true }))
  return { ids: new Set(rows.map((x) => x.id)), candidates }
}

// At load, in memory only: an older record's finding that only repeated a
// measurement is shown as a measured candidate. Its `finding` event and its
// proof file leave the loaded events, its id leaves the status lines, and a
// candidate-submitted event takes its place. A run left with no finding reads
// "no-finding". The stream file and the record stay as they are.
export function measuredAtLoad(id, events, result) {
  const have = candidatesOf(events)
  const { ids, candidates } = measuredOfRecord(id, result, Math.max(0, ...have.map((c) => Number(c.n) || 0)))
  if (!ids.size) return
  const known = new Set(have.map((c) => c.poc))
  const at = events.findIndex((e) => e.ev === "finding" && ids.has(String(e.id)))
  const t = events[at]?.t ?? events.at(-1)?.t ?? Date.now()
  const proofs = new Set([...ids].map((x) => `proof-${x}`))
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if ((e.ev === "finding" && ids.has(String(e.id))) || (String(e.ev).startsWith("artifact-") && proofs.has(String(e.id)))) events.splice(i, 1)
    else if (e.ev === "status" && Array.isArray(e.findingIds)) {
      const left = e.findingIds.filter((x) => !ids.has(String(x)))
      events[i] = { ...e, findingIds: left, ...(e.findingId != null && ids.has(String(e.findingId)) ? { findingId: left[0] ?? null } : {}) }
    }
  }
  const added = candidates.filter((c) => !known.has(c.poc)).map((candidate) => ({ t, ev: "candidate-submitted", candidate }))
  events.splice(at >= 0 ? Math.min(at, events.length) : events.length, 0, ...added)
  const last = events.findLastIndex((e) => e.ev === "status")
  if (last >= 0 && events[last].status === "recorded" && !events.some((e) => e.ev === "finding")) {
    events[last] = { ...events[last], status: "no-finding", decision: null, findingId: null, findingIds: [] }
  }
}
