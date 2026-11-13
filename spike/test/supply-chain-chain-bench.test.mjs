// chain-bench as an opt-in networked tool (packs/supply-chain/networked-blocked.mjs).
// chain-bench v0.1.10 takes its token only as argv `-t`, which the token rule
// forbids. So an opt-in never runs it: it is "unavailable" plus a gap.
//
//   node --test spike/test/supply-chain-chain-bench.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CHAIN_BENCH, captureBlocked } from "../packs/supply-chain/networked-blocked.mjs";
import { prepareNetworkedSnapshot, networkedResults, NETWORKED_TOOLS } from "../packs/supply-chain/networked.mjs";

const FAKE_TOKEN = "ghp_FAKEFAKEFAKEFAKEFAKEFAKE0123456789ab";
const reach = { granted: true, scope: ["hemaaanth/touchstone"] };

test("chain-bench never runs, even with a grant, a target and a token: no docker call, a not-covered gap, no lead", async () => {
  assert.ok(NETWORKED_TOOLS.includes("chain-bench"));
  let calls = 0;
  const run = async () => { calls++; return { code: 0, stdout: "{}", stderr: "" }; };
  const c = await captureBlocked("chain-bench", { target: { owner: "hemaaanth", repo: "touchstone" }, reach, token: FAKE_TOKEN, run });
  assert.equal(calls, 0, "no docker call");
  assert.equal(c.status, "unavailable");
  assert.equal(c.reason, CHAIN_BENCH.reason);
  assert.match(c.reason, /only in argv \(-t\)/);

  const ws = mkdtempSync(join(tmpdir(), "touchstone-cb-"));
  try {
    const base = { version: 1, scope: "folder", files: { "a.txt": "x" }, skipped: [] };
    const { snapshot } = await prepareNetworkedSnapshot(ws, { networkTools: ["chain-bench"], networkTarget: "hemaaanth/touchstone", reach }, { token: FAKE_TOKEN, run, base });
    assert.equal(calls, 0, "prepare makes no docker call either");
    const d = networkedResults(snapshot);
    assert.equal(d.leads.length, 0);
    assert.deepEqual(d.coverage.map((r) => [r.engine, r.status]), [["chain-bench", "unavailable"]]);
    const gap = d.gaps.find((g) => g.kind === "not-covered-token-in-argv");
    assert.ok(gap && /not a clean result/.test(gap.detail));
    assert.ok(!JSON.stringify(snapshot).includes(FAKE_TOKEN));
  } finally { rmSync(ws, { recursive: true, force: true }); }
});
