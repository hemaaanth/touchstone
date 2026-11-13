// chain-bench as an opt-in networked tool (packs/supply-chain/networked-blocked.mjs).
// chain-bench v0.1.10 takes its token only as argv `-t`, which the token rule
// forbids. So an opt-in never runs it: it is "unavailable" plus a gap.
//
//   node --experimental-test-module-mocks --test spike/test/supply-chain-chain-bench.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const storeDir = mkdtempSync(join(tmpdir(), "chain-bench-test-stores-"));
process.env.TOUCHSTONE_SCOPES_FILE = join(storeDir, "scopes.json");
process.env.TOUCHSTONE_GRANTS_FILE = join(storeDir, "grants.json");
process.env.TOUCHSTONE_GRANT_TOKEN = "test-token-not-real";
after(() => rmSync(storeDir, { recursive: true, force: true }));

const { CHAIN_BENCH, RAVEN, captureBlocked } = await import("../packs/supply-chain/networked-blocked.mjs");
const { prepareNetworkedSnapshot, networkedResults, NETWORKED_TOOLS } = await import("../packs/supply-chain/networked.mjs");
// The run's own saved scope, made as the console's permission tick makes it.
const { addLiveScope } = await import("../lib/scopes-store.mjs");
const scopeId = addLiveScope({ hosts: ["hemaaanth/touchstone"], pack: "supply-chain", permission: true }).id;

const FAKE_TOKEN = "ghp_FAKEFAKEFAKEFAKEFAKEFAKE0123456789ab";

test("chain-bench never runs, even with a grant, a target and a token: no docker call, a not-covered gap, no lead", async () => {
  assert.ok(NETWORKED_TOOLS.includes("chain-bench"));
  let calls = 0;
  const run = async () => { calls++; return { code: 0, stdout: "{}", stderr: "" }; };
  const c = await captureBlocked("chain-bench", { target: { owner: "hemaaanth", repo: "touchstone" }, scopeId, token: FAKE_TOKEN, capture: run });
  assert.equal(calls, 0, "no docker call");
  assert.equal(c.status, "unavailable");
  assert.equal(c.reason, CHAIN_BENCH.reason);
  assert.match(c.reason, /only in argv \(-t\)/);

  const ws = mkdtempSync(join(tmpdir(), "touchstone-cb-"));
  try {
    const base = { version: 1, scope: "folder", files: { "a.txt": "x" }, skipped: [] };
    const { snapshot } = await prepareNetworkedSnapshot(ws, { networkTools: ["chain-bench"], networkTarget: "hemaaanth/touchstone", scopeId }, { token: FAKE_TOKEN, run, capture: run, base });
    assert.equal(calls, 0, "prepare makes no docker call either");
    const d = networkedResults(snapshot);
    assert.equal(d.leads.length, 0);
    assert.deepEqual(d.coverage.map((r) => [r.engine, r.status]), [["chain-bench", "unavailable"]]);
    const gap = d.gaps.find((g) => g.kind === "not-covered-token-in-argv");
    assert.ok(gap && /not a clean result/.test(gap.detail));
    assert.ok(!JSON.stringify(snapshot).includes(FAKE_TOKEN));
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("raven never runs either: no docker call, a not-covered gap that names each blocker, no lead", async () => {
  assert.ok(NETWORKED_TOOLS.includes("raven"));
  let calls = 0;
  const run = async () => { calls++; return { code: 0, stdout: "{}", stderr: "" }; };
  const c = await captureBlocked("raven", { target: { owner: "hemaaanth", repo: "touchstone" }, scopeId, token: FAKE_TOKEN, capture: run });
  assert.equal(calls, 0, "no docker call");
  assert.equal(c.status, "unavailable");
  assert.equal(c.reason, RAVEN.reason);
  for (const why of [/--token/, /raw\.githubusercontent\.com/, /Redis plus Neo4j/]) assert.match(c.reason, why);
  const d = networkedResults({ files: {}, captures: { raven: c } });
  assert.equal(d.leads.length, 0);
  assert.deepEqual(d.coverage.map((r) => [r.engine, r.status]), [["raven", "unavailable"]]);
  assert.ok(d.gaps.some((g) => g.kind === "not-covered-token-in-argv" && /raven is unavailable/.test(g.detail)));
});
