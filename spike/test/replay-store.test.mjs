// proveFindings keeps the replay files out of the run record. The forge replay
// itself is mocked (it needs Docker); the snapshot and the store are real.
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
  const [f] = await proveFindings(ws, [{ n: 1, title: "drain", severity: "high", poc: "PocTest", source: "contract PocTest {}" }], events);
  assert.equal(f.pocProved, true);
  const replay = f.proof.replay;
  assert.equal(replay.files, undefined);
  assert.equal(replay.version, 3);
  assert.deepEqual([...replay.paths].sort(), ["foundry.toml", "src/Vault.sol", "test/AgentPoc.t.sol"]);
  assert.match(replay.store.sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(f).includes("function withdraw"), false);
  assert.deepEqual(readdirSync(path.join(results, "replay")), [`${replay.store.sha256}.json`]);
  const stored = JSON.parse(readFileSync(path.join(results, "replay", `${replay.store.sha256}.json`), "utf8"));
  assert.equal(stored.files.find((x) => x.path === "src/Vault.sol").text, "contract Vault { function withdraw() external {} }\n");
});
