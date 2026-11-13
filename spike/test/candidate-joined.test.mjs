// Candidates in a joined run: one run, several modules (packs/multi.mjs).
//
//   node --experimental-test-module-mocks --test spike/test/candidate-joined.test.mjs
//
// What must hold:
//   - each module gets its own submit_candidate, and a candidate it records
//     carries that module and is never a finding;
//   - two modules may use one label (multi.mjs), so a finding of one module
//     never takes the place of another module's candidate;
//   - the joined proof step gets findings only, and a candidate is never proven.
// No docker, no model call. The modules are stubs with the real candidate tool.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "candidate-joined-"));
process.env.EVENTS_FILE = path.join(dir, "events.jsonl");
after(() => rmSync(dir, { recursive: true, force: true }));

const { multiPack } = await import("../packs/multi.mjs");
const { auditState } = await import("../lib/audit-state.mjs");
const { candidateTool, supersededBy } = await import("../lib/candidate.mjs");
const { isProven } = await import("../lib/proof-view.mjs");

const OUT = (label) => `GET /admin/export -> 200 rows for ${label}`;

// A module with one attempt tool, submit_finding and the real submit_candidate.
function stub(id, proved) {
  return {
    id,
    title: id,
    system: () => `Rules of ${id}.`,
    kickoff: () => `Work ${id}.`,
    tools: (ws, state) => [
      {
        name: "run_attempt",
        description: "run one attempt",
        parameters: { type: "object", properties: {} },
        execute: async ({ label }) => {
          state.attempts ??= new Map();
          state.attempts.set(label, { text: OUT(label) });
          return { output: [{ type: "text", text: OUT(label) }] };
        },
      },
      {
        name: "submit_finding",
        description: "record a finding",
        parameters: { type: "object", properties: {} },
        execute: async ({ poc }) => {
          state.found.push({ n: state.found.length + 1, title: `${id} finding`, severity: "high", poc });
          return { output: [{ type: "text", text: "Recorded." }] };
        },
      },
      candidateTool({
        pack: id,
        state,
        poc: "the attempt label",
        lookup: (label) => {
          const a = state.attempts?.get(label);
          return a ? { evidence: { kind: "capture", text: a.text }, text: a.text, rootCause: `${id}:${label}` } : null;
        },
      }),
    ],
    prove: async (_ws, found) => {
      proved.push(...found.map((f) => [id, f.poc]));
      return found.map((f) => ({ ...f, proof: { kind: "http", status: "pass" } }));
    },
  };
}

const args = (label) => ({
  title: `Export leaks rows (${label})`,
  severity: "high",
  poc: label,
  evidence_lines: [OUT(label)],
  explanation: "Anyone can export the rows.\nFix: check the session.",
});

test("a joined run: each module records its own candidate, never a finding, never proven", async () => {
  const proved = [];
  const pack = multiPack([stub("alpha", proved), stub("beta", proved)]);
  const ws = mkdtempSync(path.join(dir, "ws-"));
  const state = auditState(null);
  const tools = new Map(pack.tools(ws, state).map((t) => [t.name, t]));
  assert.ok(tools.has("submit_candidate_alpha") && tools.has("submit_candidate_beta"), [...tools.keys()].join(", "));

  await tools.get("run_attempt_alpha").execute({ label: "probe-1" });
  const r = await tools.get("submit_candidate_alpha").execute(args("probe-1"));
  assert.equal(r.isError, undefined, r.output[0].text);
  assert.deepEqual(state.candidates.map((c) => [c.pack, c.poc, c.proven, c.provedBy]), [["alpha", "probe-1", false, null]]);
  assert.equal(state.found.length, 0, "a candidate is not a finding");

  // Beta uses the same label for its own finding. Alpha's candidate stays.
  await tools.get("submit_finding_beta").execute({ poc: "probe-1" });
  assert.deepEqual(state.candidates.map((c) => c.poc), ["probe-1"], "another module's finding does not end it");
  // The joined proof step gets the finding only. Even proven, it is beta's.
  const findings = await pack.prove(ws, state.found, []);
  assert.deepEqual(proved, [["beta", "probe-1"]]);
  assert.ok(findings.every((f) => f.pack === "beta" && isProven(f)));
  assert.deepEqual(supersededBy(state.candidates, findings), [], "the server's final step keeps it too");
  assert.equal(state.candidates.some(isProven), false);

  // Alpha's own finding for the label takes the place of alpha's candidate.
  await tools.get("submit_finding_alpha").execute({ poc: "probe-1" });
  assert.deepEqual(state.candidates.map((c) => c.poc), [], "its own module's finding ends it");
});
