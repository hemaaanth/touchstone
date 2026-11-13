import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { reduceEvents } from "../src/lib/runModel"
import { candidateFrom, candidateGroupLabel } from "../src/lib/candidate"
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

// Review Minor 2: a proven finding takes the candidate's place. Delta review
// Minor 1: a finding that is only submitted (its proof may still fail) does not.
test("reduceEvents drops a candidate once it is superseded, not when its poc is only submitted", () => {
  const s = reduceEvents([
    ev(cand("a")),
    ev(cand("b")),
    ev(cand("c")),
    { t: 2, ev: "candidate-superseded", poc: "a", by: "other" },
    { t: 3, ev: "finding-submitted", n: 1, poc: "b", title: "submitted b", severity: "high" },
  ])
  expect(s.candidates.map((c) => c.poc)).toEqual(["b", "c"])
  expect(s.submitted.map((f) => f.poc)).toEqual(["b"])
})

// Review Minor 8: the chat drops note steps in phase "decide", so a candidate
// note is always a run-phase note.
test("a candidate sent during the decide pass keeps its chat note", () => {
  const s = reduceEvents([{ t: 0, ev: "opened", mode: "decide" }, ev(cand("a"))])
  const note = s.steps.find((x) => x.label.startsWith("Recorded a candidate"))
  expect(note?.phase).toBe("run")
})

// The chat folds notes in a row into one row. A row of candidate notes says
// what it holds, not "Recon & static analysis".
test("a run of candidate notes gets its own label, and any other run keeps main's", () => {
  const notes = reduceEvents([ev(cand("a")), ev(cand("b"))]).steps.filter((x) => x.kind === "note").map((x) => x.label)
  expect(candidateGroupLabel(notes)).toBe("Recorded 2 candidates (unproven, needs review)")
  expect(candidateGroupLabel([notes[0]])).toBeNull()
  expect(candidateGroupLabel([notes[0], "Read the static analyzer report"])).toBeNull()
})

describe("the Candidates group", () => {
  const c = candidateFrom(ev(cand("a")))!

  // docs/restraint.md: red only on a proven finding, green only after a
  // replay proved it. A candidate is neither, so it is neutral, with no accent.
  test("a row reads as needs review, unproven and agent-asserted, and is neutral", () => {
    const html = renderToStaticMarkup(<CandidateList items={[c]} />)
    expect(html).toContain("Needs review")
    expect(html).toContain("unproven / agent-asserted")
    expect(html).toContain('aria-label="Candidate, not proven"')
    for (const tone of ["text-ok", "text-bad", "text-warn", "bg-ok", "bg-bad", "bg-warn", "border-warn", "text-destructive", "text-red", "text-green", "text-amber"]) {
      expect([tone, html.includes(tone)]).toEqual([tone, false])
    }
    expect(html).not.toContain("Proven")
    expect(html).not.toContain("Why this isn")
  })

  test("the detail shows the why line, write-up, PoC and cited lines; the raw evidence is one fold deeper, closed", () => {
    const html = renderToStaticMarkup(<CandidateDetail candidate={c} />)
    expect(html).toContain("Why this isn&#x27;t proven: no check covers this class yet.")
    expect(html).toMatch(/<strong[^>]*>export<\/strong>/)
    expect(html).toContain("GET /admin/export/1 -&gt; 200")
    expect(html).toContain("/admin/export/1")
    expect(html).toContain("Evidence")
    expect(html).toContain("long hex values (a tx hash too) and any value after a secret-like label are shown as [REDACTED]")
    expect(html).not.toContain("&quot;kind&quot;: &quot;transcript&quot;")
    expect(html).not.toMatch(/text-(ok|bad|warn)/)
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
        width={360}
        onWidth={() => {}}
        initialWidth={360}
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
