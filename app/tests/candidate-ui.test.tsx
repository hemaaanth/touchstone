import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { reduceEvents } from "../src/lib/runModel"
import { candidateFrom } from "../src/lib/candidate"
import { CandidateDetail, CandidateList } from "../src/components/candidates"
import { RunPanel } from "../src/components/run-panel"
import type { RunEvent } from "../src/lib/types"

// Candidates in the run view: their own amber group, never mixed into the
// findings, and never shown as proven whatever the event says.
const EVIDENCE = { kind: "transcript", transcript: [{ method: "GET", path: "/admin/export/1", status: 200 }] }
const cand = (poc: string, extra: Record<string, unknown> = {}) => ({
  n: 1, pack: "web", title: `Export leaks rows (${poc})`, severity: "high", poc, evidence: EVIDENCE,
  explanation: "Anyone can **export** customer rows.\nFix: require an admin session.", cites: ["GET /admin/export/1 -> 200"],
  rootCause: "r1", kind: "candidate", assertedBy: "agent", proven: false, candidate: true, provedBy: null, ...extra,
})
const ev = (c: unknown, extra: Record<string, unknown> = {}): RunEvent => ({ t: 1, ev: "candidate-submitted", candidate: c, ...extra })

describe("candidateFrom", () => {
  test("forces the fixed fields, even when the event claims proof", () => {
    const c = candidateFrom(ev(cand("a", { proven: true, candidate: false, assertedBy: "oracle", provedBy: "oracle", kind: "finding" })))
    expect(c).toMatchObject({ proven: false, candidate: true, assertedBy: "agent", provedBy: null, kind: "candidate" })
    expect(c?.evidence).toEqual(EVIDENCE)
  })

  test("ignores other events and a candidate with no poc", () => {
    expect(candidateFrom({ ev: "finding-submitted", poc: "a" })).toBeNull()
    expect(candidateFrom(ev({ title: "no poc" }))).toBeNull()
  })
})

describe("reduceEvents", () => {
  const events: RunEvent[] = [
    { t: 0, ev: "status", status: "running" },
    ev(cand("a")),
    ev(cand("a", { title: "twin" })),
    ev(cand("b"), { agent: "child-1" }),
    { t: 2, ev: "status", status: "no-finding" },
  ]
  const s = reduceEvents(events)

  test("collects candidates in order, one per poc", () => {
    expect(s.candidates.map((c) => c.poc)).toEqual(["a", "b"])
  })

  test("a candidate is never a finding", () => {
    expect(s.findings).toEqual([])
    expect(s.submitted).toEqual([])
    expect(s.pending).toBeNull()
    expect(s.status).toBe("no-finding")
    expect(s.steps.some((x) => x.kind === "submitted")).toBe(false)
  })

  test("the transcript notes each candidate as unproven, tagged with its agent", () => {
    const notes = s.steps.filter((x) => x.label.startsWith("Recorded a candidate"))
    expect(notes.map((x) => x.label)).toEqual([
      "Recorded a candidate (unproven, needs review): Export leaks rows (a)",
      "Recorded a candidate (unproven, needs review): Export leaks rows (b)",
    ])
    expect(notes[1].agent).toBe("child-1")
  })
})

describe("the Candidates group", () => {
  const c = candidateFrom(ev(cand("a")))!

  test("a row reads as needs review, unproven and agent-asserted, in amber", () => {
    const html = renderToStaticMarkup(<CandidateList items={[c]} />)
    expect(html).toContain("Needs review")
    expect(html).toContain("unproven / agent-asserted")
    expect(html).toContain("text-warn")
    expect(html).not.toContain("text-ok")
    expect(html).not.toContain("Proven")
  })

  test("the detail shows the why line, write-up, PoC, cited lines and evidence", () => {
    const html = renderToStaticMarkup(<CandidateDetail candidate={c} />)
    expect(html).toContain("Why this isn&#x27;t proven: no check covers this class yet.")
    expect(html).toMatch(/<strong[^>]*>export<\/strong>/)
    expect(html).toContain("GET /admin/export/1 -&gt; 200")
    expect(html).toContain("/admin/export/1")
    expect(html).toContain("&quot;kind&quot;: &quot;transcript&quot;")
  })

  const panel = (events: RunEvent[]) =>
    renderToStaticMarkup(
      <RunPanel
        state={reduceEvents(events)}
        live={false}
        mode="solo"
        model="m"
        open
        onOpenChange={() => {}}
        section="candidates"
        onSection={() => {}}
        selectedAgent={null}
        onAgent={() => {}}
        openDoc={null}
        openVersion={null}
        onFile={() => {}}
      />,
    )

  test("the run panel shows the group apart from Findings, and counts no finding", () => {
    const html = panel([ev(cand("a")), { t: 2, ev: "status", status: "no-finding" }])
    expect(html).toContain("Candidates")
    expect(html).toContain("Findings &amp; Proofs")
    expect(html).toContain("0</span> findings")
    expect(html).toContain("1</span> candidate")
    expect(html.indexOf("Findings &amp; Proofs")).toBeLessThan(html.indexOf(">Candidates<"))
  })

  test("a run with no candidates shows no Candidates group", () => {
    expect(panel([{ t: 2, ev: "status", status: "no-finding" }])).not.toContain(">Candidates<")
  })
})
