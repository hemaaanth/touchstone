import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { candidateRow, candidateShortState, candidateState, countLine, DEFAULT_VIEW, filterFindings, sortFindings } from "../src/lib/findings-view"
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
  target: "My site", scope: "My site", at: 2, poc: `poc-${id}`, origin: "measured", proven: false,
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

// Repair 1 (UI review m3, m4, m7, M2).
describe("the candidate row, repair 1", () => {
  const render = (c: CandidateSummary, extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(<CandidateListRow finding={candidateRow(c)} cols={FINDING_ROW_COLS} moduleTitle="Domains" run={{ id: "r2" } as never} onOpenRun={() => {}} {...extra} />)

  test("m7: its severity bars are never drawn in the proven tone, even for a critical one", () => {
    const out = render(cand("x", { severity: "critical" }))
    for (const tone of ["text-ok", "text-warn", "text-bad"]) expect([tone, out.includes(tone)]).toEqual([tone, false])
  })

  test("m3: its title opens the run, so it says nothing about a dialog", () => {
    const out = render(cand("x"))
    expect(out).toContain("data-row-main")
    expect(out).not.toContain(`aria-haspopup="dialog"`)
  })

  test("m4: it shows the run's date, as a finding row does", () => {
    expect(render(cand("x", { at: 5 }), { when: () => "13 Nov, 12:00" })).toContain("13 Nov, 12:00")
    expect(render(cand("x", { at: null }))).toContain("Date not recorded")
  })

  test("M2: opening it opens its run with the candidate's focus", () => {
    const calls: unknown[][] = []
    const row = CandidateListRow as unknown as { type: (p: Record<string, unknown>) => { props: { onClick: () => void } } }
    const el = row.type({ finding: candidateRow(cand("x", { poc: "lead-7" })), cols: FINDING_ROW_COLS, moduleTitle: "Domains", run: { id: "r2" }, onOpenRun: (...a: unknown[]) => calls.push(a) })
    el.props.onClick()
    expect(calls).toEqual([["r2", "candidate:lead-7"]])
  })
})

// m7: the count line counts findings and candidates apart.
describe("the count line", () => {
  test("N findings never includes a candidate; the Candidate filter counts candidates", () => {
    const line = (state: typeof DEFAULT_VIEW.state) => {
      const v = { ...DEFAULT_VIEW, state }
      return countLine(rows, filterFindings(rows, v), v)
    }
    expect(line("all")).toEqual({ lead: "2 findings", candidates: "2 candidates" })
    expect(line("candidate")).toEqual({ lead: "2 of 2 candidates", candidates: null })
    expect(line("proven")).toEqual({ lead: "1 of 2 findings", candidates: null })
    const one = [finding("a", true)]
    expect(countLine(one, one, DEFAULT_VIEW)).toEqual({ lead: "1 finding", candidates: null })
  })
})

// Repair 2 (UI re-review M3): the phone row (below sm) keeps a short state
// word that never shrinks, and shows no date, so nothing runs under the
// severity bars. It regressed once (the m4 date), so its classes are pinned.
describe("the candidate row on a phone", () => {
  const out = renderToStaticMarkup(<CandidateListRow finding={candidateRow(cand("x", { at: 5 }))} cols={FINDING_ROW_COLS} moduleTitle="Domains" run={undefined} onOpenRun={() => {}} when={() => "13 Nov, 12:00"} />)
  test("the state is one short word that never shrinks below sm; the full words from sm up", () => {
    expect(out).toMatch(/data-slot="candidate-state" class="[^"]*\bshrink-0\b[^"]*\bsm:shrink\b/)
    // Both kinds read "Candidate" on a phone: no word suggests a fourth tier.
    expect(out).toMatch(/<span class="whitespace-nowrap sm:hidden">Candidate<\/span>/)
    expect(out).not.toContain(">Measured<")
    expect(out).toContain('title="Candidate · measurement repeated"')
    expect(out).toMatch(/<span class="hidden min-w-0 truncate sm:inline">Candidate · measurement repeated<\/span>/)
    expect(candidateShortState(cand("x", { origin: "agent", measured: null }))).toBe("Candidate")
  })
  test("a part hidden below sm takes its dot with it: no stray dot on a phone", () => {
    const row = renderToStaticMarkup(<CandidateListRow finding={candidateRow(cand("x", { at: 5 }))} cols={FINDING_ROW_COLS} moduleTitle="Domains" run={undefined} onOpenRun={() => {}} when={() => "13 Nov, 12:00"} />)
    for (const slot of ["candidate-count", "candidate-date"]) {
      expect(row).toMatch(new RegExp(`data-slot="${slot}" class="[^"]*max-sm:hidden[^"]*"[^>]*><span aria-hidden="true" class="shrink-0 opacity-60">·</span>`))
    }
    // Three dots in all, two of them inside the parts a phone hides: one shows.
    const meta = row.slice(row.indexOf('data-slot="candidate-meta"'), row.indexOf('data-col="severity"'))
    expect((meta.match(/opacity-60">·</g) ?? []).length).toBe(3)
  })

  test("the date and the places count are hidden below sm", () => {
    expect(out).toMatch(/data-slot="candidate-date" class="[^"]*\bmax-sm:hidden\b/)
    expect(out).toMatch(/data-slot="candidate-count" class="[^"]*\bmax-sm:hidden\b/)
    expect(out).toContain("13 Nov, 12:00")
  })
})
