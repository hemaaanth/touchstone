import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeLabWorkspace } from "./snapshot.mjs";
import { LIVE_CHECK, liveProof } from "./live-cloud.mjs";
import pack from "./pack.mjs";
const ws = makeLabWorkspace();
try {
  const prep = await pack.prepass(ws, { emit: () => {} });
  assert.ok(prep.record.coverage.every((r) => r.status === "ok"), JSON.stringify(prep.record.coverage));
  assert.ok(prep.record.leads.some((l) => l.check === "broad-kms-sign"));
  assert.ok(prep.record.leads.some((l) => l.check === "internet-rpc-admin-namespaces"));
  assert.ok(prep.record.leads.some((l) => l.check === "frontend-versioning-disabled" && l.engines.includes("prowler")));
  const liveLead = prep.record.leads.find((l) => l.check === LIVE_CHECK);
  assert.ok(liveLead, "The live cloud lead is missing");
  assert.equal(prep.record.liveCloud.leads.find((l) => l.lead === liveLead.id).status, "ok");
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
  // The live lead carries a replay of its own, and its harm is in the transcript.
  const live = proven.find((f) => f.evidence.check === LIVE_CHECK);
  assert.equal(live.proof.kind, "http");
  assert.equal(live.proof.status, "pass");
  assert.ok(live.proof.log.some((x) => /wallets\.json/.test(x.request.url) && x.response.status === 200));
  assert.ok(proven.filter((f) => f.evidence.check !== LIVE_CHECK).every((f) => f.proof.kind === "evidence"));
  // Same rule and location, narrower grant: the live replay must fail.
  const narrowed = makeLabWorkspace();
  let fail;
  try {
    const tf = JSON.parse(readFileSync(join(narrowed, "main.tf.json"), "utf8"));
    tf.resource.aws_iam_role_policy.ci_runner_read.policy = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "arn:aws:s3:::touchstone-lab-app/*" }] });
    writeFileSync(join(narrowed, "main.tf.json"), JSON.stringify(tf, null, 2));
    const { prepareSnapshot } = await import("./snapshot.mjs");
    const { snapshot } = prepareSnapshot(narrowed);
    const proof = await liveProof(narrowed, { evidence: { where: { ...liveLead.where, file: "main.tf.json" } } });
    fail = { status: proof.status, detail: proof.detail, bucket: snapshot.files["main.tf.json"].includes("touchstone-lab-app/*") };
  } finally { rmSync(narrowed, { recursive: true, force: true }); }
  assert.equal(fail.status, "fail");
  assert.match(fail.detail, /not readable/);
  const secret = readFileSync(join(ws, "kubernetes.yaml"), "utf8").match(/0x[a-f0-9]{64}/)[0];
  assert.ok(!JSON.stringify({ prep, proven }).includes(secret), "A wallet key reached public output");
  const summary = { smoke: "pass", leads: prep.record.leads.length, proven: proven.length, live: { status: live.proof.status, oracle: live.proof.oracle.name, requests: live.proof.log.length, narrowedPolicy: fail }, cryptoChecks: [...new Set(prep.record.leads.filter((l) => l.engine === "Touchstone").map((l) => l.check))], coverage: prep.record.coverage, cloud: prep.record.cloud, liveCloud: prep.record.liveCloud, snapshotHash: prep.record.snapshotHash, commit: prep.record.commit, spendUsd: 0 };
  mkdirSync(new URL("./validation/", import.meta.url), { recursive: true });
  writeFileSync(new URL("./validation/smoke.json", import.meta.url), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
} finally { rmSync(ws, { recursive: true, force: true }); }
