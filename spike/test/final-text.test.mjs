// The last answer must arrive whole: the engine flushes it before `settled`, and
// the run view repairs a step that an older record left one chunk short.
import { test } from "node:test"
import assert from "node:assert/strict"
import { unsentFinal } from "../lib/final-text.mjs"
import { repairFinalSay } from "../../app/src/lib/final-text.ts"

test("unsentFinal returns the whole answer only when the stream stopped short of it", () => {
  const full = "Six leads proved. No control was disabled."
  assert.equal(unsentFinal("Six leads proved. No control was", full), full)
  assert.equal(unsentFinal("", full), full)
  assert.equal(unsentFinal(full, full), null)
  assert.equal(unsentFinal("An earlier round said this.", full), null)
  assert.equal(unsentFinal("anything", ""), null)
  assert.equal(unsentFinal("anything", undefined), null)
})

test("repairFinalSay fills the last prose step and leaves other steps alone", () => {
  const steps = [
    { kind: "say", label: "Round one text." },
    { kind: "poc", label: "Tool step" },
    { kind: "say", label: "All six leads held. No control was" },
    { kind: "note", label: "later note" },
  ]
  assert.equal(repairFinalSay(steps, "All six leads held. No control was disabled."), true)
  assert.equal(steps[2].label, "All six leads held. No control was disabled.")
  assert.equal(steps[0].label, "Round one text.")
})

test("repairFinalSay does nothing when the text is not a longer continuation", () => {
  const steps = [{ kind: "say", label: "Complete answer." }]
  assert.equal(repairFinalSay(steps, "Complete answer."), false)
  assert.equal(repairFinalSay(steps, "Different answer, longer."), false)
  assert.equal(repairFinalSay(steps, 42), false)
  assert.equal(repairFinalSay([], "x"), false)
  assert.equal(steps[0].label, "Complete answer.")
})
