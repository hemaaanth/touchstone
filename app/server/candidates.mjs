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
import { makeCandidate, priorCandidate, supersededBy } from "../../spike/lib/candidate.mjs"

// The one shape the server stores and sends. makeCandidate sets the fixed
// fields, so no input can make a candidate proven, and cuts the evidence to
// size. Evidence the engine already cut comes through unchanged.
export const normalizeCandidate = (c) => makeCandidate(c ?? {})

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
// candidates the run already holds.
export function priorCandidatesEnv(run) {
  return JSON.stringify((run.candidates ?? []).map(priorCandidate))
}

// The candidates field of the run record.
export const recordCandidates = (run) => (run.candidates ?? []).map(normalizeCandidate)

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
