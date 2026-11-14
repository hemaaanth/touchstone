import { test, expect } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { reduceEvents } from "../src/lib/runModel"
import { HumanQueue } from "../src/components/human-queue"
import { SessionEvidence } from "../src/components/session-evidence"
import { candidateFrom } from "../src/lib/candidate"
import { runStartBody } from "../src/lib/api"

const spawn = { ev: "subagent-spawned", id: "a-1", name: "Scout", loadout: "free-roam", model: "test-model", t: 1 }
const first = { ev: "ask-human", id: "one", agent: "a-1", kind: "login", question: "Open test account", t: 2 }
const second = { ...first, id: "two", agent: "a-2", question: "Check test wallet" }

test("one queue keeps exact ask identity across agents and removes only matched answers", () => {
  const state = reduceEvents([spawn, first, second, first, { ev: "ask-answered", id: "one", agent: "a-2", answer: "done" }])
  expect(state.humanAsks.filter((a) => !a.answer).map((a) => a.id)).toEqual(["one", "two"])
  const html = renderToStaticMarkup(<HumanQueue runId="r1" state={state} live />)
  expect(html).toContain("Open test account")
  expect(html).toContain("Check test wallet")
  expect(html).toContain("Keep passwords and codes in the browser")
  expect(html).toContain("Reply and Cancel do not approve it")
  const settled = reduceEvents([spawn, first, second, { ev: "ask-answered", id: "one", agent: "a-1", answer: "reply" }])
  for (const label of [">Watch<", ">Take control<", ">Release<"]) expect(html).not.toContain(label)
  expect(settled.humanAsks.filter((a) => !a.answer).map((a) => a.id)).toEqual(["two"])
})

test("closed, stopped, or restarted asks never become approvals on followup", () => {
  for (const marker of ["closed", "stop-requested", "phase-restarted"]) {
    const state = reduceEvents([first, { ev: marker }, { ev: "reply-start" }, { ...first, id: "fresh" }])
    expect(state.humanAsks[0]).toMatchObject({ answer: "cancel", interrupted: true })
    expect(state.humanAsks.filter((a) => !a.answer).map((a) => a.id)).toEqual(["fresh"])
  }
})

test("per-run options reach the start request without changing the selected model", () => {
  expect(runStartBody("alias", "scope", 5, ["web"], "fleet", { freeRoam: true, options: [] })).toMatchObject({ alias: "alias", targetId: "scope", mode: "fleet", freeRoam: true, options: [] })
})

test("session evidence remains unproven and does not embed screenshot or raw HAR", () => {
  const candidate = candidateFrom({ ev: "candidate-submitted", candidate: { poc: "session:a-1:1", title: "Session", proven: true, evidence: { kind: "session", agent: "a-1", artifacts: { version: 1, run: "r1", agent: "a-1", poc: "session:a-1:1", manifest: "m-1" } } } })!
  const html = renderToStaticMarkup(<SessionEvidence runId="r1" candidate={candidate} />)
  expect(candidate.proven).toBe(false)
  expect(html).toContain("Session · unproven")
  expect(html).toContain("Show session files")
  expect(html).not.toContain("<img")
  expect(html).not.toContain("href=")
})
