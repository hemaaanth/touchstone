import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { candidateRow, candidateState, DEFAULT_VIEW, filterFindings, sortFindings } from "../src/lib/findings-view"
import { CandidateListRow } from "../src/components/candidate-row"
import { FINDING_ROW_COLS } from "../src/components/findings-page"
import type { CandidateSummary, FindingSummary } from "../src/lib/types"

// N3: candidates on the Findings page. They share the findings' row grid and
// filters, but they are their own state, neutral, and never proven.
const finding = (id: string, proven: boolean): FindingSummary => ({
  id, runId: "r1", title: `Finding ${id}`, severity: "high", module: "Web", target: "Lab", proven, dismissed: false, ms: null,
  stages: { hypothesis: true, reproduced: true, proven, accepted: false }, pack: "web", scope: "Lab", at: 1,
})
const cand = (id: string, extra: Partial<CandidateSummary> = {}): CandidateSummary => ({
  id, runId: "r2", kind: "candidate", title: "The Content-Security-Policy allows unsafe sources", severity: "low", module: "Domains", pack: "domains",
  target: "My site", scope: "My site", at: 2, origin: "measured", proven: false,
  measured: { reason: "repeated", words: "Measurement repeated: the replay found the same fact again. It shows no harm.", count: 3, check: "weak-csp" }, ...extra,
})
const rows = [finding("a", true), finding("b", false), candidateRow(cand("r2.c1")), candidateRow(cand("r2.c2", { origin: "agent", measured: null }))]

describe("the state filter", () => {
  test("Candidate shows candidates only; Proven and Not proven show findings only; Any state shows all", () => {
    const ids = (state: typeof DEFAULT_VIEW.state) => filterFindings(rows, { ...DEFAULT_VIEW, state }).map((f) => f.id)
    expect(ids("candidate")).toEqual(["r2.c1", "r2.c2"])
    expect(ids("proven")).toEqual(["a"])
    expect(ids("unproven")).toEqual(["b"])
    expect(ids("all")).toEqual(["a", "b", "r2.c1", "r2.c2"])
  })

  test("a candidate row is never proven, and sorts after proven findings", () => {
    for (const r of rows.slice(2)) {
      expect(r.proven).toBe(false)
      expect(r.stages.proven).toBe(false)
    }
    expect(sortFindings(rows, "proven")[0].id).toBe("a")
  })
})

describe("the candidate row", () => {
  const html = (c: CandidateSummary) =>
    renderToStaticMarkup(<CandidateListRow finding={candidateRow(c)} cols={FINDING_ROW_COLS} moduleTitle="Domains" run={undefined} onOpenRun={() => {}} />)

  test("says its state in words, in the findings' grid, neutral", () => {
    const out = html(cand("r2.c1"))
    expect(out).toContain("Candidate · measurement repeated")
    expect(out).toContain("3 places")
    expect(out).toContain(FINDING_ROW_COLS.split(" ")[1])
    expect(out).not.toContain("Proven")
    for (const tone of ["text-ok", "text-bad", "text-warn", "bg-ok", "bg-bad"]) expect([tone, out.includes(tone)]).toEqual([tone, false])
    expect(candidateState(cand("x", { origin: "agent", measured: null }))).toBe("Candidate · needs review")
    expect(candidateState(cand("x", { measured: { reason: "harm-not-judged", words: "", count: 1, check: null } }))).toBe("Candidate · harm not judged")
  })
})

describe("the candidate row's module slot (N2 follow-up)", () => {
  test("is the module dot in the same box as the finding row, with the row's ring colour", () => {
    const out = renderToStaticMarkup(<CandidateListRow finding={candidateRow(cand("r2.c1"))} cols={`${FINDING_ROW_COLS} [--module-dots-ring:var(--card)]`} moduleTitle="Domains" run={undefined} onOpenRun={() => {}} />)
    expect(out).toContain('data-slot="module-dots"')
    expect(out).toContain("[--module-dots-ring:var(--card)]")
    expect(out).not.toContain('data-slot="module-pill"')
  })
})
