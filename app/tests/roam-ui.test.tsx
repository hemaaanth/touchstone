import { test, expect } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { reduceEvents } from "../src/lib/runModel"
import { HumanQueue } from "../src/components/human-queue"
import { SessionEvidence } from "../src/components/session-evidence"
import { candidateFrom } from "../src/lib/candidate"
import { runStartBody } from "../src/lib/api"
import { OptionList } from "../src/components/assistant-ui/elements/option-list"
import { formatAskChoiceReply, isAskPresentation, type AskPresentation } from "../src/lib/types"

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

const options = [{ id: "scan", label: "Scan source", description: "Inspect the source first" }, { id: "test", label: "Run tests" }, { id: "review", label: "Review results" }]
const single: AskPresentation = { options, select: "single" }
const multiple: AskPresentation = { options, select: "multiple", min: 2, max: 2 }

test("old Ask events keep free-text Reply, Done and Cancel with no option controls", () => {
  const state = reduceEvents([spawn, first])
  expect(state.humanAsks[0].presentation).toBeUndefined()
  const html = renderToStaticMarkup(<HumanQueue runId="r1" state={state} live />)
  expect(html).toContain('aria-label="Reply to Scout"')
  expect(html).toContain(">Reply</button>")
  expect(html).toContain(">Done</button>")
  expect(html).toContain(">Cancel</button>")
  expect(html).not.toContain('data-slot="option-list"')
})

test("single option renders beside free text and formats only a Reply, never Done", () => {
  const state = reduceEvents([spawn, { ...first, kind: "question", presentation: single }])
  expect(state.humanAsks[0].presentation).toEqual(single)
  const html = renderToStaticMarkup(<HumanQueue runId="r1" state={state} live />)
  expect(html).toContain('data-slot="option-list"')
  expect(html).toContain('aria-label="Scan source"')
  expect(html).toContain("Inspect the source first")
  expect(html).toContain('aria-label="Reply to Scout"')
  expect(html).toContain(">Reply</button>")
  expect(html).toContain("Replies are visible to the agent")
  expect(html).toContain("Do not include secrets")
  expect(html).not.toContain(">Done</button>")
  expect(formatAskChoiceReply(single, ["test"])).toBe("Selected option: test (Run tests)")
  for (const ids of [[], ["scan", "test"], ["unknown"], ["scan", "scan"]]) expect(() => formatAskChoiceReply(single, ids)).toThrow()
})

test("multiple choice enforces min/max and emits option order rather than click order", () => {
  const html = renderToStaticMarkup(<OptionList aria-label="Checks" options={options} selectionMode="multiple" minSelections={2} maxSelections={2} onConfirm={() => {}} />)
  expect(html).toContain('role="checkbox"')
  expect(html).toContain('aria-checked="false"')
  expect(html).toMatch(/<button[^>]*disabled[^>]*>Confirm choices<\/button>/)
  expect(formatAskChoiceReply(multiple, ["review", "scan"])).toBe("Selected options:\n- scan (Scan source)\n- review (Review results)")
  for (const ids of [[], ["scan"], ["scan", "test", "review"], ["scan", "scan"], ["scan", "unknown"]]) expect(() => formatAskChoiceReply(multiple, ids)).toThrow()
  expect(formatAskChoiceReply({ options, select: "multiple" }, ["test"])).toBe("Selected options:\n- test (Run tests)")
})

test("overlong formatted answers refuse without truncation", () => {
  const long = { options: [{ id: "long", label: "x".repeat(4000) }], select: "single" } satisfies AskPresentation
  expect(() => formatAskChoiceReply(long, ["long"])).toThrow("4,000")
})

test("malformed saved presentation is ignored; long option content remains escaped and wrappable", () => {
  for (const presentation of [
    { options, select: "other" }, { options, select: "single", min: 1 },
    { options, select: "multiple", min: null }, { options, select: "multiple", max: null },
    { options: [{ id: "same", label: "A" }, { id: "same", label: "B" }], select: "single" },
    { options: [{ id: "missing" }], select: "single" },
    { options, select: "single", extra: true }, { options, select: { toString: "single" } },
  ]) {
    expect(isAskPresentation(presentation)).toBe(false)
    const state = reduceEvents([{ ...first, kind: "question", presentation }])
    expect(state.humanAsks[0].presentation).toBeUndefined()
    expect(renderToStaticMarkup(<HumanQueue runId="r1" state={state} live />)).not.toContain('data-slot="option-list"')
  }
  const action = reduceEvents([{ ...first, presentation: single }])
  expect(action.humanAsks[0].presentation).toBeUndefined()
  const long = [{ id: "long", label: `<script>${"unbroken".repeat(20)}`, description: "long description ".repeat(20) }, options[1]]
  const html = renderToStaticMarkup(<OptionList aria-label="Long choices" options={long} disabled onConfirm={() => {}} />)
  expect(html).not.toContain("<script>")
  expect(html).toContain("&lt;script&gt;")
  expect(html).toContain("overflow-wrap:anywhere")
  expect(html).toContain('aria-label="Long choices"')
  expect(html).toMatch(/<button[^>]*disabled/)
})
