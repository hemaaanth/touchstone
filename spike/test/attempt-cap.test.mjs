import { test } from "node:test";
import assert from "node:assert/strict";
import { attemptCap, leftCount, leftText } from "../lib/attempt-cap.mjs";

test("no env value means no count cap", () => {
  assert.equal(attemptCap("MAX_POC", {}), Infinity);
  assert.equal(attemptCap("MAX_POC", { MAX_POC: "" }), Infinity);
  assert.match(leftText(Infinity, 40, "run_poc"), /spend budget is the limit/);
  assert.equal(leftCount(Infinity, 40), null);
});

test("an env value sets the cap", () => {
  const cap = attemptCap("MAX_HTTP_RUNS", { MAX_HTTP_RUNS: "12" });
  assert.equal(cap, 12);
  assert.equal(leftText(cap, 11, "script"), "1 script attempt left.");
  assert.equal(leftText(cap, 20, "script"), "0 script attempts left.");
  assert.equal(leftCount(cap, 5), 7);
});

test("a bad env value is an error, not a silent no-cap", () => {
  for (const v of ["abc", "0", "-3", "2.5"]) {
    assert.throws(() => attemptCap("MAX_POC", { MAX_POC: v }), /MAX_POC must be a whole number/);
  }
});
