// Candidates in the run record. A candidate is an agent-asserted, unproven
// record: the agent ran a real attempt and saw harm, but the pack's proof
// model does not cover it. It waits for human review.
//
// The engine emits one `candidate-submitted` event per candidate, with the
// whole record. The server keeps them on `run.candidates`, writes them to the
// run record as `result.candidates`, and reads them back from the saved event
// stream on reload. A candidate is never a finding: it is not in `submitted`,
// `pending`, `findingIds`, the run status or `result.findings`.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { makeCandidate, priorCandidate } from "../../spike/lib/candidate.mjs"

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

// Events that end a candidate: the engine superseded it, or a finding was
// proven for its poc. A run never shows a candidate beside its finding.
const ENDS_CANDIDATE = ["candidate-superseded", "finding-submitted", "approval-pending"]

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

// What a follow-up worker gets, so its cap, numbering and guards count the
// candidates the run already holds.
export function priorCandidatesEnv(run) {
  return JSON.stringify((run.candidates ?? []).map(priorCandidate))
}

// The candidates field of the run record.
export const recordCandidates = (run) => (run.candidates ?? []).map(normalizeCandidate)

// Write the run's candidates into an existing run record, leaving every
// other field as it is. Returns false if there is no record yet.
export function writeCandidates(file, run) {
  if (!existsSync(file)) return false
  const rec = JSON.parse(readFileSync(file, "utf8"))
  rec.result = { ...(rec.result ?? {}), candidates: recordCandidates(run) }
  writeFileSync(file, JSON.stringify(rec, null, 2))
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
