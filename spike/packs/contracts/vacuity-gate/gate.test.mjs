// Run with: cd spike && node --experimental-test-module-mocks --test packs/contracts/vacuity-gate/gate.test.mjs
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const dir = path.dirname(fileURLToPath(import.meta.url));
const project = path.join(dir, "fixtures/property-spike");
const overlays = path.join(dir, "fixtures/overlays");
const image = "ghcr.io/foundry-rs/foundry:latest@sha256:3a392c18f9b16e665e932de159fb6fa9ed972c4b4352f2f76a1a8c7ca9b57d39";
const available = spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" }).status === 0 &&
  ["foundry-svm", "touchstone_svm_cache"].some((v) => spawnSync("docker", ["volume", "inspect", v], { stdio: "ignore" }).status === 0);
const skip = !available && "pinned offline Forge image and solc cache required";

// Async so that several gate runs can share the wall clock.
function gate(file, args = [], root = project) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(dir, "gate.mjs"), "--project", root, "--test", `test/${file}.t.sol`, ...args],
      { encoding: "utf8", timeout: 900_000, maxBuffer: 64 << 20 }, (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") return reject(error);
        try {
          resolve({ status: error ? error.code : 0, verdict: JSON.parse(stdout) });
        } catch {
          reject(new Error(`no JSON verdict (exit ${error?.code ?? 0}):\n${stderr.slice(-4000)}`));
        }
      });
  });
}

