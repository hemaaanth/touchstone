import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { staticGap } from "../lib/static.mjs";
import { fuzzGap } from "../lib/fuzz.mjs";

test("static gaps distinguish failed, partial and completed analysis", () => {
  const scan = { mode: "per-file", engines: ["Slither"], files: 3, analysed: 0, failed: 3 };
  assert.match(staticGap(scan), /read 0 of 3/);
  assert.match(staticGap({ ...scan, analysed: 2, failed: 1 }), /read 2 of 3/);
  assert.equal(staticGap({ ...scan, analysed: 3, failed: 0 }), "");
});

test("fuzz gaps distinguish no template, unavailable engines and a completed pass", () => {
  assert.match(fuzzGap({ applicable: false, engines: [] }), /does not match/);
  assert.match(fuzzGap({ applicable: true, engines: [] }), /neither Echidna nor Medusa was available/);
  assert.equal(fuzzGap({ applicable: true, engines: ["Echidna"] }), "");
  assert.match(fuzzGap({ applicable: true, engines: ["Echidna"], timedOut: true }), /time limit.*Keep any leads/);
});


test("Slither failure preserves successful Aderyn and Touchstone leads", () => {
  const gap = staticGap({
    mode: "per-file", engines: ["Slither", "Aderyn"], files: 1, analysed: 0, failed: 1,
    findings: [{ engines: ["Aderyn", "Touchstone"], check: "unprotected-control-function" }],
  });
  assert.match(gap, /Slither did not complete analysis: it read 0 of 1/);
  assert.match(gap, /Keep any leads returned by Aderyn and Touchstone/);
  assert.doesNotMatch(gap, /treat every static row as absent|produced no leads|Slither \+ Aderyn read/);
  const partial = staticGap({ mode: "per-file", engines: ["Slither", "Aderyn"], files: 2, analysed: 1, failed: 1 });
  assert.match(partial, /did not compile for Slither/);
  assert.match(partial, /Keep any leads returned by Aderyn and Touchstone/);
});
