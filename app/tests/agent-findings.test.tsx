import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { agentFindingFrom, candidateFrom } from "../src/lib/candidate"
import { reduceEvents } from "../src/lib/runModel"
import { CandidateDetail } from "../src/components/candidates"
import { RunPanel } from "../src/components/run-panel"
import { CandidateListRow } from "../src/components/candidate-row"
import { filterFindings, countLine, DEFAULT_VIEW } from "../src/lib/findings-view"
import { runHeadStatus } from "../src/components/thread-model"
// @ts-expect-error — server module is plain JavaScript
import { listFindings, listCandidates } from "../server/findings.mjs"
// @ts-expect-error — shared fixture is plain JavaScript
import { REPORT } from "../../spike/test/helpers/agent-report.mjs"
import type { RunEvent } from "../src/lib/types"

const finding = { n: 1, pack: "web", poc: "attempt-1", title: "Private export lacks authorization", severity: "high", explanation: "A synthetic unauthenticated request returned customer records. Fix: enforce authorization.", cites: ["GET /private/export -> 200 customer records"], report: REPORT, evidence: { kind: "transcript", text: "GET /private/export -> 200 customer records" }, proven: true, provedBy: "forged oracle", candidate: true }
const event: RunEvent = { t: 1, ev: "agent-finding-submitted", finding }

test("an agent finding keeps its report and can never claim deterministic verification", () => {
  const f = agentFindingFrom(event)!
  expect(f.kind).toBe("agent-finding")
  expect(f.proven).toBe(false)
  expect(f.provedBy).toBeNull()
  expect(f.candidate).toBe(false)
  const state = reduceEvents([event, event, { t: 2, ev: "status", status: "reported" }, { t: 3, ev: "closed" }])
  expect(state.agentFindings).toHaveLength(1)
  expect(state.candidates).toHaveLength(0)
  expect(state.findings).toHaveLength(0)
  const html = renderToStaticMarkup(<CandidateDetail candidate={f} />)
  for (const label of ["Reproduction steps", "Attacker capability", "Observed result", "Harm", "Limitations", "has not independently verified"]) expect(html).toContain(label)
  expect(html).not.toContain("no check covers this class yet")
  expect(runHeadStatus(state, "reported")).toEqual({ word: "Reported", tone: "neutral" })
  expect(agentFindingFrom({ ...event, finding: { ...finding, report: { harm: "spam exists" } } })).toBeNull()
})

test("ideas appear above findings, and agent reports count as findings instead of candidates", () => {
  const state = reduceEvents([{ t: 0, ev: "candidate-submitted", candidate: { ...finding, poc: "spam-observation", title: "Existing spam posts", report: undefined } }, event])
  expect(state.candidates).toHaveLength(1)
  expect(candidateFrom({ t: 0, ev: "candidate-submitted", candidate: finding })?.kind).toBe("candidate")
  const html = renderToStaticMarkup(<RunPanel state={state} live={false} mode="solo" model="m" open onOpenChange={() => {}} section="findings" onSection={() => {}} selectedAgent={null} onAgent={() => {}} openDoc={null} openVersion={null} onFile={() => {}} width={420} onWidth={() => {}} initialWidth={420} />)
  expect(html.indexOf(">Candidates<")).toBeLessThan(html.indexOf("Findings &amp; Proofs"))
  expect(html).toContain("Agent-evidenced · unverified")
  expect(html).toContain("1</span> finding")
  expect(html).toContain("1</span> candidate")
  expect(html).not.toContain("text-green")
  expect(html).not.toContain("No findings yet.")
})

test("the saved Findings list includes reports as unverified findings, not candidates or proof exports", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-finding-list-"))
  const old = process.env.TOUCHSTONE_RESULTS_DIR
  process.env.TOUCHSTONE_RESULTS_DIR = dir
  try {
    writeFileSync(join(dir, "run-demo.json"), JSON.stringify({ result: { outcome: "reported", pack: "web", target: { title: "Synthetic demo" }, findings: [], candidates: [{ ...finding, poc: "spam-observation", report: undefined }], agentFindings: [finding] } }))
    const rows = await listFindings()
    expect(rows).toHaveLength(1)
    expect(rows[0].agentFinding.kind).toBe("agent-finding")
    expect(rows[0].proven).toBe(false)
    expect(await listCandidates()).toHaveLength(1)
    expect(filterFindings(rows, { ...DEFAULT_VIEW, state: "unproven" })).toHaveLength(1)
    expect(filterFindings(rows, { ...DEFAULT_VIEW, state: "proven" })).toHaveLength(0)
    expect(filterFindings(rows, { ...DEFAULT_VIEW, state: "candidate" })).toHaveLength(0)
    expect(countLine(rows, rows, DEFAULT_VIEW).lead).toBe("1 finding")
    const html = renderToStaticMarkup(<CandidateListRow finding={rows[0]} cols="grid" moduleTitle="Web" run={undefined} onOpenRun={() => {}} />)
    expect(html).toContain("Finding · agent-evidenced · unverified")
    expect(html).not.toContain("Candidate · needs review")
  } finally {
    if (old === undefined) delete process.env.TOUCHSTONE_RESULTS_DIR
    else process.env.TOUCHSTONE_RESULTS_DIR = old
    rmSync(dir, { recursive: true, force: true })
  }
})
