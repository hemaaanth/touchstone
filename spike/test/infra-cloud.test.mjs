import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyze, cryptoDetectors } from "../packs/infra-cloud/checks.mjs";
import { captureSnapshot, makeLabWorkspace } from "../packs/infra-cloud/snapshot.mjs";
import { cloudSeed } from "../packs/infra-cloud/cloud.mjs";
import { liveSeed, oracle, redactProof } from "../packs/infra-cloud/live-cloud.mjs";
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
  assert.deepEqual([...new Set(result.leads.map((l) => l.check))].sort(), ["broad-kms-sign", "ci-can-exec-signers", "ci-can-write-frontend", "exposed-signer-service", "frontend-object-lock-missing", "frontend-public-write", "frontend-versioning-disabled", "hot-wallet-key-in-config", "iam-role-broad-object-read", "internet-rpc-admin-namespaces", "internet-signer-security-group", "public-signer-load-balancer"].sort());
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

test("broad object read needs a wildcard-trust role and a wildcard resource grant", () => {
  const policy = (change) => terraform((r) => {
    const p = JSON.parse(r.aws_iam_role_policy.ci_runner_read.policy);
    change(p.Statement[0], p);
    r.aws_iam_role_policy.ci_runner_read.policy = JSON.stringify(p);
  });
  for (const snapshot of [
    terraform((r) => { r.aws_iam_role_policy.ci_runner_read.policy = JSON.stringify({ Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "arn:aws:s3:::touchstone-lab-app/*" }] }); }),
    policy((s) => { s.Resource = "*"; s.Condition = { Bool: { "aws:SecureTransport": "true" } }; }),
    policy((s) => { s.Action = "s3:PutObject"; }),
    policy((s, p) => { p.Statement.push({ Effect: "Deny", Action: "s3:GetObject", Resource: "*" }); }),
    terraform((r) => { r.aws_iam_role.ci_runner.assume_role_policy_document = JSON.stringify({ Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::123456789012:root" }, Action: "sts:AssumeRole" }] }); }),
    terraform((r) => { r.aws_iam_role_policy.ci_runner_read.role = "${aws_iam_role.other.id}"; }),
  ]) assert.ok(!checks(snapshot).includes("iam-role-broad-object-read"));
  // Resource "*" and an action wildcard both still count.
  assert.ok(checks(policy((s) => { s.Resource = "*"; })).includes("iam-role-broad-object-read"));
  assert.ok(checks(policy((s) => { s.Action = "s3:*"; })).includes("iam-role-broad-object-read"));
});

test("a conditioned trust is not a broad trust, because real AWS denies it", () => {
  const trust = (statement) => terraform((r) => { r.aws_iam_role.ci_runner.assume_role_policy_document = JSON.stringify({ Statement: [statement] }); });
  // ExternalId is the classic case: a wildcard principal alone is not enough.
  assert.ok(!checks(trust({ Effect: "Allow", Principal: "*", Action: "sts:AssumeRole", Condition: { StringEquals: { "sts:ExternalId": "touchstone" } } })).includes("iam-role-broad-object-read"));
  assert.ok(!checks(trust({ Effect: "Allow", Principal: { AWS: "*" }, Action: "sts:AssumeRole", Condition: { StringEquals: { "aws:PrincipalOrgID": "o-lab" } } })).includes("iam-role-broad-object-read"));
  assert.ok(!checks(trust({ Effect: "Allow", NotPrincipal: { AWS: "arn:aws:iam::1:root" }, Action: "sts:AssumeRole" })).includes("iam-role-broad-object-read"));
  // An explicit Deny of AssumeRole wins over an Allow.
  assert.equal(checks(trust({ Effect: "Allow", Principal: "*", Action: "sts:AssumeRole" })).filter((c) => c === "iam-role-broad-object-read").length, 1);
  const denied = terraform((r) => { r.aws_iam_role.ci_runner.assume_role_policy_document = JSON.stringify({ Statement: [
    { Effect: "Allow", Principal: "*", Action: "sts:AssumeRole" },
    { Effect: "Deny", Principal: "*", Action: "sts:AssumeRole" },
  ] }); });
  assert.ok(!checks(denied).includes("iam-role-broad-object-read"));
});

test("a role reference must be the whole expression, and an index is allowed", () => {
  for (const role of ["${aws_iam_role.ci_runner.name}extra", "${aws_iam_role.ci_runner_x.name}", "${aws_iam_role.ci_runner.name}-blue"]) {
    assert.ok(!checks(terraform((r) => { r.aws_iam_role_policy.ci_runner_read.role = role; })).includes("iam-role-broad-object-read"), role);
  }
  for (const role of ["${aws_iam_role.ci_runner[0].name}", "${aws_iam_role.ci_runner[count.index].id}", "aws_iam_role.ci_runner[each.key].arn"]) {
    assert.ok(checks(terraform((r) => { r.aws_iam_role_policy.ci_runner_read.role = role; })).includes("iam-role-broad-object-read"), role);
    assert.equal(liveSeed(terraform((r) => { r.aws_iam_role_policy.ci_runner_read.role = role; }), { resource: "aws_iam_role_policy.ci_runner_read" }).roleName, "ci_runner", role);
  }
});

test("broad object read also reads the CloudFormation shape", () => {
  const cfn = { files: { "stack.json": JSON.stringify({
    Resources: {
      Role: { Type: "AWS::IAM::Role", Properties: { AssumeRolePolicyDocument: { Statement: [{ Effect: "Allow", Principal: { AWS: "*" }, Action: "sts:AssumeRole" }] } } },
      Grant: { Type: "AWS::IAM::Policy", Properties: { Roles: [{ Ref: "Role" }], PolicyDocument: { Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "arn:aws:s3:::*" }] } } },
    },
  }) } };
  assert.deepEqual(checks(cfn), ["iam-role-broad-object-read"]);
  cfn.files["stack.json"] = cfn.files["stack.json"].replace('"s3:GetObject"', '"s3:ListBucket"');
  assert.deepEqual(checks(cfn), []);
});

