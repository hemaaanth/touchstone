import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// Candidates in the run record: the server keeps the engine's record as it is,
// forces the fixed fields, and never mixes a candidate into the findings.
// @ts-expect-error — plain .mjs module, no types
const { normalizeCandidate, candidatesOf, trackCandidate, priorCandidatesEnv, recordCandidates, writeCandidates, candidateEvents } = await import("../server/candidates.mjs")

const dir = mkdtempSync(path.join(tmpdir(), "candidates-test-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const EVIDENCE = { kind: "transcript", transcript: [{ method: "GET", path: "/admin/export/1", status: 200 }], note: "[cut 12 entries]" }
const candidate = (poc: string, extra: Record<string, unknown> = {}) => ({
  n: 1, pack: "web", title: `Export leaks rows (${poc})`, severity: "high", poc, evidence: EVIDENCE,
  explanation: "Anyone can export customer rows.\nFix: require an admin session.", cites: ["GET /admin/export/1 -> 200"], rootCause: `root-${poc}`, evidenceHash: "h1",
  kind: "candidate", assertedBy: "agent", proven: false, candidate: true, provedBy: null, ...extra,
})
const ev = (c: unknown) => ({ t: 1, ev: "candidate-submitted", candidate: c })

describe("normalizeCandidate", () => {
  test("forces the fixed fields, even when the input claims proof", () => {
    const c = normalizeCandidate(candidate("a", { proven: true, candidate: false, assertedBy: "checker", provedBy: "oracle", kind: "finding" }))
    expect(c.proven).toBe(false)
    expect(c.candidate).toBe(true)
    expect(c.assertedBy).toBe("agent")
    expect(c.provedBy).toBeNull()
    expect(c.kind).toBe("candidate")
  })

  test("keeps the evidence exactly as the engine cut it", () => {
    expect(normalizeCandidate(candidate("a")).evidence).toEqual(EVIDENCE)
  })

  // Review Minor 4: a forged or old event cannot put huge evidence in the record.
  test("cuts evidence that is too large, and leaves evidence the engine already cut as it is", () => {
    const huge = { body: "x".repeat(1_000_000), rows: Array.from({ length: 5000 }, (_, i) => i) }
    const once = normalizeCandidate(candidate("a", { evidence: huge })).evidence
    expect(once.body).toMatch(/\[cut 996000 chars\]$/)
    expect(once.rows.length).toBe(61)
    expect(normalizeCandidate(candidate("a", { evidence: once })).evidence).toEqual(once)
    const wide = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`k${i}`, "y".repeat(3000)]))
    const cut = normalizeCandidate(candidate("a", { evidence: wide })).evidence
    expect(cut.cut).toBe(true)
    expect(JSON.stringify(cut).length).toBeLessThan(100_000)
    expect(normalizeCandidate(candidate("a", { evidence: cut })).evidence).toEqual(cut)
  })
})

describe("candidatesOf and trackCandidate", () => {
  test("read only candidate events, one per poc, in submit order", () => {
    const list = candidatesOf([
      { t: 1, ev: "finding-submitted", poc: "x", title: "real finding" },
      ev(candidate("a")),
      ev(candidate("b")),
      ev(candidate("a", { title: "twin" })),
      { t: 2, ev: "candidate-submitted" },
    ])
    expect(list.map((c: { poc: string }) => c.poc)).toEqual(["a", "b"])
  })

  test("a live run gains each new candidate once and nothing else", () => {
    const run: { candidates?: unknown[]; submitted: unknown[]; findingIds: unknown[] } = { submitted: [], findingIds: [] }
    expect(trackCandidate(run, ev(candidate("a")))).toBe(true)
    expect(trackCandidate(run, ev(candidate("a")))).toBe(false)
    expect(trackCandidate(run, { ev: "finding-submitted", poc: "x" })).toBe(false)
    expect(run.candidates?.length).toBe(1)
    expect(run.submitted).toEqual([])
    expect(run.findingIds).toEqual([])
    expect(JSON.parse(priorCandidatesEnv(run))).toEqual([{ n: 1, title: "Export leaks rows (a)", severity: "high", poc: "a", rootCause: "root-a", evidenceHash: "h1" }])
  })

  // Review Minor 2: a proven finding takes the candidate's place.
  test("a superseded candidate, or one whose poc is now a finding, is dropped", () => {
    const list = candidatesOf([
      ev(candidate("a")),
      ev(candidate("b")),
      ev(candidate("c")),
      { t: 2, ev: "candidate-superseded", poc: "a", by: "other" },
      { t: 3, ev: "finding-submitted", poc: "b", title: "proven b" },
    ])
    expect(list.map((c: { poc: string }) => c.poc)).toEqual(["c"])
    const run: { candidates?: { poc: string }[] } = {}
    trackCandidate(run, ev(candidate("a")))
    trackCandidate(run, ev(candidate("b")))
    expect(trackCandidate(run, { ev: "candidate-superseded", poc: "a" })).toBe(true)
    expect(trackCandidate(run, { ev: "finding-submitted", poc: "b" })).toBe(true)
    expect(run.candidates).toEqual([])
    expect(recordCandidates(run)).toEqual([])
  })
})

describe("the run record", () => {
  test("writeCandidates adds the candidates and leaves the findings alone", () => {
    const file = path.join(dir, "run-a.json")
    const finding = { title: "proven", severity: "high", poc: "PoC", proven: true }
    writeFileSync(file, JSON.stringify({ result: { findings: [finding], outcome: "recorded" } }))
    expect(writeCandidates(file, { candidates: [candidate("a")] })).toBe(true)
    const { result } = JSON.parse(readFileSync(file, "utf8"))
    expect(result.findings).toEqual([finding])
    expect(result.outcome).toBe("recorded")
    expect(result.candidates.length).toBe(1)
    expect(result.candidates[0].evidence).toEqual(EVIDENCE)
    expect(result.candidates[0].proven).toBe(false)
  })

  test("writeCandidates does nothing when there is no record yet", () => {
    expect(writeCandidates(path.join(dir, "missing.json"), { candidates: [candidate("a")] })).toBe(false)
  })

  test("a record with no candidates writes an empty list", () => {
    expect(recordCandidates({})).toEqual([])
  })

  test("an older record gives back the candidate events the stream lacks", () => {
    const have = [ev(candidate("a"))]
    const out = candidateEvents({ candidates: [candidate("a"), candidate("b", { proven: true })] }, have, 9)
    expect(out.length).toBe(1)
    expect(out[0]).toMatchObject({ t: 9, ev: "candidate-submitted" })
    expect(out[0].candidate.poc).toBe("b")
    expect(out[0].candidate.proven).toBe(false)
    expect(out[0].candidate.evidence).toEqual(EVIDENCE)
  })
})
