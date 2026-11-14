// proveFindings keeps the replay files out of the run record. The forge replay
// itself is mocked (it needs Docker); the snapshot and the store are real.
import "./helpers/isolated-env.mjs";
import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const results = mkdtempSync(path.join(tmpdir(), "replay-store-results-"));
const ws = mkdtempSync(path.join(tmpdir(), "replay-store-ws-"));
process.env.TOUCHSTONE_RESULTS_DIR = results;
after(() => {
  rmSync(results, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

const VICTIM = "0x" + "11".repeat(20);
mock.module("../lib/proof.mjs", {
  exports: {
    proofDelta: async () => ({ test: "testDrain()", pass: true, harm: { ok: true, kind: "funds", victim: VICTIM, lostWei: "1" } }),
  },
});
const { proveFindings } = await import("../lib/record.mjs");

test("proveFindings stores the replay files under replay/ and the proof keeps the hash and paths only", async () => {
  mkdirSync(path.join(ws, "src"));
  mkdirSync(path.join(ws, "test"));
  writeFileSync(path.join(ws, "foundry.toml"), `[profile.default]\nsrc = "src"\n`);
  writeFileSync(path.join(ws, "src", "Vault.sol"), "contract Vault { function withdraw() external {} }\n");
  writeFileSync(path.join(ws, "test", "AgentPoc.t.sol"), "contract PocTest { function testDrain() public {} }\n");
  const events = [{ ev: "run_poc-done", passed: true, contract: "PocTest" }];
  // proveFindings stores the files and the pointer only; no re-run verdict is
  // written on a record (the automatic re-run check does not ship yet).
  const [f] = await proveFindings(ws, [{ n: 1, title: "drain", severity: "high", poc: "PocTest", source: "contract PocTest {}" }], events);
  assert.equal(f.pocProved, true);
  const replay = f.proof.replay;
  assert.equal(replay.rerun, undefined);
  assert.equal(replay.files, undefined);
  assert.equal(replay.version, 3);
  assert.deepEqual([...replay.paths].sort(), ["foundry.toml", "src/Vault.sol", "test/AgentPoc.t.sol"]);
  assert.match(replay.store.sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(f).includes("function withdraw"), false);
  assert.deepEqual(readdirSync(path.join(results, "replay")), [`${replay.store.sha256}.json`]);
  const stored = JSON.parse(readFileSync(path.join(results, "replay", `${replay.store.sha256}.json`), "utf8"));
  assert.equal(stored.files.find((x) => x.path === "src/Vault.sol").text, "contract Vault { function withdraw() external {} }\n");
});

test("under node --test with no results folder set, the store goes to a temp folder, not the checkout", async () => {
  const { replayStoreDir } = await import("../lib/replay-bundle.mjs");
  const keep = { t: process.env.TOUCHSTONE_RESULTS_DIR, a: process.env.AGENT_RESULTS_DIR };
  delete process.env.TOUCHSTONE_RESULTS_DIR;
  delete process.env.AGENT_RESULTS_DIR;
  try {
    assert.ok(process.env.NODE_TEST_CONTEXT, "node --test sets NODE_TEST_CONTEXT");
    const dir = replayStoreDir();
    assert.equal(dir, path.join(tmpdir(), `touchstone-replay-test-${process.pid}`));
    assert.equal(dir.includes(path.join("spike", "results")), false);
  } finally {
    process.env.TOUCHSTONE_RESULTS_DIR = keep.t;
    if (keep.a !== undefined) process.env.AGENT_RESULTS_DIR = keep.a;
  }
});

test("pruneReplayStore removes the replay files and blobs no record names, and nothing when a record cannot be read", async () => {
  const { pruneReplayStore, storeReplayFiles } = await import("../lib/replay-bundle.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "replay-prune-"));
  try {
    const store = path.join(dir, "replay");
    const lib = path.join(process.cwd(), "..", "lab", "vault-reentrancy", "lib", "forge-std", "src", "Vm.sol");
    const { vendoredFile } = await import("../lib/replay-bundle.mjs");
    const vm = vendoredFile("lib/forge-std/src/Vm.sol", readFileSync(lib));
    assert.ok(vm, "Vm.sol is a vendored file");
    const keep = storeReplayFiles({ kind: "forge", files: [{ path: "src/A.sol", text: "contract A {}\n" }] }, store);
    const gone = storeReplayFiles({ kind: "forge", files: [{ path: "src/B.sol", text: "contract B {}\n" }, { path: "lib/forge-std/src/Vm.sol", vendored: vm }] }, store);
    assert.deepEqual(readdirSync(path.join(store, "lib")), [vm.sha256]);
    writeFileSync(path.join(dir, "run-keep.json"), JSON.stringify({ result: { findings: [{ proof: { replay: keep } }] } }, null, 2));
    // A torn record stops the prune: nothing is removed.
    writeFileSync(path.join(dir, "run-torn.json"), '{"result": ');
    assert.equal(pruneReplayStore(dir).stopped, "a run record could not be read");
    assert.equal(readdirSync(store).length, 3);
    rmSync(path.join(dir, "run-torn.json"));
    // Re-run verdict side files: one for each store file, a damaged one and a
    // temp file left by a stopped write.
    const { writeRerunVerdict } = await import("../lib/replay-bundle.mjs");
    const { FOUNDRY_IMAGE } = await import("../lib/sandbox.mjs");
    const verdict = (store_, key) => ({ version: 2, key, tree: key, store: store_, pass: true, image: FOUNDRY_IMAGE, command: "x", at: Date.now() });
    writeRerunVerdict(store, verdict(keep.store.sha256, "a".repeat(64)));
    writeRerunVerdict(store, verdict(gone.store.sha256, "b".repeat(64)));
    writeFileSync(path.join(store, "rerun", "c".repeat(64) + ".json"), "{ not json");
    writeFileSync(path.join(store, "rerun", "d".repeat(64) + ".json.1.ab.tmp"), "{}");
    // The record that named `gone` was deleted: its file, its blob and its
    // verdict go; so do the damaged verdict and the stray temp file.
    assert.deepEqual(pruneReplayStore(dir), { removed: 1, blobs: 1, verdicts: 3 });
    assert.deepEqual(readdirSync(store).sort(), [`${keep.store.sha256}.json`, "lib", "rerun"]);
    assert.deepEqual(readdirSync(path.join(store, "rerun")), ["a".repeat(64) + ".json"]);
    assert.deepEqual(readdirSync(path.join(store, "lib")), []);
    assert.ok(gone.store.sha256 !== keep.store.sha256);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