test("the live seed follows the cited policy and refuses an unattached one", () => {
  const seed = liveSeed(original, { resource: "aws_iam_role_policy.ci_runner_read" });
  assert.equal(seed.roleName, "ci_runner");
  assert.match(JSON.stringify(seed.policy), /s3:GetObject/);
  assert.match(JSON.stringify(seed.trust), /sts:AssumeRole/);
  assert.throws(() => liveSeed(original, { resource: "aws_iam_role_policy.missing" }), /not in the snapshot/);
  assert.throws(() => liveSeed(original, { resource: "nonsense" }), /no resource/);
  // `role = aws_iam_role.x.name` and the `.name` interpolation both resolve.
  for (const role of ["${aws_iam_role.ci_runner.name}", "aws_iam_role.ci_runner.name"]) {
    const snapshot = terraform((r) => { r.aws_iam_role_policy.ci_runner_read.role = role; });
    assert.equal(liveSeed(snapshot, { resource: "aws_iam_role_policy.ci_runner_read" }).roleName, "ci_runner", role);
  }
});

test("the canonical broad object ARN counts as every bucket", () => {
  for (const resource of ["arn:aws:s3:::*/*", "arn:aws:s3:::*"]) {
    assert.ok(checks(terraform((r) => { r.aws_iam_role_policy.ci_runner_read.policy = JSON.stringify({ Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: resource }] }); })).includes("iam-role-broad-object-read"), resource);
  }
  assert.ok(!checks(terraform((r) => { r.aws_iam_role_policy.ci_runner_read.policy = JSON.stringify({ Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "arn:aws:s3:::touchstone-lab-app/*" }] }); })).includes("iam-role-broad-object-read"));
});

test("the rendered proof carries no credential value", () => {
  const proof = {
    kind: "http", status: "pass", detail: "x", oracle: { name: "o", detail: "x", passed: true },
    log: [
      { label: "seed", request: { method: "GET", url: "http://lab/__lab.json", headers: { host: "lab" }, body: null },
        response: { status: 200, headers: {}, body: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "s3cr3tValueThatIsLongEnough", roleArn: "arn:x" } } },
      { label: "assume", request: { method: "POST", url: "http://lab/", headers: { authorization: "AWS4-HMAC-SHA256 Credential=AKIA/SECRET", "x-amz-security-token": "tok" }, body: "Action=AssumeRole&" },
        response: { status: 200, headers: {}, body: "<Credentials><AccessKeyId>ASIAX</AccessKeyId><SecretAccessKey>temporarySecretValue</SecretAccessKey><SessionToken>sessionTokenValue</SessionToken></Credentials>" } },
      { label: "read", request: { method: "GET", url: "http://lab/b/k", headers: { "x-amz-security-token": "AsiAtoken" }, body: null },
        response: { status: 200, headers: {}, body: { marker: "ts-treasury-7f3a" } } },
    ],
  };
  const shown = JSON.stringify(redactProof(proof));
  assert.ok(!shown.includes("s3cr3tValueThatIsLongEnough"));
  assert.ok(!shown.includes("temporarySecretValue"));
  assert.ok(!shown.includes("sessionTokenValue"));
  assert.ok(!shown.includes("AsiAtoken"));
  assert.ok(!shown.includes("AKIA/SECRET"));
  assert.ok(shown.includes("ts-treasury-7f3a"), "the harm stays visible");
  // A body shape no current script sends is still covered.
  const future = { ...proof, log: [{ ...proof.log[2], response: { status: 200, headers: {}, body: { sessionToken: "unScrubbedFutureToken", password: "pw", credential: "cred", note: "keep" } } }] };
  const later = JSON.stringify(redactProof(future));
  assert.ok(!later.includes("unScrubbedFutureToken"));
  assert.ok(!later.includes('"pw"') && !later.includes('"cred"'));
  assert.ok(later.includes('"keep"'));
  assert.ok(shown.includes('"accessKeyId":"AKIAEXAMPLE"'), "a key id is not a secret");
});

