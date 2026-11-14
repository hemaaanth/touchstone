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
});
