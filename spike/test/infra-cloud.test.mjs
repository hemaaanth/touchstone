import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyze, cryptoDetectors } from "../packs/infra-cloud/checks.mjs";
import { captureSnapshot, makeLabWorkspace } from "../packs/infra-cloud/snapshot.mjs";
import { cloudSeed } from "../packs/infra-cloud/cloud.mjs";
import { pinSnapshot, replayEvidence } from "../lib/proof-evidence.mjs";

function labSnapshot() {
  const ws = makeLabWorkspace();
  try { return captureSnapshot(ws); } finally { rmSync(ws, { recursive: true, force: true }); }
}
const original = labSnapshot();
const checks = (snapshot) => analyze(snapshot).leads.map((l) => l.check);
function terraform(change) {
  const snapshot = structuredClone(original), tf = JSON.parse(snapshot.files["main.tf.json"]);
  change(tf.resource);
  snapshot.files["main.tf.json"] = JSON.stringify(tf, null, 2);
  return snapshot;
}
const replaceKube = (from, to) => ({ ...original, files: { ...original.files, "kubernetes.yaml": original.files["kubernetes.yaml"].replace(from, to) } });

test("planted crypto infrastructure risks have exact source citations and redacted secrets", () => {
  const result = analyze(original);
  assert.deepEqual([...new Set(result.leads.map((l) => l.check))].sort(), ["broad-kms-sign", "ci-can-exec-signers", "ci-can-write-frontend", "exposed-signer-service", "frontend-object-lock-missing", "frontend-public-write", "frontend-versioning-disabled", "hot-wallet-key-in-config", "internet-rpc-admin-namespaces", "internet-signer-security-group", "public-signer-load-balancer"].sort());
  for (const l of result.leads) assert.ok(l.lines[0] > 0 && l.lines[0] <= original.files[l.file].split("\n").length);
  const secret = result.leads.find((l) => l.check === "hot-wallet-key-in-config");
  assert.equal(secret.secret.redacted, "[REDACTED]");
  assert.match(secret.secret.sha256, /^[a-f0-9]{64}$/);
  const raw = original.files["kubernetes.yaml"].match(/0x[a-f0-9]{64}/)[0];
  assert.ok(!JSON.stringify(result).includes(raw));
});

test("KMS Sign requires a wildcard principal and an unconditional, non-denied grant", () => {
  for (const modify of [
    (s) => { s.Principal = { AWS: "arn:aws:iam::123456789012:role/signer" }; },
    (s) => { s.Action = ["kms:GetPublicKey"]; },
    (s) => { s.Condition = { StringEquals: { "aws:PrincipalOrgID": "o-lab" } }; },
    (s, p) => { p.Statement.push({ Effect: "Deny", Principal: "*", Action: "kms:Sign", Resource: "*" }); },
    (s) => { s.Resource = "arn:aws:kms:us-east-1:123456789012:key/other"; },
  ]) {
    const snapshot = terraform((r) => { const p = JSON.parse(r.aws_kms_key.signer.policy); modify(p.Statement[0], p); r.aws_kms_key.signer.policy = JSON.stringify(p); });
    assert.ok(!checks(snapshot).includes("broad-kms-sign"));
  }
  assert.ok(checks(terraform((r) => { r.aws_kms_key.signer.policy = JSON.stringify({ Statement: [{ Effect: "Allow", Principal: { AWS: "*" }, Action: "kms:*", Resource: "*" }] }); })).includes("broad-kms-sign"));
});

test("signer ingress must be linked to a public-address instance", () => {
  for (const change of [
    (r) => { r.aws_instance.signer.associate_public_ip_address = false; },
    (r) => { r.aws_instance.signer.vpc_security_group_ids = ["${aws_security_group.other.id}"]; },
    (r) => { r.aws_security_group.signer.ingress[0].cidr_blocks = ["10.0.0.0/8"]; },
    (r) => { r.aws_security_group.signer.ingress[0].cidr_blocks = []; r.aws_security_group.signer.ingress[0].ipv6_cidr_blocks = ["::/0"]; },
  ]) assert.ok(!checks(terraform(change)).includes("internet-signer-security-group"));
});

test("RPC admin exposure requires a public load balancer, matching selector, port and listener", () => {
  for (const [from, to] of [
    ["--http.addr=0.0.0.0", "--http.addr=127.0.0.1"],
    ["--http.api=eth,net,web3,admin,debug,personal", "--http.api=eth,net,web3"],
    ["targetPort: 8545", "targetPort: 8546"],
    ["type: LoadBalancer\n  selector:", "type: ClusterIP\n  selector:"],
    ["name: rpc\n  namespace: signers\nspec:\n  type:", "name: rpc\n  namespace: other\nspec:\n  type:"],
  ]) assert.ok(!checks(replaceKube(from, to)).includes("internet-rpc-admin-namespaces"));
  const internal = replaceKube("name: rpc\n  namespace: signers\nspec:\n  type:", "name: rpc\n  namespace: signers\n  annotations:\n    service.beta.kubernetes.io/aws-load-balancer-internal: 'true'\nspec:\n  type:");
  assert.ok(!checks(internal).includes("internet-rpc-admin-namespaces"));
});

