import { test } from "node:test";
import assert from "node:assert/strict";
import { attemptCap, leftCount, leftText, readSpendWith } from "../lib/attempt-cap.mjs";

test("no env value means no count cap", () => {
  readSpendWith(null);
  assert.equal(attemptCap("MAX_POC", {}), Infinity);
  assert.equal(attemptCap("MAX_POC", { MAX_POC: "" }), Infinity);
  assert.equal(leftText(Infinity, 40, "run_poc"), "The run's spend budget is the limit.");
  assert.equal(leftCount(Infinity, 40), null);
});

test("with no count cap, the text shows the money left", () => {
  readSpendWith(() => ({ usd: 1.234, budgetUsd: 5 }));
  assert.equal(leftText(Infinity, 300, "script"), "$3.77 of the $5.00 run budget left.");
  readSpendWith(() => ({ usd: 6, budgetUsd: 5 }));
  assert.equal(leftText(Infinity, 300, "script"), "$0.00 of the $5.00 run budget left.");
  readSpendWith(null);
});

test("an env value sets the cap", () => {
  readSpendWith(null);
  const cap = attemptCap("MAX_HTTP_RUNS", { MAX_HTTP_RUNS: "12" });
  assert.equal(cap, 12);
  assert.equal(leftText(cap, 11, "script"), "1 script attempt left. The run's spend budget is the limit.");
  assert.equal(leftText(cap, 20, "script"), "0 script attempts left. The run's spend budget is the limit.");
  assert.equal(leftCount(cap, 5), 7);
});

test("a bad env value is an error, not a silent no-cap", () => {
  for (const v of ["abc", "0", "-3", "2.5"]) {
    assert.throws(() => attemptCap("MAX_POC", { MAX_POC: v }), /MAX_POC must be a whole number/);
  }
});
