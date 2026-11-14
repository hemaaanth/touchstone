// submit_candidate in the oracle-replay packs (web, ai-mcp). The lab is
// mocked: runRequestScript returns a fixed transcript, so no container runs.
import "./helpers/isolated-env.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let nextTranscript = [];
const realProof = await import("../lib/proof-http.mjs");
mock.module("../lib/proof-http.mjs", {
  exports: {
    ...realProof,
    readLabHandle: () => ({ baseUrl: "http://lab.test" }),
    runRequestScript: async () => ({ transcript: nextTranscript, stderr: "" }),
  },
});

const { default: web } = await import("../packs/web/pack.mjs");
const { default: aiMcp } = await import("../packs/ai-mcp/pack.mjs");

const LEAK_KEY = "sk-lab-0123456789abcdef";
const harmless = (n) => [{ method: "GET", path: `/admin/export/${n}`, status: 200, reqHeaders: {}, reqBody: null, resHeaders: {}, resBody: { rows: n, note: `exported ${n} customer rows`, apiKey: LEAK_KEY } }];
// The web siwe-nonce-replay oracle: one signed message accepted twice.
const replay = () => {
  const same = { message: "m", signature: "s" };
  return [
    { method: "POST", path: "/siwe/verify", status: 200, reqBody: same, resBody: { token: "a" } },
    { method: "POST", path: "/siwe/verify", status: 200, reqBody: same, resBody: { token: "b" } },
  ];
};
// The ai-mcp mcp-tool-scope-bypass oracle: a reader token deletes a note.
const READER = { authorization: "Bearer tok_reader_7f3a" };
const mcp = (name, id, result) => ({ path: "/mcp", method: "POST", status: 200, reqHeaders: READER, reqBody: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { id } } }, resBody: { jsonrpc: "2.0", id: 1, result } });
const scopeBypass = () => [
  mcp("read_note", 3, { content: [{ type: "text", text: "# note" }], isError: false }),
  mcp("delete_note", 3, { content: [{ type: "text", text: '{"deleted":true}' }], isError: false }),
  mcp("read_note", 3, { content: [{ type: "text", text: "no such note" }], isError: true }),
];

const candidateArgs = (label, n) => ({
  title: `Export endpoint leaks rows (${n})`,
  severity: "high",
  poc: label,
  evidence_lines: [`GET /admin/export/${n} -> 200`, `exported ${n} customer rows`],
  explanation: "Anyone can export customer rows.\nFix: require an admin session.",
});

for (const [pack, proved] of [[web, replay], [aiMcp, scopeBypass]]) {
  const setup = () => {
    const ws = mkdtempSync(join(tmpdir(), `cand-${pack.id}-`));
    const state = { poc: 0, passed: new Map(), found: [] };
    const tools = Object.fromEntries(pack.tools(ws, state).map((t) => [t.name, t]));
    const run = async (label, transcript) => { nextTranscript = transcript; return tools.run_request_script.execute({ label, script: `// ${label}` }); };
    return { ws, state, tools, run, done: () => rmSync(ws, { recursive: true, force: true }) };
  };

  test(`${pack.id}: an unmatched attempt becomes an unproven candidate with its transcript`, async () => {
    const { state, tools, run, done } = setup();
    try {
      const out = await run("exp-1", harmless(1));
      assert.match(out.output[0].text, /No known harm pattern matched/);
      assert.match(out.output[0].text, /submit_candidate/, "the no-proof message names submit_candidate");
      const r = await tools.submit_candidate.execute(candidateArgs("exp-1", 1));
      assert.ok(!r.isError, r.output[0].text);
      const c = state.candidates[0];
      assert.equal(c.pack, pack.id);
      assert.equal(c.proven, false);
      assert.equal(c.candidate, true);
      assert.equal(c.assertedBy, "agent");
      assert.equal(c.provedBy, null);
      assert.equal(c.evidence.kind, "transcript");
      assert.equal(c.evidence.transcript[0].path, "/admin/export/1");
      assert.ok(!JSON.stringify(c).includes(LEAK_KEY), "secrets are scrubbed from the evidence");
      assert.equal(state.found.length, 0, "a candidate is not a finding");
      // The finding gate is unchanged: an unmatched label is still refused there.
      const f = await tools.submit_finding.execute({ title: "t", severity: "high", label: "exp-1", explanation: "x" });
      assert.equal(f.isError, true);
    } finally { done(); }
  });

  test(`${pack.id}: a bare claim is refused`, async () => {
    const { state, tools, done } = setup();
    try {
      const r = await tools.submit_candidate.execute(candidateArgs("never-ran", 1));
      assert.equal(r.isError, true);
      assert.match(r.output[0].text, /never a bare claim/);
      assert.equal(state.candidates?.length ?? 0, 0);
    } finally { done(); }
  });

  test(`${pack.id}: a matched attempt is refused and routed to submit_finding`, async () => {
    const { state, tools, run, done } = setup();
    try {
      const out = await run("hit-1", proved());
      assert.match(out.output[0].text, /MATCH:/);
      const r = await tools.submit_candidate.execute({ ...candidateArgs("hit-1", 1), evidence_lines: ["POST /siwe/verify -> 200"] });
      assert.equal(r.isError, true);
      assert.match(r.output[0].text, /Call submit_finding with "hit-1"/);
      assert.equal(state.candidates?.length ?? 0, 0);
    } finally { done(); }
  });

  test(`${pack.id}: duplicate guards and the cap of 3`, async () => {
    const { state, tools, run, done } = setup();
    try {
      for (const n of [1, 2, 3, 4]) await run(`exp-${n}`, harmless(n));
      assert.ok(!(await tools.submit_candidate.execute(candidateArgs("exp-1", 1))).isError);
      const twin = await tools.submit_candidate.execute(candidateArgs("exp-1", 1));
      assert.match(twin.output[0].text, /already recorded as candidate #1/);
      // Same script under a new label: the same root cause.
      nextTranscript = harmless(9);
      await tools.run_request_script.execute({ label: "exp-1b", script: "// exp-1" });
      const sameRoot = await tools.submit_candidate.execute(candidateArgs("exp-1b", 9));
      assert.match(sameRoot.output[0].text, /root cause is already recorded/);
      assert.ok(!(await tools.submit_candidate.execute(candidateArgs("exp-2", 2))).isError);
      assert.ok(!(await tools.submit_candidate.execute(candidateArgs("exp-3", 3))).isError);
      const fourth = await tools.submit_candidate.execute(candidateArgs("exp-4", 4));
      assert.equal(fourth.isError, true);
      assert.match(fourth.output[0].text, /already has 3 candidates/);
      assert.equal(state.candidates.length, 3);
      assert.equal(state.found.length, 0);
    } finally { done(); }
  });
}
