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
import { COSIGN, buildCosignImage, classify, cosignDetectors, cosignScan, parsePolicy, signingPin, verifyBlob } from "../packs/supply-chain/cosign.mjs";
import { makeCosignLab, newKey, signBundle } from "../packs/supply-chain/cosign-lab.mjs";
import { captureSnapshot } from "../packs/supply-chain/snapshot.mjs";
import { makeLabWorkspace } from "../packs/supply-chain/lab.mjs";
import pack from "../packs/supply-chain/pack.mjs";
import { replayEvidence } from "../lib/proof-evidence.mjs";
import { prepassView } from "../lib/prepass-view.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const temp = () => mkdtempSync(join(tmpdir(), "cosign-test-"));
const remove = (d) => rmSync(d, { recursive: true, force: true });
let lab, policy, snapshot;

// The test never builds the image: a build pulls from a registry. A missing
// image skips the tests that need real cosign.
const noImage = (() => {
  try { execFileSync("docker", ["image", "inspect", COSIGN.image], { stdio: "ignore" }); return false; }
  catch { return `build the image first: docker build -t ${COSIGN.image} spike/packs/supply-chain/cosign`; }
})();

before(() => {
  lab = temp();
  policy = makeCosignLab(lab);
  // The pack pins the operator policy into the snapshot before the scan.
  snapshot = { ...captureSnapshot(lab), signingPolicy: signingPin(policy) };
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

test("real cosign on the lab: one verified, one unsigned lead, one invalid-signature lead, and both replay", { skip: noImage }, async () => {
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
  // The key in `where` is never trusted. A forged key plus its own sha does not replay.
  const other = newKey().publicKey;
  const forgedKey = { publicKey: other.export({ type: "spki", format: "pem" }), keySha256: sha(other.export({ type: "spki", format: "der" })) };
  assert.equal((await d["tool:cosign"](snapshot, { ...invalid.where, ...forgedKey })).ok, false);
  // The verified artifact cannot be passed off as an invalid signature.
  const good = { ...invalid.where, file: "release/wallet-cli.js", artifactSha256: sha(snapshot.files["release/wallet-cli.js"]), bundle: "release/wallet-cli.js.sigstore.json" };
  good.bundleSha256 = sha(snapshot.files[good.bundle]);
  assert.equal((await d["tool:cosign"](snapshot, good)).ok, false);
  assert.equal((await d["tool:cosign"](snapshot, { ...good, ...forgedKey })).ok, false, "a correctly signed artifact with a forged key in where");
  // The replay is tied to the pinned policy: no pin, or a pin with another key, fails.
  const { signingPolicy, ...unpinned } = snapshot;
  assert.equal((await d["tool:cosign"](unpinned, invalid.where)).ok, false);
  assert.equal((await d["artifact-signature-missing"](unpinned, unsigned.where)).ok, false);
  assert.equal((await d["tool:cosign"]({ ...snapshot, signingPolicy: { ...signingPolicy, ...forgedKey } }, invalid.where)).ok, false);
  // An unsigned lead must name an artifact and bundles the policy names.
  const withReadme = { ...snapshot, files: { ...snapshot.files, "README.md": "# app\n" } };
  const readme = { ...unsigned.where, file: "README.md", artifactSha256: sha("# app\n"), bundles: ["README.md.made-up"] };
  assert.equal((await d["artifact-signature-missing"](withReadme, readme)).ok, false);
  assert.equal((await d["artifact-signature-missing"](snapshot, { ...unsigned.where, bundles: ["release/install.sh.made-up"] })).ok, false);
  // An unsigned lead fails once a bundle appears.
  const signed = { ...snapshot, files: { ...snapshot.files, "release/install.sh.sigstore.json": "{}" } };
  assert.equal((await d["artifact-signature-missing"](signed, unsigned.where)).ok, false);
});

test("a tampered artifact, signed by the pinned key before the change, is an invalid signature", { skip: noImage }, async () => {
  const k = newKey();
  const pub = k.publicKey.export({ type: "spki", format: "pem" });
  const bundle = signBundle(Buffer.from("release v1\n"), k.privateKey, k.publicKey);
  assert.equal((await verifyBlob({ artifact: "release v1\n", bundle, publicKey: pub })).result, "verified");
  assert.equal((await verifyBlob({ artifact: "release v1 with a backdoor\n", bundle, publicKey: pub })).result, "invalid-signature");
});

test("tool failures are gaps, never a pass and never a lead", { skip: noImage }, async () => {
  // Missing image: the unsigned lead needs no tool and stays; the bundled artifacts are gaps.
  const missing = await cosignScan(snapshot, policy, { image: "touchstone-cosign:not-built" });
  assert.equal(missing.status, "gap");
  assert.deepEqual(missing.leads.map((l) => l.check), ["artifact-signature-missing"]);
  assert.deepEqual(missing.gaps.map((g) => g.file), ["release/wallet-cli.js", "release/updater.js"]);
  assert.match(missing.gaps[0].detail, /^image touchstone-cosign:not-built is not built\./);
  assert.match(missing.reason, /^image touchstone-cosign:not-built is not built\./);
  // Timeout: the engine is a gap with timedOut, never "ok". The unsigned lead stays.
  const slow = await cosignScan(snapshot, policy, { timeoutMs: 1 });
  assert.equal(slow.status, "gap");
  assert.equal(slow.timedOut, true);
  assert.match(slow.reason, /^2 of 3 artifact signatures unchecked \(cosign timed out\)/);
  assert.deepEqual(slow.leads.map((l) => l.check), ["artifact-signature-missing"]);
  assert.equal(slow.gaps.length, 2);
  assert.match(slow.gaps[0].detail, /timed out/);
  // No docker on PATH at all: also a gap, not a clean run.
  const empty = temp(), path = process.env.PATH;
  let nodocker;
  try { process.env.PATH = empty; nodocker = await cosignScan(snapshot, policy); }
  finally { process.env.PATH = path; remove(empty); }
  assert.equal(nodocker.status, "gap");
  assert.equal(nodocker.timedOut, false);
  assert.match(nodocker.reason, /^2 of 3 artifact signatures unchecked \(cosign could not decide: exit 1\)/);
  assert.deepEqual(nodocker.leads.map((l) => l.check), ["artifact-signature-missing"]);
  // The run view shows both as not run, with the reason, never as "ran".
  for (const r of [slow, nodocker, missing]) {
    const view = prepassView({ coverage: [{ engine: r.engine, status: r.status, code: r.code, timedOut: r.timedOut, reason: r.reason, leads: r.leads.length }], leads: [] });
    assert.equal(view.tools[0].status, "unavailable");
    assert.match(view.tools[0].reason, /unchecked|not built/);
  }
  // A bundle cosign cannot parse is not a signature verdict.
  const broken = { ...snapshot, files: { ...snapshot.files, "release/updater.js.sigstore.json": "{\"x\":1}\n" } };
  const unparsable = await cosignScan(broken, policy);
  assert.equal(unparsable.status, "gap");
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
  // No policy: the check does not apply. The pack's coverage row and the run view must not say "ran".
  const none = await cosignScan(snapshot, undefined);
  assert.equal(none.status, "not-applicable");
  assert.equal(none.applicable, false);
  assert.match(none.reason, /^No signing policy/);
  assert.equal(none.gaps[0].kind, "signatures-not-verified");
  const ws = temp();
  try {
    makeCosignLab(ws);
    const { record } = await pack.prepass(ws, {});
    const row = record.coverage.find((c) => c.engine === "cosign");
    assert.equal(row.applicable, false);
    assert.equal(record.coverage.filter((c) => c.engine !== "cosign" && "applicable" in c).length, 0);
    const view = prepassView(record).tools.find((t) => t.name === "cosign");
    assert.equal(view.status, "unavailable");
    assert.match(view.reason, /^No signing policy/);
    assert.ok(record.gaps.some((g) => g.kind === "signatures-not-verified"));
  } finally { remove(ws); }
  const big = { ...snapshot, files: { ...snapshot.files }, skipped: [{ file: "release/app.tar.gz", reason: "binary-or-not-utf8" }] };
  const r = await cosignScan(big, { ...policy, artifacts: ["release/app.tar.gz", "release/gone.js"] });
  assert.equal(r.status, "gap");
  assert.match(r.reason, /^2 of 2 artifact signatures unchecked/);
  assert.deepEqual(r.leads, []);
  assert.deepEqual(r.gaps.map((g) => g.detail.split(".")[0]), ["Artifact was skipped by the snapshot (binary, too large or over budget)", "Artifact named in the signing policy is not in the snapshot"]);
});

test("the full lab prepass: cosign finds the bad signature no other engine saw, and the pack's replay passes", { skip: noImage }, async () => {
  const ws = await makeLabWorkspace();
  try {
    assert.ok(JSON.parse(readFileSync(join(ws, ".touchstone.json"), "utf8")).cosign.publicKey.startsWith("-----BEGIN PUBLIC KEY-----"));
    const { record } = await pack.prepass(ws, {});
    // The policy is part of the pinned snapshot, so the replay can check against it.
    const pinnedSnap = JSON.parse(readFileSync(join(ws, "snapshot.json"), "utf8"));
    assert.equal(pinnedSnap.signingPolicy.artifacts.length, 3);
    assert.match(pinnedSnap.signingPolicy.keySha256, /^[0-9a-f]{64}$/);
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

// buildCosignImage runs only the exec it is given; here nothing reaches docker.
test("buildCosignImage reports a failed build as a reason, not a throw", () => {
  const calls = [];
  const err = buildCosignImage((cmd, args) => { calls.push(args[0]); throw new Error("no docker"); });
  assert.match(err, /Could not build touchstone-cosign:v3\.1\.4/);
  assert.deepEqual(calls, ["image", "build"]);
  assert.equal(buildCosignImage((cmd, args) => { calls.push(args[0]); }), null);
});
