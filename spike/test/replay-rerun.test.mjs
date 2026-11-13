// H3c part 2: the "re-run checked" claim. The verdict lives in a side file
// keyed by the hash of the checked files (replay/rerun/<hash>.json), never in
// a run record. A stub runner stands in for forge, so no Docker is needed;
// the real offline re-run is the opt-in Docker test in app/tests/report.test.ts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildReplayBundle, checkRecordedReplays, checkReplayRerun, loadReplayFiles, readRerunVerdict,
  snapshotForgeReplay, storeReplayFiles,
} from "../lib/replay-bundle.mjs";
import { FOUNDRY_IMAGE } from "../lib/sandbox.mjs";

const root = mkdtempSync(path.join(tmpdir(), "replay-rerun-"));
after(() => rmSync(root, { recursive: true, force: true }));

const PASS = async () => ({ passed: true, failed: false });
const FAIL = async () => ({ passed: false, failed: true });
const PROOF = { kind: "forge", pass: true, test: "t()" };

let n = 0;
// A recorded proof as the engine stores it: the files in the store, the pointer
// on the proof. Returns the pointer, the store folder and the loaded replay.
function recorded({ poc = "contract PocTest { function t() public {} }\n", toml = `[profile.default]\nsrc = "src"\n` } = {}) {
  const ws = path.join(root, `ws-${++n}`);
  mkdirSync(path.join(ws, "src"), { recursive: true });
  mkdirSync(path.join(ws, "test"), { recursive: true });
  writeFileSync(path.join(ws, "foundry.toml"), toml);
  writeFileSync(path.join(ws, "src", "Vault.sol"), "contract Vault {}\n");
  writeFileSync(path.join(ws, "test", "AgentPoc.t.sol"), poc);
  const store = path.join(root, `store-${n}`);
  const pointer = storeReplayFiles(snapshotForgeReplay(ws, { contract: "PocTest", test: "t()" }), store);
  return { pointer, store, loaded: loadReplayFiles(pointer, store) };
}
// Build the bundle and read its README.
function readme(replay, rerunDir) {
  const zip = bundleZip(replay, rerunDir);
  const dir = mkdtempSync(path.join(root, "zip-"));
  try {
    writeFileSync(path.join(dir, "b.zip"), zip);
    execFileSync("unzip", ["-qo", path.join(dir, "b.zip"), "-d", dir]);
    return readFileSync(path.join(dir, "README.md"), "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function bundleZip(replay, rerunDir) {
  return buildReplayBundle({ finding: { stages: { proven: true }, title: "t", proofKind: "forge", proof: PROOF }, recorded: { replay, proof: PROOF, ...(rerunDir ? { rerunDir } : {}) } });
}
const claims = (r) => r.includes("These files were re-run-checked");
const verdictFiles = (store) => (existsSync(path.join(store, "rerun")) ? readdirSync(path.join(store, "rerun")) : []);

test("hit: a passing check of the files shipped now makes the claim", async () => {
  const { pointer, store, loaded } = recorded();
  const v = await checkReplayRerun({ replay: pointer, proof: PROOF }, { storeDir: store, run: PASS });
  assert.equal(v.pass, true);
  const r = readme(loaded, store);
  assert.ok(claims(r), r.split("\n")[0]);
  assert.match(r.split("\n")[0], /^PROVEN: .*These files were re-run-checked: Touchstone re-ran them offline on \d{4}-\d{2}-\d{2} and the proof test passed; the re-run command is in this README\.$/);
  assert.ok(r.includes("Touchstone re-ran these exact files offline on "));
  assert.ok(r.includes(v.command));
});

test("miss: no verdict keeps today's wording byte for byte", async () => {
  const { store, loaded } = recorded();
  const withStore = bundleZip(loaded, store);
  const without = bundleZip(loaded, null);
  assert.ok(withStore.equals(without), "a bundle with an empty side store equals one with no store");
  const r = readme(loaded, store);
  assert.equal(claims(r), false);
  assert.ok(r.includes("These files were not re-run-checked (an automatic re-run check does not ship yet)"));
});

test("fail: a failing check makes no claim", async () => {
  const { pointer, store, loaded } = recorded();
  const v = await checkReplayRerun({ replay: pointer, proof: PROOF }, { storeDir: store, run: FAIL });
  assert.equal(v.pass, false);
  assert.equal(v.reason, "the proof test did not pass from the bundle folder");
  assert.equal(claims(readme(loaded, store)), false);
});

test("other hash: a pass for another set of files makes no claim", async () => {
  const a = recorded();
  const b = recorded({ poc: "contract PocTest { function t() public { uint x = 1; x; } }\n" });
  const v = await checkReplayRerun({ replay: a.pointer, proof: PROOF }, { storeDir: a.store, run: PASS });
  // Put a's verdict where b's bundle looks: b hashes to another key.
  mkdirSync(path.join(b.store, "rerun"), { recursive: true });
  writeFileSync(path.join(b.store, "rerun", `${v.tree}.json`), JSON.stringify(v));
  assert.equal(claims(readme(b.loaded, b.store)), false);
});

test("a file changed after the check gives no claim", async () => {
  const { pointer, store, loaded } = recorded();
  await checkReplayRerun({ replay: pointer, proof: PROOF }, { storeDir: store, run: PASS });
  assert.ok(claims(readme(loaded, store)));
  const changed = { ...loaded, files: loaded.files.map((f) => (f.path === "src/Vault.sol" ? { ...f, text: "contract Vault { uint256 public x; }\n" } : f)) };
  assert.equal(claims(readme(changed, store)), false);
});

test("a damaged or foreign side file reads as no verdict", async () => {
  const { pointer, store, loaded } = recorded();
  const v = await checkReplayRerun({ replay: pointer, proof: PROOF }, { storeDir: store, run: PASS });
  const file = path.join(store, "rerun", `${v.tree}.json`);
  for (const [what, body] of [
    ["not JSON", "{ damaged"],
    ["another version", JSON.stringify({ ...v, version: 2 })],
    ["another key", JSON.stringify({ ...v, tree: "e".repeat(64) })],
    ["another image", JSON.stringify({ ...v, image: "ghcr.io/foundry-rs/foundry:latest@sha256:" + "0".repeat(64) })],
    ["pass as a string", JSON.stringify({ ...v, pass: "true" })],
    ["no time", JSON.stringify({ ...v, at: undefined })],
    ["too large", JSON.stringify({ ...v, pad: "x".repeat(5000) })],
  ]) {
    writeFileSync(file, body);
    assert.equal(readRerunVerdict(store, v.tree), null, what);
    assert.equal(claims(readme(loaded, store)), false, what);
  }
});

test("the side file holds the hash, pass/fail, the image, the command and the time, and no source text", async () => {
  const { pointer, store } = recorded({ poc: "contract PocTest { function t() public { /* SECRET-MARKER */ } }\n" });
  const v = await checkReplayRerun({ replay: pointer, proof: PROOF }, { storeDir: store, run: PASS });
  const raw = readFileSync(path.join(store, "rerun", `${v.tree}.json`), "utf8");
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ["at", "command", "image", "pass", "store", "tree", "version"]);
  assert.equal(JSON.parse(raw).image, FOUNDRY_IMAGE);
  assert.equal(JSON.parse(raw).store, pointer.store.sha256);
  for (const text of ["SECRET-MARKER", "contract Vault {", "contract PocTest {", "function t()"]) assert.equal(raw.includes(text), false, text);
});

test("two checks at once leave one whole file and no temp file", async () => {
  const { pointer, store } = recorded();
  const slow = (pass) => async () => { await new Promise((r) => setTimeout(r, 30)); return { passed: pass, failed: !pass }; };
  const [a, b] = await Promise.all([
    checkReplayRerun({ replay: pointer, proof: PROOF }, { storeDir: store, run: slow(true) }),
    checkReplayRerun({ replay: pointer, proof: PROOF }, { storeDir: store, run: slow(false) }),
  ]);
  assert.equal(a.tree, b.tree);
  assert.deepEqual(verdictFiles(store), [`${a.tree}.json`]);
  const v = readRerunVerdict(store, a.tree);
  assert.ok(v && typeof v.pass === "boolean", "the file parses whole");
});

test("a forked proof and a proof that reads a file are not run and get no verdict", async () => {
  let ran = 0;
  const count = async () => { ran++; return { passed: true, failed: false }; };
  const forked = recorded({ toml: `[profile.default]\nsrc = "src"\neth_rpc_url = "https://rpc.example/x"\n` });
  assert.equal(await checkReplayRerun({ replay: forked.pointer, proof: PROOF }, { storeDir: forked.store, run: count }), null);
  const reads = recorded({ poc: 'interface Vm { function readFile(string calldata) external view returns (string memory); }\ncontract PocTest { Vm vm; function t() public view { vm.readFile("data/x"); } }\n' });
  assert.equal(await checkReplayRerun({ replay: reads.pointer, proof: PROOF }, { storeDir: reads.store, run: count }), null);
  assert.equal(ran, 0);
  assert.deepEqual(verdictFiles(forked.store), []);
  assert.deepEqual(verdictFiles(reads.store), []);
});

test("checkRecordedReplays reads the findings, writes side files only, and changes no finding", async () => {
  const { pointer, store, loaded } = recorded();
  const findings = [
    { title: "proven", pocProved: true, proof: { ...PROOF, replay: pointer } },
    { title: "a lead", pocProved: false, proof: { ...PROOF, replay: pointer } },
    { title: "http", pocProved: true, proof: { kind: "http" } },
  ];
  const before = JSON.stringify(findings);
  const { checked } = await checkRecordedReplays(findings, { storeDir: store, run: PASS });
  assert.equal(checked, 1);
  assert.equal(JSON.stringify(findings), before);
  assert.deepEqual(readdirSync(store).filter((f) => f.startsWith("run-")), []);
  assert.ok(claims(readme(loaded, store)));
});
