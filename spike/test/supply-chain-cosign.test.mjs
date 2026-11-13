// cosign: offline verify-blob of lab release artifacts against a pinned key.
// The real tool runs through the real runTool(). The image is built from
// packs/supply-chain/cosign/Dockerfile if it is not local yet (build time only).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { COSIGN, buildCosignImage, classify, cosignDetectors, cosignScan, parsePolicy, verifyBlob } from "../packs/supply-chain/cosign.mjs";
import { makeCosignLab, newKey, signBundle } from "../packs/supply-chain/cosign-lab.mjs";
import { captureSnapshot } from "../packs/supply-chain/snapshot.mjs";
import { makeLabWorkspace } from "../packs/supply-chain/lab.mjs";
import pack from "../packs/supply-chain/pack.mjs";
import { replayEvidence } from "../lib/proof-evidence.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const temp = () => mkdtempSync(join(tmpdir(), "cosign-test-"));
const remove = (d) => rmSync(d, { recursive: true, force: true });
let lab, policy, snapshot;

before(() => {
  const err = buildCosignImage();
  if (err) throw new Error(err);
  lab = temp();
  policy = makeCosignLab(lab);
  snapshot = captureSnapshot(lab);
});

test("cosign runs from a digest-pinned local image, offline, with no transparency log or TUF fetch", async () => {
  const dockerfile = readFileSync(new URL("../packs/supply-chain/cosign/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /^FROM ghcr\.io\/sigstore\/cosign\/cosign:v3\.1\.4@sha256:[0-9a-f]{64}$/m);
  assert.equal(COSIGN.image, "touchstone-cosign:v3.1.4");
  // Record the real argv runTool builds, with a fake docker first on PATH.
  const dir = temp(), record = join(dir, "args"), path = process.env.PATH;
  try {
    writeFileSync(join(dir, "docker"), `#!/bin/sh\nprintf "%s\\n" "$@" > "${record}"\necho "Verified OK" >&2\nexit 0\n`, { mode: 0o755 });
    process.env.PATH = `${dir}:${path}`;
    const r = await verifyBlob({ artifact: "a", bundle: "{}", publicKey: policy.publicKey });
    assert.equal(r.result, "verified");
    const argv = readFileSync(record, "utf8").trim().split("\n");
    assert.deepEqual(argv.slice(0, 5), ["run", "--rm", "--pull=never", "--network", "none"]);
    const cmd = argv.slice(argv.indexOf(COSIGN.image) + 1);
    assert.deepEqual(cmd, ["verify-blob", "--key", "/work/key.pub", "--bundle", "/work/bundle.json", "--insecure-ignore-tlog=true", "/work/blob"]);
  } finally { process.env.PATH = path; remove(dir); }
});

test("real cosign on the lab: one verified, one unsigned lead, one invalid-signature lead, and both replay", async () => {
  const r = await cosignScan(snapshot, policy);
  assert.equal(r.status, "ok");
  assert.match(r.reason, /^3 artifacts: 1 verified, 1 invalid signature, 1 unsigned, 0 unchecked/);
  assert.deepEqual(r.gaps, []);
  assert.deepEqual(r.leads.map((l) => [l.engine, l.check, l.file, l.impact]), [
    ["Touchstone", "artifact-signature-missing", "release/install.sh", "Medium"],
    ["cosign", "cosign/invalid-signature", "release/updater.js", "High"],
  ]);
  const d = cosignDetectors();
  const [unsigned, invalid] = r.leads;
  assert.equal((await d["artifact-signature-missing"](snapshot, unsigned.where)).ok, true);
  assert.equal((await d["tool:cosign"](snapshot, invalid.where)).ok, true);
  // The replay binds the exact bytes, the bundle and the key.
  const changed = { ...snapshot, files: { ...snapshot.files, "release/updater.js": snapshot.files["release/updater.js"] + "\n" } };
  assert.equal((await d["tool:cosign"](changed, invalid.where)).ok, false);
  assert.equal((await d["tool:cosign"](snapshot, { ...invalid.where, keySha256: "0".repeat(64) })).ok, false);
  assert.equal((await d["tool:cosign"](snapshot, { ...invalid.where, publicKey: newKey().publicKey.export({ type: "spki", format: "pem" }) })).ok, false);
  // The verified artifact cannot be passed off as an invalid signature.
  const good = { ...invalid.where, file: "release/wallet-cli.js", artifactSha256: sha(snapshot.files["release/wallet-cli.js"]), bundle: "release/wallet-cli.js.sigstore.json" };
  good.bundleSha256 = sha(snapshot.files[good.bundle]);
  assert.equal((await d["tool:cosign"](snapshot, good)).ok, false);
  // An unsigned lead fails once a bundle appears.
  const signed = { ...snapshot, files: { ...snapshot.files, "release/install.sh.sigstore.json": "{}" } };
  assert.equal((await d["artifact-signature-missing"](signed, unsigned.where)).ok, false);
});

test("a tampered artifact, signed by the pinned key before the change, is an invalid signature", async () => {
  const k = newKey();
  const pub = k.publicKey.export({ type: "spki", format: "pem" });
  const bundle = signBundle(Buffer.from("release v1\n"), k.privateKey, k.publicKey);
  assert.equal((await verifyBlob({ artifact: "release v1\n", bundle, publicKey: pub })).result, "verified");
  assert.equal((await verifyBlob({ artifact: "release v1 with a backdoor\n", bundle, publicKey: pub })).result, "invalid-signature");
});

test("tool failures are gaps, never a pass and never a lead", async () => {
  // Missing image: the unsigned lead needs no tool and stays; the bundled artifacts are gaps.
  const missing = await cosignScan(snapshot, policy, { image: "touchstone-cosign:not-built" });
  assert.equal(missing.status, "gap");
  assert.deepEqual(missing.leads.map((l) => l.check), ["artifact-signature-missing"]);
  assert.deepEqual(missing.gaps.map((g) => g.file), ["release/wallet-cli.js", "release/updater.js"]);
  assert.match(missing.gaps[0].detail, /not built/);
  // Timeout.
  const slow = await cosignScan(snapshot, policy, { timeoutMs: 1 });
  assert.equal(slow.leads.filter((l) => l.engine === "cosign").length, 0);
  assert.equal(slow.gaps.length, 2);
  assert.match(slow.gaps[0].detail, /timed out/);
  // A bundle cosign cannot parse is not a signature verdict.
  const broken = { ...snapshot, files: { ...snapshot.files, "release/updater.js.sigstore.json": "{\"x\":1}\n" } };
  const unparsable = await cosignScan(broken, policy);
  assert.deepEqual(unparsable.leads.map((l) => l.check), ["artifact-signature-missing"]);
  assert.equal(unparsable.gaps.length, 1);
  assert.match(unparsable.gaps[0].detail, /^cosign could not decide: /);
  // Output that does not match the two exact outcomes is an error.
  assert.equal(classify({ code: 0, stderr: "", timedOut: false }).result, "error");
  assert.equal(classify({ code: 1, stderr: "Error: something else\n", timedOut: false }).result, "error");
  assert.equal(classify({ code: 125, stderr: "Error response from daemon: No such image: x\n", timedOut: false }).result, "unavailable");
});

test("policy problems are explicit: a bad policy is an error, no policy leaves bundles as a gap, a skipped artifact is a gap", async () => {
  assert.equal(parsePolicy(undefined), null);
  for (const bad of [{}, { publicKey: "nope", artifacts: ["a"] }, { publicKey: policy.publicKey, artifacts: [] }, { publicKey: policy.publicKey, artifacts: ["../etc/passwd"] }, { publicKey: policy.publicKey, artifacts: ["/abs"] }]) {
    const r = await cosignScan(snapshot, bad);
    assert.equal(r.status, "error", JSON.stringify(bad).slice(0, 60));
    assert.equal(r.gaps[0].kind, "signature-policy-invalid");
  }
  const none = await cosignScan(snapshot, undefined);
  assert.equal(none.status, "ok");
  assert.match(none.reason, /no signing policy/);
  assert.equal(none.gaps[0].kind, "signatures-not-verified");
  const big = { ...snapshot, files: { ...snapshot.files }, skipped: [{ file: "release/app.tar.gz", reason: "binary-or-not-utf8" }] };
  const r = await cosignScan(big, { ...policy, artifacts: ["release/app.tar.gz", "release/gone.js"] });
  assert.deepEqual(r.leads, []);
  assert.deepEqual(r.gaps.map((g) => g.detail.split(".")[0]), ["Artifact was skipped by the snapshot (binary, too large or over budget)", "Artifact named in the signing policy is not in the snapshot"]);
});

test("the full lab prepass: cosign finds the bad signature no other engine saw, and the pack's replay passes", async () => {
  const ws = await makeLabWorkspace();
  try {
    assert.ok(JSON.parse(readFileSync(join(ws, ".touchstone.json"), "utf8")).cosign.publicKey.startsWith("-----BEGIN PUBLIC KEY-----"));
    const { record } = await pack.prepass(ws, {});
    const cov = record.coverage.find((c) => c.engine === "cosign");
    assert.equal(cov.status, "ok");
    assert.equal(cov.leads, 2);
    const invalid = record.leads.filter((l) => l.check === "cosign/invalid-signature");
    assert.equal(invalid.length, 1);
    assert.equal(invalid[0].file, "release/updater.js");
    assert.deepEqual(invalid[0].engines, ["cosign"], "no other engine reported this artifact");
    assert.ok(record.leads.some((l) => l.check === "artifact-signature-missing" && l.file === "release/install.sh"));
    // Before cosign, nothing in the pack looked at the release folder.
    assert.deepEqual(record.leads.filter((l) => l.file?.startsWith("release/") && !["cosign", "Touchstone"].includes(l.engine)), []);
    assert.ok(!record.leads.some((l) => l.file === "release/wallet-cli.js"), "the correctly signed artifact gives no lead");
    // The pack's own proof path: evidence replay against the pinned snapshot.
    const found = record.leads.filter((l) => l.file?.startsWith("release/")).map((l) => ({ severity: "high", evidence: l.evidence }));
    const proven = await pack.prove(ws, found, [], () => {});
    assert.equal(proven.length, 2);
    const forged = await replayEvidence(ws, { ...invalid[0].evidence, where: { ...invalid[0].evidence.where, file: "release/wallet-cli.js" } }, { detectors: cosignDetectors() });
    assert.equal(forged.status, "fail");
  } finally { remove(ws); }
});

test.after(() => { if (lab) remove(lab); });

// Keep the build step honest: the image exists only after buildCosignImage.
test("buildCosignImage reports a failed build as a reason, not a throw", () => {
  const err = buildCosignImage(() => { throw new Error("no docker"); });
  assert.match(err, /Could not build touchstone-cosign:v3\.1\.4/);
  assert.doesNotThrow(() => execFileSync("docker", ["image", "inspect", COSIGN.image], { stdio: "ignore" }));
});