test("the live oracle needs the assume, the role identity, the read and the marker", () => {
  const role = "ci_runner";
  const ok = [
    { method: "POST", path: "/", status: 200, reqBody: "Action=AssumeRole&Version=2011-06-15", resBody: "<AccessKeyId>ASIA</AccessKeyId><SecretAccessKey>s</SecretAccessKey><SessionToken>the-token</SessionToken>" },
    { method: "POST", path: "/", status: 200, reqBody: "Action=GetCallerIdentity", resBody: `<Arn>arn:aws:sts::1:assumed-role/${role}/attacker</Arn>` },
    { method: "GET", path: "/touchstone-lab-treasury/wallets.json", status: 200, reqHeaders: { "x-amz-security-token": "the-token" }, resBody: { marker: "ts-treasury-7f3a" } },
  ];
  const check = (t) => oracle(role).check(t);
  assert.equal(check(ok).pass, true);
  assert.match(check(ok).detail, /assumed ci_runner/);
  assert.equal(check(ok.slice(1)).pass, false, "no assume");
  assert.equal(check([ok[0], { ...ok[1], resBody: "<Arn>arn:aws:sts::1:assumed-role/other/x</Arn>" }, ok[2]]).pass, false, "wrong identity");
  assert.equal(check([ok[0], ok[1], { ...ok[2], status: 403 }]).pass, false, "read denied");
  assert.equal(check([ok[0], ok[1], { ...ok[2], resBody: { marker: "nope" } }]).pass, false, "no object body");
  assert.equal(check([ok[0], ok[1], { ...ok[2], reqHeaders: { "x-amz-security-token": "other" } }]).pass, false, "another session");
  assert.equal(check([{ ...ok[0], reqBody: "Action=AssumeRoleWithWebIdentity" }, ok[1], ok[2]]).pass, false, "web identity is not AssumeRole");
});

test("the snapshot skips binaries, symlinks and oversized files instead of stopping", () => {
  const ws = makeLabWorkspace();
  try {
    writeFileSync(join(ws, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    writeFileSync(join(ws, "big.yaml"), "a: b\n".repeat(150_000));
    const snapshot = captureSnapshot(ws);
    assert.ok(!("logo.png" in snapshot.files));
    assert.ok(!("big.yaml" in snapshot.files));
    assert.deepEqual(snapshot.skipped.map((s) => s.reason).sort(), ["dot name", "larger than 512 KiB", "not UTF-8 text"]);
    assert.ok(snapshot.skipped.some((s) => s.file === ".touchstone.json"), "a dotfile is recorded, not silent");
    assert.ok("main.tf.json" in snapshot.files);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("the live seed and the board can be read for one lead only", async () => {
  const ws = makeLabWorkspace();
  try {
    await (await import("../packs/infra-cloud/pack.mjs")).default.prepass(ws, { emit: () => {} });
    const pack = (await import("../packs/infra-cloud/pack.mjs")).default;
    const tools = Object.fromEntries(pack.tools(ws, { poc: 0, passed: new Map(), found: [] }).map((t) => [t.name, t]));
    const board = JSON.parse((await tools.infrastructure_leads.execute({ ids: "9, 47" })).output[0].text).leads;
    assert.deepEqual(board.map((l) => l.id).sort(), ["47", "9"]);
    assert.ok(board.some((l) => l.check === "iam-role-broad-object-read"));
    assert.ok(JSON.parse((await tools.infrastructure_leads.execute({})).output[0].text).leads.length > 100);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});
