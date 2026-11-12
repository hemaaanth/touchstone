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
  // Only our own detector emits it; no scanner finds the role chain (bar 2).
  assert.deepEqual(liveLead.engines, ["Touchstone"]);
  // A conditioned trust is not broad: the detector must stay quiet. The replay
  // alone cannot tell, because moto ignores conditions.
  const conditioned = makeLabWorkspace();
  try {
    const tf = JSON.parse(readFileSync(join(conditioned, "main.tf.json"), "utf8"));
    tf.resource.aws_iam_role.ci_runner.assume_role_policy_document = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "sts:AssumeRole", Condition: { StringEquals: { "sts:ExternalId": "touchstone" } } }] });
    writeFileSync(join(conditioned, "main.tf.json"), JSON.stringify(tf, null, 2));
    const { snapshot: snap } = (await import("./snapshot.mjs")).prepareSnapshot(conditioned);
    const { analyze } = await import("./checks.mjs");
    assert.ok(!analyze(snap).leads.some((l) => l.check === LIVE_CHECK), "a conditioned trust must not lead");
    const proof = await liveProof(conditioned, { evidence: { where: { ...liveLead.where, file: "main.tf.json" } } });
    assert.equal(proof.status, "pass", "the replay still passes: that is why the detector must exclude it");
  } finally { rmSync(conditioned, { recursive: true, force: true }); }
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
  // No credential value may survive in the rendered proof.
  const rendered = JSON.stringify(live.proof);
  assert.ok(!/<SecretAccessKey>(?!\[REDACTED\])[^<]+</.test(rendered), "secret access key leaked");
  assert.ok(!/<SessionToken>(?!\[REDACTED\])[^<]+</.test(rendered), "session token leaked");
  assert.ok(!/"secretAccessKey":"(?!\[REDACTED\])[^"]+"/.test(rendered), "lab secret key leaked");
  assert.equal(live.proof.log.find((x) => x.request.url.endsWith("/__lab.json")).response.body.secretAccessKey, "[REDACTED]");
  // The replay is a differential, not a tautology. Narrowing the grant to the
  // workload's own bucket must deny the read with a real 403, not a 404 or 500.
  const narrower = async (edit) => {
    const dir = makeLabWorkspace();
    try {
      const tf = JSON.parse(readFileSync(join(dir, "main.tf.json"), "utf8"));
      edit(tf.resource);
      writeFileSync(join(dir, "main.tf.json"), JSON.stringify(tf, null, 2));
      (await import("./snapshot.mjs")).prepareSnapshot(dir);
      return await liveProof(dir, { evidence: { where: { ...liveLead.where, file: "main.tf.json" } } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const narrowedGrant = await narrower((r) => { r.aws_iam_role_policy.ci_runner_read.policy = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "arn:aws:s3:::touchstone-lab-app/*" }] }); });
  assert.equal(narrowedGrant.status, "fail");
  assert.match(narrowedGrant.detail, /not readable/);
  assert.equal(narrowedGrant.log.at(-1).response.status, 403);
  const narrowedTrust = await narrower((r) => { r.aws_iam_role.ci_runner.assume_role_policy_document = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::999999999999:root" }, Action: "sts:AssumeRole" }] }); });
  assert.equal(narrowedTrust.status, "fail");
  assert.equal(narrowedTrust.log.at(-1).response.status, 403);
  const secret = readFileSync(join(ws, "kubernetes.yaml"), "utf8").match(/0x[a-f0-9]{64}/)[0];
  assert.ok(!JSON.stringify({ prep, proven }).includes(secret), "A wallet key reached public output");
  const summary = { smoke: "pass", leads: prep.record.leads.length, proven: proven.length, live: { status: live.proof.status, oracle: live.proof.oracle.name, requests: live.proof.log.length, narrowedGrant: { status: narrowedGrant.status, lastStatus: narrowedGrant.log.at(-1).response.status }, narrowedTrust: { status: narrowedTrust.status, lastStatus: narrowedTrust.log.at(-1).response.status } }, cryptoChecks: [...new Set(prep.record.leads.filter((l) => l.engine === "Touchstone").map((l) => l.check))], coverage: prep.record.coverage, cloud: prep.record.cloud, liveCloud: prep.record.liveCloud, snapshotHash: prep.record.snapshotHash, commit: prep.record.commit, spendUsd: 0 };
  mkdirSync(new URL("./validation/", import.meta.url), { recursive: true });
  writeFileSync(new URL("./validation/smoke.json", import.meta.url), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
} finally { rmSync(ws, { recursive: true, force: true }); }
