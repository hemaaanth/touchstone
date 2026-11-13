import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { reduceEvents } from "../src/lib/runModel"
import { candidateFrom, candidateGroupLabel } from "../src/lib/candidate"
import { runHeadStatus } from "../src/components/thread-model"
import { statusLabel, statusTone } from "../src/lib/format"
import { CandidateDetail, CandidateList } from "../src/components/candidates"
import { RunPanel } from "../src/components/run-panel"
import type { RunEvent } from "../src/lib/types"

// Candidates in the run view: their own neutral group, never mixed into the
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

// N3, test (c): a run whose only results are measured candidates ends
// "no-finding". Its status word is neither "Proven" nor an error, and its tone is neutral.
test("a run of measured candidates only reads as No finding, neutral", () => {
  const measured = { ...cand("m1"), origin: "measured", assertedBy: "engine", measured: { reason: "repeated", words: "Measurement repeated: the replay found the same fact again. It shows no harm.", repeated: true } }
  const state = reduceEvents([ev(measured), { t: 3, ev: "status", status: "no-finding" }])
  expect(state.candidates.length).toBe(1)
  const head = runHeadStatus(state, "no-finding")
  expect(head.word).not.toBe("Proven")
  expect(head.tone).toBe("neutral")
  expect(statusLabel("no-finding")).not.toBe("Proven")
  expect(statusTone("no-finding")).toBe("neutral")
})

// N3: a measured candidate (the engine's replay only repeated a measurement).
const HASH = "ab".repeat(32)
const measured = (extra: Record<string, unknown> = {}) => cand("measured:web:weak-csp", {
  title: "The Content-Security-Policy allows unsafe sources", severity: "low", origin: "measured", assertedBy: "engine",
  measured: { reason: "repeated", words: "made-up words from the event", repeated: true, check: "weak-csp", snapshotHash: HASH, count: 2 },
  evidence: { kind: "measured", check: "weak-csp", items: [{ poc: "l1", title: "weak-csp", where: { host: "a.test" } }, { poc: "l2", title: "weak-csp", where: { host: "b.test" } }] },
  explanation: "The snapshot shows weak-csp.", cites: [], ...extra,
})
const submittedEv = (poc: string, n: number): RunEvent => ({ t: 1, ev: "finding-submitted", n, title: "weak-csp", severity: "low", poc })

describe("a measured candidate in the run view (N3)", () => {
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

  test("candidateFrom reads its origin; its words come from the reason, never from the event", () => {
    const c = candidateFrom(ev(measured({ proven: true, provedBy: "oracle" })))!
    expect(c).toMatchObject({ origin: "measured", assertedBy: "engine", proven: false, provedBy: null })
    expect(c.measured).toMatchObject({ reason: "repeated", repeated: true, check: "weak-csp", snapshotHash: HASH, count: 2 })
    expect(c.measured!.words).toBe("Measurement repeated: the replay found the same fact again. It shows no harm.")
    expect(candidateFrom(ev(measured({ measured: { reason: "made-up" } })))!.measured!.reason).toBe("unknown")
    // An agent candidate stays the agent's, whatever it says.
    expect(candidateFrom(ev(cand("a", { assertedBy: "engine" })))).toMatchObject({ origin: "agent", assertedBy: "agent", measured: null })
  })

  test("the findings it folds leave the submitted list; their chat cards become neutral notes", () => {
    const s = reduceEvents([submittedEv("l1", 1), submittedEv("l2", 2), submittedEv("real", 3), ev(measured())])
    expect(s.submitted.map((f) => f.poc)).toEqual(["real"])
    expect(s.pending?.poc).toBe("real")
    expect(s.candidates.map((c) => c.origin)).toEqual(["measured"])
    expect(s.steps.filter((x) => x.kind === "submitted").map((x) => x.finding?.poc)).toEqual(["real"])
    expect(s.steps.filter((x) => x.kind === "note").map((x) => x.label)).toEqual([
      "Recorded as a candidate (measurement repeated): weak-csp",
      "Recorded as a candidate (measurement repeated): weak-csp",
    ])
    expect(candidateGroupLabel(s.steps.filter((x) => x.kind === "note").map((x) => x.label))).toBe("Recorded 2 candidates (unproven, needs review)")
    // With no submitted card to replace (an older run), one note says it.
    const alone = reduceEvents([ev(measured())])
    expect(alone.steps.map((x) => x.label)).toEqual(["Recorded as a candidate (measurement repeated): The Content-Security-Policy allows unsafe sources"])
  })

  test("its row says why it is not proven, neutral; its fold shows the places and the pin", () => {
    const c = candidateFrom(ev(measured()))!
    const row = renderToStaticMarkup(<CandidateList items={[c]} />)
    expect(row).toContain("Measurement repeated")
    expect(row).toContain("2 places")
    expect(row).toContain("unproven / measured")
    expect(row).not.toContain("Needs review")
    for (const tone of ["text-ok", "text-bad", "text-warn", "bg-ok", "bg-bad", "bg-warn"]) expect([tone, row.includes(tone)]).toEqual([tone, false])
    const fold = renderToStaticMarkup(<CandidateDetail candidate={c} />)
    expect(fold).toContain("Measurement repeated: the replay found the same fact again. It shows no harm.")
    expect(fold).toContain("Fired at 2 places")
    expect(fold).toContain("a.test")
    expect(fold).toContain(`sha256 ${HASH.slice(0, 16)}`)
    expect(fold).not.toContain("Why this isn")
    expect(fold).not.toContain(">PoC<")
    const old = candidateFrom(ev(measured({ measured: { reason: "harm-not-judged", count: 1 } })))!
    expect(renderToStaticMarkup(<CandidateList items={[old]} />)).toContain("Harm not judged")
  })

  test("the panel counts no finding for it: Findings & Proofs 0, Candidates 1", () => {
    const html = panel([submittedEv("l1", 1), submittedEv("l2", 2), ev(measured()), { t: 2, ev: "status", status: "no-finding" }])
    expect(html).toContain("0</span> findings")
    expect(html).toContain("1</span> candidate")
  })
})
