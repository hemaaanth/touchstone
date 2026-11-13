import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// Candidates in the run record: the server keeps the engine's record as it is,
// forces the fixed fields, and never mixes a candidate into the findings.
// @ts-expect-error — plain .mjs module, no types
const { normalizeCandidate, candidatesOf, trackCandidate, priorCandidatesEnv, recordCandidates, writeCandidates, candidateEvents, supersedeProven } = await import("../server/candidates.mjs")

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

// Review round 1: a forged event with clear text is stored masked. The values
// are fake, built from pieces.
describe("the server's own scrub of a candidate's free text", () => {
  const tok = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "c2lnbmF0dXJlLXZhbHVl"].join(".")
  const gh = ["gh", "p_", "a1B2c3D4e5F6g7H8i9J0", "k1L2m3N4o5P6q7R8"].join("")
  const pw = ["hunter2", "-correct-", "horse"].join("")
  test("title, write-up and cited lines are masked; the rest is kept", () => {
    const forged = candidate("f", {
      title: `Leak of DB_PASSWORD=${pw}`,
      explanation: `curl -H "Authorization: Bearer ${tok}" /admin\nFix: rotate.`,
      cites: [`token ${gh} in the log`, "GET /admin/export/1 -> 200"],
    })
    for (const c of [normalizeCandidate(forged), candidatesOf([ev(forged)])[0]]) {
      const json = JSON.stringify(c)
      for (const secret of [tok, gh, pw]) expect(json.includes(secret)).toBe(false)
      expect(c.title).toBe("Leak of DB_PASSWORD=[REDACTED]")
      expect(c.cites[1]).toBe("GET /admin/export/1 -> 200")
      expect(c.proven).toBe(false)
      expect(normalizeCandidate(c)).toEqual(c)
    }
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
  // Delta review Minor 1: a finding that is only submitted does not.
  test("a superseded candidate is dropped; one whose poc is only submitted as a finding stays", () => {
    const list = candidatesOf([
      ev(candidate("a")),
      ev(candidate("b")),
      ev(candidate("c")),
      { t: 2, ev: "candidate-superseded", poc: "a", by: "other" },
      { t: 3, ev: "finding-submitted", poc: "b", title: "submitted b" },
      { t: 4, ev: "approval-pending", poc: "c", title: "old-format c" },
    ])
    expect(list.map((c: { poc: string }) => c.poc)).toEqual(["b", "c"])
    const run: { candidates?: { poc: string }[] } = {}
    trackCandidate(run, ev(candidate("a")))
    trackCandidate(run, ev(candidate("b")))
    expect(trackCandidate(run, { ev: "candidate-superseded", poc: "a" })).toBe(true)
    expect(trackCandidate(run, { ev: "finding-submitted", poc: "b" })).toBe(false)
    expect(recordCandidates(run).map((c: { poc: string }) => c.poc)).toEqual(["b"])
  })

  // Delta review Minor 1: after the final proof, only a finding with
  // pocProved: true (and a passing harm check) takes a candidate's place.
  test("supersedeProven ends a candidate only for a proven finding, and says so in an event", () => {
    const run: { candidates?: { poc: string }[] } = {}
    for (const p of ["k1", "k2", "k3", "k4"]) trackCandidate(run, ev(candidate(p)))
    const sent: { ev: string; poc: string; by: string }[] = []
    supersedeProven(run, [
      { poc: "k1", pocProved: true, proof: { kind: "forge", pass: true, harm: { ok: true } } },
      { poc: "k2", pocProved: false, proof: { kind: "forge", pass: true, harm: { ok: false, reason: "no ETH left the target" } } },
      { poc: "k3", pocProved: true, proof: { kind: "forge", pass: true, harm: { ok: false } } },
      { poc: "other", rootCause: "root-k4", pocProved: true, proof: { kind: "forge", pass: true, harm: { ok: true } } },
    ], (e: { ev: string; poc: string; by: string }) => sent.push(e))
    expect(sent.map((e) => [e.ev, e.poc, e.by])).toEqual([["candidate-superseded", "k1", "k1"], ["candidate-superseded", "k4", "other"]])
    expect(recordCandidates(run).map((c: { poc: string }) => c.poc)).toEqual(["k2", "k3"])
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

  // Review Minor 5: a crash mid-write must not leave half a record.
  test("writeCandidates replaces the record whole, through a temp file and a rename", () => {
    const file = path.join(dir, "run-atomic.json")
    writeFileSync(file, JSON.stringify({ result: { findings: [] } }))
    const before = statSync(file).ino
    expect(writeCandidates(file, { candidates: [candidate("a")] })).toBe(true)
    expect(statSync(file).ino).not.toBe(before)
    expect(existsSync(`${file}.tmp`)).toBe(false)
    expect(JSON.parse(readFileSync(file, "utf8")).result.candidates.length).toBe(1)
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
