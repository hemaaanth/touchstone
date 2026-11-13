// Run with: node --experimental-test-module-mocks --test spike/packs/contracts/vacuity-gate/gate.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const dir = path.dirname(fileURLToPath(import.meta.url));
const project = path.join(dir, "fixtures/property-spike");
const image = "ghcr.io/foundry-rs/foundry@sha256:3a392c18f9b16e665e932de159fb6fa9ed972c4b4352f2f76a1a8c7ca9b57d39";
const available = spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" }).status === 0 &&
  ["foundry-svm", "touchstone_svm_cache"].some((v) => spawnSync("docker", ["volume", "inspect", v], { stdio: "ignore" }).status === 0);

function gate(file, args = [], root = project) {
  const run = spawnSync(process.execPath, [path.join(dir, "gate.mjs"), "--project", root,
    "--test", `test/${file}.t.sol`, ...args], { encoding: "utf8", timeout: 300_000 });
  assert.ifError(run.error);
  assert.ok(run.stdout, run.stderr);
  return { status: run.status, verdict: JSON.parse(run.stdout) };
}

for (const [fixture, args, reason] of [
  ["ReviewFail", ["--known-bug"], /control: healthy reference/],
  ["ReviewGreen", [], /mutants: killed 0/],
  ["ReviewSkip", [], /mutants: killed 0/],
  ["ReviewRollback", [], /rolled back|no committed/],
  ["ReviewSample", [], /no committed|incomplete campaign/],
  ["ReviewRoundTrip", [], /no committed/],
  ["ReviewSetup", ["--known-bug"], /known-bug: no new invariant Failure/],
  ["ReviewHiddenHash", [], /code fingerprint reads/],
  ["FeeVaultInvariantsFixed", ["--known-bug"], /selector\(s\) never succeeded/],
]) {
  test(`${fixture} cannot pass`, { skip: !available && "pinned offline Forge image and solc cache required" }, () => {
    const { status, verdict } = gate(fixture, args);
    assert.equal(status, 1);
    assert.equal(verdict.pass, false);
    assert.match(verdict.reasons.join(" "), reason);
    if (["ReviewGreen", "ReviewSkip", "ReviewSample", "ReviewSetup"].includes(fixture)) assert.equal(verdict.killRate, 0);
    if (fixture === "ReviewSetup") assert.equal(verdict.knownBug.detected, false);
    if (fixture === "ReviewRoundTrip") {
      assert.equal(verdict.liveness.storageChanges, 0);
      assert.equal(verdict.liveness.balanceChanges, 0);
    }
  });
}

test("ReviewProof accepts behavioral control and new mutant failures", { skip: !available && "pinned offline Forge image and solc cache required" }, () => {
  const { status, verdict } = gate("ReviewProof", ["--known-bug"]);
  assert.equal(status, 0, JSON.stringify(verdict.reasons));
  assert.equal(verdict.pass, true);
  assert.ok(verdict.liveness.storageChanges > 0 || verdict.liveness.balanceChanges > 0);
  assert.equal(verdict.knownBug.detected, true);
  assert.ok(verdict.mutants.some((m) => m.killed && m.failingInvariants.includes("invariant_behaviour()")));
});

test("external symlinked test is rejected before reading outside the project", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "vacuity-symlink-"));
  try {
    fs.mkdirSync(path.join(temp, "test"));
    fs.symlinkSync(path.join(dir, "gate.mjs"), path.join(temp, "test/External.t.sol"));
    const { status, verdict } = gate("External", [], temp);
    assert.equal(status, 1);
    assert.match(verdict.error, /test symlink forbidden/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
