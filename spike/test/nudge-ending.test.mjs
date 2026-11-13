// A pack's nudge is one extra turn after a clean end. It must not change how
// the run ends unless it adds something. If the nudge turn records nothing,
// the first turn's final text stays (a Review run's prose lead list is not
// replaced by "I found no lead"). If the nudge turn fails, the first turn's
// clean outcome stays.
//
//   node --test spike/test/nudge-ending.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Loaded per test, so on a base without the module each test fails on its own.
const afterNudge = async (...a) => (await import("../lib/nudge.mjs")).afterNudge(...a);

const done = { status: "done" };
const first = { settled: done, final: { text: "Leads, worst first: 1. SSRF at avatar.ts:88 ..." }, found: 0, leads: 0 };

test("a nudge turn that records nothing keeps the first turn's final text", async () => {
  const end = await afterNudge(first, { settled: { status: "done" }, final: { text: "I found no lead." }, found: 0, leads: 0 });
  assert.equal(end.settled.status, "done");
  assert.equal(end.final.text, first.final.text);
});

test("a nudge turn that fails keeps the first turn's clean outcome and text", async () => {
  for (const settled of [{ status: "error", reason: "Stream interrupted" }, { status: "stopped", reason: "budget" }]) {
    const end = await afterNudge(first, { settled, final: { text: "" }, found: 0, leads: 0 });
    assert.equal(end.settled, done, `a ${settled.status} nudge turn does not end the run`);
    assert.equal(end.final.text, first.final.text);
  }
});

test("a nudge turn that records a lead or a finding ends the run with its own text", async () => {
  for (const add of [{ leads: 3 }, { found: 1 }]) {
    const end = await afterNudge(first, { settled: { status: "done" }, final: { text: "Recorded 3 leads." }, found: 0, leads: 0, ...add });
    assert.equal(end.final.text, "Recorded 3 leads.");
  }
});

test("the worker applies afterNudge to the nudge turn", () => {
  // agent-run.mjs runs on import, so its wiring is pinned by its source.
  const src = readFileSync(new URL("../agent-run.mjs", import.meta.url), "utf8");
  const child = src.slice(src.indexOf("async function child("), src.indexOf("// Spawn a worker"));
  assert.match(child, /afterNudge\(/);
  assert.match(child, /event\("settled", \{ status: settled\.status[^\n]*summary: s,/);
});