// A throwaway copy of the fixture project with one attack overlay copied on top.
async function withOverlay(name, fn) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `vacuity-${name}-`));
  try {
    fs.cpSync(project, temp, { recursive: true });
    fs.cpSync(path.join(overlays, name), temp, { recursive: true });
    return await fn(temp);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function rejected(status, verdict, reason) {
  assert.equal(status, 1, JSON.stringify(verdict.reasons ?? verdict.error));
  assert.equal(verdict.pass, false);
  assert.match([...(verdict.reasons ?? []), verdict.error ?? ""].join(" "), reason);
}

describe("vacuity gate", { concurrency: 4 }, () => {
  for (const [fixture, args, reason] of [
    ["ReviewFail", ["--known-bug"], /control: healthy reference/],
    ["ReviewGreen", [], /mutants: killed 0/],
    ["ReviewSkip", [], /mutants: killed 0/],
    ["ReviewRollback", [], /rolled back|no committed/],
    ["ReviewSample", [], /no committed|incomplete campaign/],
    ["ReviewRoundTrip", [], /no committed/],
    ["ReviewSetup", ["--known-bug"], /known-bug: no new invariant Failure/],
    ["ReviewHiddenHash", [], /scan: banned/],
    // The agent's original suite: deposit() runs out of funds, so the target never runs it.
    ["FeeVaultInvariants", ["--known-bug"], /1 selector\(s\) never succeeded and never ran to a revert of their own/],
  ]) {
    it(`${fixture} cannot pass`, { skip }, async () => {
      const { status, verdict } = await gate(fixture, args);
      rejected(status, verdict, reason);
      // The verdict says that --known-bug changes nothing; no flag, no note.
      assert.deepEqual(verdict.notes, args.includes("--known-bug") ? ["--known-bug is always on; the flag is accepted and has no effect"] : []);
      if (["ReviewGreen", "ReviewSkip", "ReviewSample", "ReviewSetup"].includes(fixture)) assert.equal(verdict.killRate, 0);
      if (fixture === "ReviewSetup") assert.equal(verdict.knownBug.detected, false);
      if (fixture === "FeeVaultInvariants") assert.deepEqual(verdict.liveness.deadSelectors, ["deposit()"]);
      if (fixture === "ReviewRoundTrip") {
        assert.equal(verdict.liveness.storageChanges, 0);
        assert.equal(verdict.liveness.balanceChanges, 0);
      }
    });
  }

  // B1: vm.getDeployedCode reads the build artifact, not behavior.
  it("B1 ReviewArtifact: getDeployedCode size oracle is rejected", { skip }, async () => {
    const { status, verdict } = await gate("ReviewArtifact", ["--known-bug"]);
    rejected(status, verdict, /scan: banned .*getDeployedCode/);
  });

  // B2: a probe placed under the project's own lib/forge-std must not be trusted.
  it("B2 ReviewVendor: probe under project lib/forge-std is not trusted", { skip }, async () => {
    const { status, verdict } = await withOverlay("vendor-probe", (root) => gate("ReviewVendor", ["--known-bug"], root));
    rejected(status, verdict, /build: [\s\S]*forge-std\/Probe\.sol[\s\S]*project lib\/forge-std is ignored/);
  });

  // B3: string literals that look like comment markers must not hide code.
  for (const fixture of ["ReviewStrip", "ReviewStripBlock"]) {
    it(`B3 ${fixture}: comment markers inside strings do not hide .code`, { skip }, async () => {
      const { status, verdict } = await gate(fixture, ["--known-bug"]);
      rejected(status, verdict, /scan: banned .*\.code\b.*test\/Review/);
    });
  }

  // M1: the project's foundry.toml turns on ffi and file reads.
  it("M1 ReviewReadFile: project fs_permissions cannot make readFile a hash oracle", { skip }, async () => {
    const { status, verdict } = await withOverlay("config-ffi", (root) => gate("ReviewReadFile", ["--known-bug"], root));
    rejected(status, verdict, /scan: banned .*readFile/);
    assert.equal(verdict.environment.ffi, false);
    assert.deepEqual(verdict.environment.fs_permissions, []);
  });
  it("M1 ReviewReadFileRaw: readFile by raw selector is blocked by the gate config", { skip }, async () => {
    const { status, verdict } = await withOverlay("config-ffi", (root) => gate("ReviewReadFileRaw", ["--known-bug"], root));
    rejected(status, verdict, /control: healthy reference must pass/);
    assert.equal(verdict.environment.ffi, false);
    assert.deepEqual(verdict.environment.fs_permissions, []);
  });

  // M2: the project's remappings must not choose what is compiled.
  it("M2 ReviewRemap: remappings.txt cannot swap a scanned decoy for compiled code", { skip }, async () => {
    const { status, verdict } = await withOverlay("remap", (root) => gate("ReviewRemap", ["--known-bug"], root));
    rejected(status, verdict, /build: [\s\S]*helpers\/P\.sol[\s\S]*remappings\.txt/);
  });
  it("M2 ReviewDeployCode: deployCode of an unimported helper is rejected", { skip }, async () => {
    const { status, verdict } = await withOverlay("deploycode", (root) => gate("ReviewDeployCode", ["--known-bug"], root));
    rejected(status, verdict, /scan: banned .*deployCode/);
  });

  // M3: randomness must not decide the verdict.
  it("M3 ReviewRandom: vm.randomUint coin flip is rejected", { skip }, async () => {
    const { status, verdict } = await gate("ReviewRandom", ["--known-bug"]);
    rejected(status, verdict, /scan: banned .*randomUint/);
  });

  // M4: the scored target is src/FeeVault.sol with the pinned hash, never a decoy.
  // Decoy.sol is a renamed, already-repaired FeeVault, so its suite passes on its own.
  it("M4 ReviewDecoy: a decoy in src/ is never the mutation target", { skip }, async () => {
    const { status, verdict } = await withOverlay("decoy", (root) => gate("ReviewDecoy", [], root));
    rejected(status, verdict, /target: .*src\/FeeVault\.sol/);
    assert.equal(verdict.target.path, "src/FeeVault.sol");
    for (const m of verdict.mutants) assert.equal(m.killed, false);
  });
  it("M4 edited FeeVault: a target whose hash is not pinned is rejected", { skip }, async () => {
    const { status, verdict } = await withOverlay("feevault-edited", (root) => gate("ReviewProof", ["--known-bug"], root));
    rejected(status, verdict, /target: src\/FeeVault\.sol sha256 [0-9a-f]{64} is not the pinned/);
  });

  // M5: a too-strict invariant must fail the strong healthy campaign.
  it("M5 ReviewStrict: too-strict invariant fails the strong healthy campaign", { skip }, async () => {
    const { status, verdict } = await gate("ReviewStrict", ["--known-bug"]);
    rejected(status, verdict, /control: healthy reference must pass[\s\S]*strong campaign/);
  });

  // Differential: a raw cheatcode call hides from the AST scan (the name is only a string).
  // The old gate accepted it (pass, killRate 0.67). Only the behavior-equal build B exposes it.
  it("ReviewRawCheat: raw-selector getDeployedCode size oracle fails on build B", { skip }, async () => {
    const { status, verdict } = await gate("ReviewRawCheat", ["--known-bug"]);
    rejected(status, verdict, /differential: invariant_rawCheat\(\) passes on healthy build A but fails on behavior-equal build B/);
    assert.deepEqual(verdict.differential.builds.map((b) => b.name), ["A", "B"]);
    assert.notEqual(verdict.differential.builds[0].runtimeHash, verdict.differential.builds[1].runtimeHash);
  });

  // No flags: the known-bug check always runs against the repaired reference,
  // and the default kill-rate bar is "at least one kill". This pins that default.
  it("ReviewProof passes the default bar, with the known bug always checked", { skip }, async () => {
    const { status, verdict } = await gate("ReviewProof");
    assert.equal(status, 0, JSON.stringify(verdict.reasons));
    assert.equal(verdict.pass, true);
    assert.equal(verdict.minKillRate, 0);
    assert.equal(verdict.killRate, 0.3333);
    assert.equal(verdict.survivingMutants.length, 4);
    assert.ok(verdict.survivingMutants.includes("withdraw-write-after-call"));
    assert.deepEqual(verdict.unscoredMutants, []);
    assert.ok(verdict.liveness.storageChanges > 0 || verdict.liveness.balanceChanges > 0);
    assert.equal(verdict.knownBug.detected, true);
    assert.ok(verdict.mutants.some((m) => m.killed && m.failingInvariants.includes("invariant_behaviour()")));
    assert.ok(verdict.killRate > 0);
    assert.equal(verdict.differential.pass, true);
    assert.deepEqual(verdict.differential.builds.map((b) => b.name), ["A", "B"]);
    assert.notEqual(verdict.differential.builds[0].runtimeHash, verdict.differential.builds[1].runtimeHash);
    assert.equal(verdict.target.path, "src/FeeVault.sol");
    assert.equal(verdict.environment.ffi, false);
    assert.deepEqual(verdict.environment.fs_permissions, []);
    assert.equal(verdict.environment.offline, true);
    assert.equal(verdict.environment.dynamic_test_linking, false);
    assert.match(String(verdict.environment.seed), /^0x[0-9a-f]+$/);
    console.log(`ReviewProof killRate ${verdict.killRate}`);
  });

  // A higher bar refuses the narrow suite and names what survived.
  it("ReviewProof is refused at --min-kill-rate 0.5 and the survivors are named", { skip }, async () => {
    const { status, verdict } = await gate("ReviewProof", ["--min-kill-rate", "0.5"]);
    rejected(status, verdict, /mutants: kill rate 0\.3333 \(2 of 6\) is below --min-kill-rate 0\.5 \(survived: .*withdraw-write-after-call/);
    assert.equal(verdict.reasons.length, 1, JSON.stringify(verdict.reasons));
    assert.equal(verdict.knownBug.detected, true);
    assert.equal(verdict.minKillRate, 0.5);
    assert.equal(verdict.survivingMutants.length, 4);
  });

  // Known-bug guard: a live suite that kills the fee mutants but never calls
  // rescue() passes every other check; only the known-bug rule refuses it.
  it("ReviewNoRescue: kills mutants but misses the known bug, so it is refused", { skip }, async () => {
    const { status, verdict } = await gate("ReviewNoRescue");
    rejected(status, verdict, /known-bug: no new invariant Failure/);
    assert.deepEqual(verdict.reasons, ["known-bug: no new invariant Failure against the repaired reference"]);
    assert.equal(verdict.knownBug.detected, false);
    assert.ok(verdict.killRate > 0);
    assert.equal(verdict.liveness.pass, true);
    assert.equal(verdict.differential.pass, true);
  });

  it("--min-kill-rate outside 0..1 is refused before any run", async () => {
    for (const bad of ["2", "-0.1", "x", "0.5x", ""]) {
      const { status, verdict } = await gate("ReviewProof", ["--min-kill-rate", bad]);
      assert.equal(status, 1);
      assert.match(verdict.error, /--min-kill-rate must be a number from 0 to 1/);
    }
  });

  // Honest suite: ghost variables, bounded actors, and rescue() called only by
  // non-owners. On the repaired reference every rescue() reverts in the target,
  // which is an access-control probe, not a dead action. Its first invariant
  // kills no mutant, so every invariant_* must be scored.
  it("FeeVaultInvariantsFixed: access-control probe and later invariants are accepted", { skip }, async () => {
    const { status, verdict } = await gate("FeeVaultInvariantsFixed", ["--known-bug"]);
    assert.equal(status, 0, JSON.stringify(verdict.reasons));
    assert.equal(verdict.pass, true);
    assert.deepEqual(verdict.liveness.deadSelectors, ["rescue(address,uint256)"]);
    assert.deepEqual(verdict.liveness.probeSelectors, ["rescue(address,uint256)"]);
    assert.equal(verdict.campaign.invariants[0], "invariant_solvency");
    assert.ok(verdict.campaign.invariants.includes("invariant_feeAccounting"));
    assert.equal(verdict.knownBug.detected, true);
    assert.ok(verdict.mutants.some((m) => m.killed && m.failingInvariants.includes("invariant_feeAccounting()")));
    assert.equal(verdict.differential.pass, true);
    console.log(`FeeVaultInvariantsFixed killRate ${verdict.killRate}`);
  });

  // Every forge call goes through runTool: pinned digest, --pull=never,
  // --network none, forge-std read-only. A fake docker records each argv.
  // Limit: the fake `docker run` exits 1, so the gate stops after its FIRST
  // forge call and only that argv is checked. Every forge call is built by
  // the one forge() helper, so that is enough today; a fake that succeeds
  // would be needed to check every call.
  it("every forge call is an offline runTool call on the pinned image", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "vacuity-docker-"));
    const record = path.join(temp, "calls");
    try {
      fs.writeFileSync(path.join(temp, "docker"), `#!/bin/sh\nprintf "%s\\n" "$@" "--end--" >> "${record}"\n` +
        'case "$1" in image|volume) exit 0;; esac\nexit 1\n', { mode: 0o755 });
      const { status, verdict } = await new Promise((resolve) => execFile(process.execPath,
        [path.join(dir, "gate.mjs"), "--project", project, "--test", "test/ReviewProof.t.sol"],
        { encoding: "utf8", env: { ...process.env, PATH: `${temp}:${process.env.PATH}` } },
        (error, stdout) => resolve({ status: error ? error.code : 0, verdict: JSON.parse(stdout) })));
      assert.equal(status, 1);
      assert.equal(verdict.pass, false);
      assert.deepEqual(verdict.notes, []);
      const calls = fs.readFileSync(record, "utf8").split("--end--\n").filter(Boolean).map((c) => c.trim().split("\n"));
      assert.ok(!calls.some((c) => c[0] === "pull" || c.includes("--pull=always")));
      const runs = calls.filter((c) => c[0] === "run");
      assert.ok(runs.length >= 1);
      for (const c of runs) {
        assert.deepEqual(c.slice(0, 5), ["run", "--rm", "--pull=never", "--network", "none"]);
        assert.equal(c.filter((a) => a === "--network").length, 1);
        assert.ok(c.includes(image));
        assert.deepEqual(c.slice(c.indexOf("--entrypoint"), c.indexOf("--entrypoint") + 2), ["--entrypoint", "forge"]);
        assert.ok(c.some((a) => a.endsWith(":/forge-std/src:ro")));
        assert.match(c[c.indexOf("--name") + 1], /^touchstone-tool-[0-9a-f]{12}$/);
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  // forge-std comes from the lab copy. A copy of gate.mjs sits in a temp tree
  // with the same layout, next to an edited forge-std: the tree hash must refuse it.
  it("an edited forge-std source fails the pinned tree hash", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "vacuity-std-"));
    try {
      const spike = path.join(dir, "..", "..", "..");
      const std = path.join(temp, "lab/vault-reentrancy/lib/forge-std/src");
      fs.cpSync(path.join(spike, "..", "lab/vault-reentrancy/lib/forge-std/src"), std, { recursive: true });
      fs.appendFileSync(path.join(std, "Test.sol"), "\n// edited\n");
      const gateDir = path.join(temp, "spike/packs/contracts/vacuity-gate");
      fs.mkdirSync(gateDir, { recursive: true });
      fs.copyFileSync(path.join(dir, "gate.mjs"), path.join(gateDir, "gate.mjs"));
      fs.symlinkSync(path.join(spike, "lib"), path.join(temp, "spike/lib"));
      fs.writeFileSync(path.join(temp, "docker"), '#!/bin/sh\ncase "$1" in image|volume) exit 0;; esac\nexit 1\n', { mode: 0o755 });
      const { status, verdict } = await new Promise((resolve) => execFile(process.execPath,
        [path.join(gateDir, "gate.mjs"), "--project", project, "--test", "test/ReviewProof.t.sol"],
        { encoding: "utf8", env: { ...process.env, PATH: `${temp}:${process.env.PATH}` } },
        (error, stdout) => resolve({ status: error ? error.code : 0, verdict: JSON.parse(stdout) })));
      rejected(status, verdict, /environment: forge-std tree [0-9a-f]{64} .* is not the pinned/);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("external symlinked test is rejected before reading outside the project", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "vacuity-symlink-"));
    try {
      fs.mkdirSync(path.join(temp, "test"));
      fs.symlinkSync(path.join(dir, "gate.mjs"), path.join(temp, "test/External.t.sol"));
      const { status, verdict } = await gate("External", [], temp);
      assert.equal(status, 1);
      assert.match(verdict.error, /test symlink forbidden/);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