test("CI exec finding follows the RoleBinding and requires pods/exec permission", () => {
  for (const [from, to] of [["resources: [\"pods\", \"pods/exec\"]", "resources: [\"pods\"]"], ["verbs: [\"get\", \"list\", \"create\"]", "verbs: [\"get\", \"list\"]"], ["kind: Role\n  name: ci-exec", "kind: Role\n  name: unrelated"], ["resources: [\"pods\", \"pods/exec\"]", "resources: [\"pods\", \"pods/exec\"]\n    resourceNames: [unrelated-pod]"]]) {
    assert.ok(!checks(replaceKube(from, to)).includes("ci-can-exec-signers"));
  }
  assert.ok(checks(replaceKube('apiGroups: [""]', 'apiGroups: ["*"]')).includes("ci-can-exec-signers"));
});

test("bucket controls remove their findings without hiding an unrelated CI write grant", () => {
  const fixed = terraform((r) => {
    r.aws_s3_bucket.frontend.object_lock_enabled = true;
    r.aws_s3_bucket_versioning.frontend.versioning_configuration.status = "Enabled";
    r.aws_s3_bucket_public_access_block.frontend.ignore_public_acls = true;
  });
  for (const name of ["frontend-object-lock-missing", "frontend-versioning-disabled", "frontend-public-write"]) assert.ok(!checks(fixed).includes(name));
  assert.ok(checks(fixed).includes("ci-can-write-frontend"));
  assert.ok(!checks(terraform((r) => { r.aws_iam_role_policy.ci_frontend.policy = JSON.stringify({ Statement: [{ Effect: "Allow", Action: "s3:PutObject", Resource: "arn:aws:s3:::unrelated/*" }] }); })).includes("ci-can-write-frontend"));
});

test("unresolved bucket settings remain coverage gaps, not proven disabled controls", () => {
  const s = terraform((r) => { r.aws_s3_bucket.frontend.object_lock_enabled = "${var.lock}"; r.aws_s3_bucket_versioning.frontend.versioning_configuration.status = "${var.versioning}"; });
  const r = analyze(s);
  assert.ok(!r.leads.some((l) => ["frontend-object-lock-missing", "frontend-versioning-disabled"].includes(l.check)));
  assert.deepEqual(r.coverage.filter((c) => c.status === "unresolved").map((c) => c.property).sort(), ["bucket Object Lock", "bucket versioning"].sort());
});

test("wallet literals in task environments are redacted; references and invalid scalars are not keys", () => {
  const key = "1".padStart(64, "0");
  const s = { files: { "task.tf.json": JSON.stringify({ resource: { aws_ecs_task_definition: { signer: { container_definitions: JSON.stringify([{ name: "signer", environment: [{ name: "HOT_WALLET_PRIVATE_KEY", value: `0x${key}` }] }]) } } } }) } };
  assert.equal(analyze(s).leads[0].address, "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
  assert.ok(!JSON.stringify(analyze(s)).includes(key));
  for (const value of ["${var.private_key}", `0x${"0".repeat(64)}`]) {
    s.files["task.tf.json"] = JSON.stringify({ resource: { aws_ecs_task_definition: { signer: { container_definitions: JSON.stringify([{ environment: [{ name: "HOT_WALLET_PRIVATE_KEY", value }] }]) } } } });
    assert.deepEqual(analyze(s).leads, []);
  }
});

test("evidence replay refuses changed source pins and forged resource locations", async () => {
  const ws = makeLabWorkspace();
  try {
    const snapshot = captureSnapshot(ws), snapshotHash = pinSnapshot(ws, snapshot);
    const lead = analyze(snapshot).leads.find((l) => l.check === "broad-kms-sign");
    const evidence = { check: lead.check, where: lead.where, snapshotHash };
    assert.equal((await replayEvidence(ws, evidence, { detectors: cryptoDetectors() })).status, "pass");
    assert.equal((await replayEvidence(ws, { ...evidence, where: { ...lead.where, resource: "aws_kms_key.unrelated" } }, { detectors: cryptoDetectors() })).status, "fail");
    writeFileSync(join(ws, "snapshot.json"), readFileSync(join(ws, "snapshot.json"), "utf8") + "\n");
    assert.equal((await replayEvidence(ws, evidence, { detectors: cryptoDetectors() })).status, "fail");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("moto seeds only a supported throwaway bucket from the pinned source", () => {
  assert.equal(cloudSeed(original).bucket, "touchstone-lab-frontend");
  assert.throws(() => cloudSeed(terraform((r) => { r.aws_s3_bucket.frontend.bucket = "real-production-bucket"; })), /throwaway/);
  assert.throws(() => cloudSeed(terraform((r) => { r.aws_s3_bucket_versioning.frontend.versioning_configuration.status = "${var.status}"; })), /Unresolved/);
});
