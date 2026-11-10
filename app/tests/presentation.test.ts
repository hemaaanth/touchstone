import { describe, expect, test } from "bun:test"
import { explanationSections } from "../src/lib/explanation"
import { reduceEvents } from "../src/lib/runModel"

describe("engine explanation", () => {
  test("preserves paragraphs and promotes only labels the engine supplied", () => {
    expect(explanationSections("Mechanism.\n\nPoC (contract VaultTest): replay narrative.\n\nFix: clear the balance first.")).toEqual([
      { heading: null, text: "Mechanism." },
      { heading: "PoC narrative", text: "(contract VaultTest): replay narrative." },
      { heading: "Fix", text: "clear the balance first." },
    ])
  })
  test("retains proof details and unlabelled prose without inventing a fix", () => {
    expect(explanationSections("Proof (passing test `VaultTest::test_Drain`): actual result.\r\n\r\nOther context.")).toEqual([
      { heading: "PoC narrative", text: "(passing test `VaultTest::test_Drain`): actual result." },
      { heading: null, text: "Other context." },
    ])
    expect(explanationSections("  ")).toEqual([])
  })
})

describe("replay timeline", () => {
  const started = { ev: "run_poc", contract: "VaultTest", attempt: 1 }
  test("unknown failures do not claim an assertion count", () => {
    const state = reduceEvents([started, { ev: "run_poc-done", contract: "VaultTest", passed: false }])
    expect(state.steps[0].detail).toBe("Replay did not pass")
    expect(state.steps[0].state).toBe("fail")
  })
  test("reports test counts, timeout and passing replay accurately", () => {
    for (const [result, detail] of [
      [{ passed: false, failed: 1 }, "1 test failed"],
      [{ passed: false, failed: 2 }, "2 tests failed"],
      [{ passed: false, timedOut: true }, "Replay timed out"],
      [{ passed: true }, "Replay passed"],
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
