import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunBudget, validateRunBudget } from "../lib/run-budget.mjs";

test("a budget refuses a bad limit and a bad spend", () => {
  assert.throws(() => validateRunBudget(0), /between/)
  assert.throws(() => createRunBudget(5, -1), /Invalid run spend/)
})


test("a live ceiling raises the cap, and the guard reads it each call", () => {
  let cap = 5
  const b = createRunBudget(5, 1, () => cap)
  b.charge(3) // spent 4 of 5
  assert.throws(() => b.guard(2), /Ask for more/)
  cap = 8
  assert.doesNotThrow(() => b.guard(2), "the raised ceiling is read on the next guard")
  assert.equal(b.limit, 8)
})

test("a broken live source keeps the last good ceiling", () => {
  let cap = 4
  const b = createRunBudget(4, 1, () => { if (cap === null) throw new Error("nope"); return cap })
  cap = null
  assert.equal(b.limit, 4)
})
