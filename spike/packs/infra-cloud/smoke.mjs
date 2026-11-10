import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeLabWorkspace } from "./snapshot.mjs";
import pack from "./pack.mjs";
const ws = makeLabWorkspace();
try {
  const prep = await pack.prepass(ws, { emit: () => {} });
  assert.ok(prep.record.coverage.every((r) => r.status === "ok"), JSON.stringify(prep.record.coverage));
  assert.ok(prep.record.leads.some((l) => l.check === "broad-kms-sign"));
  assert.ok(prep.record.leads.some((l) => l.check === "internet-rpc-admin-namespaces"));
  assert.ok(prep.record.leads.some((l) => l.check === "frontend-versioning-disabled" && l.engines.includes("prowler")));
  const state = { poc: 0, passed: new Map(), found: [] };
  const tools = Object.fromEntries(pack.tools(ws, state).map((t) => [t.name, t]));
  const first = prep.record.leads[0];
  assert.equal((await tools.submit_finding.execute({ lead_id: first.id })).isError, true);
  for (const lead of prep.record.leads) {
    assert.notEqual((await tools.check_evidence.execute({ lead_id: lead.id })).isError, true, `Replay failed: ${lead.check}`);
    assert.notEqual((await tools.submit_finding.execute({ lead_id: lead.id })).isError, true, `Submit failed: ${lead.check}`);
  }
  assert.equal((await tools.submit_finding.execute({ lead_id: first.id })).isError, true);
  const proven = await pack.prove(ws, state.found, [], () => {});
  assert.equal(proven.length, prep.record.leads.length);
  const secret = readFileSync(join(ws, "kubernetes.yaml"), "utf8").match(/0x[a-f0-9]{64}/)[0];
  assert.ok(!JSON.stringify({ prep, proven }).includes(secret), "A wallet key reached public output");
  const summary = { smoke: "pass", leads: prep.record.leads.length, proven: proven.length, cryptoChecks: [...new Set(prep.record.leads.filter((l) => l.engine === "Touchstone").map((l) => l.check))], coverage: prep.record.coverage, cloud: prep.record.cloud, snapshotHash: prep.record.snapshotHash, commit: prep.record.commit, spendUsd: 0 };
  mkdirSync(new URL("./validation/", import.meta.url), { recursive: true });
  writeFileSync(new URL("./validation/smoke.json", import.meta.url), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
} finally { rmSync(ws, { recursive: true, force: true }); }
