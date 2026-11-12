import { describe, expect, test } from "bun:test"
import { explanationSections } from "../src/lib/explanation"
import { reduceEvents } from "../src/lib/runModel"

// explanationSections returns a kind-tagged block union ("prose" | "code"), so
// the renderer (proof-parts.tsx) can show a fenced code block apart from prose.
// A prose block carries { kind: "prose", heading, text }.
describe("engine explanation", () => {
  test("preserves paragraphs and promotes only labels the engine supplied", () => {
    expect(explanationSections("Mechanism.\n\nPoC (contract VaultTest): replay narrative.\n\nFix: clear the balance first.")).toEqual([
      { kind: "prose", heading: null, text: "Mechanism." },
      { kind: "prose", heading: "PoC narrative", text: "(contract VaultTest): replay narrative." },
      { kind: "prose", heading: "Fix", text: "clear the balance first." },
    ])
  })
  test("retains proof details and unlabelled prose without inventing a fix", () => {
    expect(explanationSections("Proof (passing test `VaultTest::test_Drain`): actual result.\r\n\r\nOther context.")).toEqual([
      { kind: "prose", heading: "PoC narrative", text: "(passing test `VaultTest::test_Drain`): actual result." },
      { kind: "prose", heading: null, text: "Other context." },
    ])
    expect(explanationSections("  ")).toEqual([])
  })
})

// The PoC attempt card uses one shared status vocabulary ("Test passed",
// "Test failed", "Test timed out"); only a known assertion count reads as
// "N test(s) failed". A failure with no count never claims an assertion count.
describe("replay timeline", () => {
  const started = { ev: "run_poc", contract: "VaultTest", attempt: 1 }
  test("unknown failures do not claim an assertion count", () => {
    const state = reduceEvents([started, { ev: "run_poc-done", contract: "VaultTest", passed: false }])
    expect(state.steps[0].detail).toBe("Test failed")
    expect(state.steps[0].state).toBe("fail")
  })
  test("reports test counts, timeout and passing replay accurately", () => {
    for (const [result, detail] of [
      [{ passed: false, failed: 1 }, "1 test failed"],
      [{ passed: false, failed: 2 }, "2 tests failed"],
      [{ passed: false, timedOut: true }, "Test timed out"],
      [{ passed: true }, "Test passed"],
    ] as const) {
      expect(reduceEvents([started, { ev: "run_poc-done", contract: "VaultTest", ...result }]).steps[0].detail).toBe(detail)
    }
  })
  test("does not resolve an unrelated contract's running replay", () => {
    const state = reduceEvents([started, { ev: "run_poc-done", contract: "OtherTest", passed: true }])
    expect(state.steps[0].state).toBe("running")
    expect(state.steps[0].detail).toBeUndefined()
  })
})
