// The streamed-session card: the native WebPreview chrome, our sandboxed frame,
// and the two operator buttons. Static markup, no browser.
import { test, expect } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { SessionCard } from "../src/components/run-thread"
import type { Step } from "../src/lib/runModel"

const step = (over: Partial<Step> = {}): Step => ({
  key: "session:1", kind: "session", label: "http://127.0.0.1:4500/#tok", state: "running", phase: "run",
  session: { url: "http://127.0.0.1:4500/#tok&parentOrigin=http%3A%2F%2Fconsole", viewOnly: true }, ...over,
})

test("the card frames the session with the preview chrome and its own sandbox", () => {
  const html = renderToStaticMarkup(<SessionCard step={step()} runId="r1" />)
  // The frame's chrome is the card's own now: no address bar repeating the
  // console's own host.
  expect(html).toContain("Starting the browser")
  expect(html).toContain('src="http://127.0.0.1:4500/#tok&amp;parentOrigin=')
  expect(html).toContain('sandbox="allow-scripts allow-same-origin allow-forms"')
  // The footer is icon-only; the accessible name carries the action.
  expect(html).toContain('aria-label="Take over"')
  expect(html).toContain('allow="fullscreen"')
  expect(html).toContain('aria-label="Open in a new tab"')
  expect(html).toContain("127.0.0.1:4500")
})

test("a handoff reads as needing the operator, and control flips the button", () => {
  const need = renderToStaticMarkup(<SessionCard step={step({ detail: "needs you", session: { url: "http://127.0.0.1:4500/#t", viewOnly: false } })} runId="r1" />)
  expect(need).toContain("the agent needs you")
  expect(need).toContain('aria-label="Back to view only"')
})

test("a paused card offers Resume agent", () => {
  const html = renderToStaticMarkup(<SessionCard step={step({ paused: true, detail: "paused · call cut" })} runId="r1" />)
  expect(html).toContain("agent paused")
  expect(html).toContain('aria-label="Resume agent"')
  expect(html).not.toContain("· paused · call cut")
})

test("a closed session keeps the header but drops the frame", () => {
  const html = renderToStaticMarkup(<SessionCard step={step({ state: "pass" })} runId="r1" />)
  expect(html).toContain("Watching the browser")
  expect(html).not.toContain("<iframe")
})

// A portal does not survive static markup, so this asserts the inline card only;
// the dialog itself is measured in a browser (see card-preview prompts).
test("the inline card keeps its controls and never renders the dialog markup", () => {
  const html = renderToStaticMarkup(<SessionCard step={step({ detail: "needs you" })} runId="r1" />)
  expect(html).toContain("Take over")
  expect(html).toContain('sandbox="allow-scripts allow-same-origin allow-forms"')
})
