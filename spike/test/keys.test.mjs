// Tests for the Keys pack and the shared chain code (packs/keys/common.mjs).
// The pure parts need no Docker and no model. The last test runs the lab world in
// Docker and replays the oracle exploits. It skips when the image is not built.
//
//   node --experimental-test-module-mocks --test test/keys.test.mjs
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KNOWN_KEYS, OBSERVATION, harmOf, keysLeads, mergeChain, targetsOf } from "../packs/keys/common.mjs";
import keys from "../packs/keys/pack.mjs";
import { PACKS, packFor } from "../packs/index.mjs";
import { cleanupWorkspace, forgeTest, makeWorkspace, readTouchstone, writePoc } from "../lib/sandbox.mjs";

const A = "0x8a791620dd6260079bf849dc5567adc3f2fdc318";
const B = "0x1000000000000000000000000000000000000001";
const SHARED = "0x2000000000000000000000000000000000000002";
const MODULE = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512";
const PROXY_ADDR = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512";
const ZERO = "0x" + "0".repeat(64);

const safe = (over) => ({ name: "treasury", address: A, owners: [KNOWN_KEYS[0], B], threshold: 1, modules: [], guard: ZERO,
  fallbackHandler: ZERO, version: "1.4.1", sdk: null, ...over });
const sdkOf = (s) => ({ threshold: s.threshold, owners: s.owners, modules: s.modules });
const checks = (leads) => leads.map((l) => l.check);

test("Anvil account 0 is the first known key", () => {
  assert.equal(KNOWN_KEYS[0], "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
  assert.equal(KNOWN_KEYS.length, 10);
});

test("threshold 1 and a public owner key are High leads", () => {
  const leads = keysLeads({ safes: [safe()], code: {} });
  const high = leads.filter((l) => l.impact === "High");
  assert.deepEqual(checks(high).sort(), ["owner-known-key", "threshold-one"]);
  assert.match(leads.find((l) => l.check === "owner-known-key").description, /account #0/);
});

test("threshold below a majority is Medium; a majority raises no threshold lead", () => {
  const weak = keysLeads({ safes: [safe({ owners: [B, SHARED, A, MODULE], threshold: 2 })], code: {} });
  assert.ok(checks(weak).includes("threshold-below-majority"));
  const fine = keysLeads({ safes: [safe({ owners: [B, SHARED, A], threshold: 2 })], code: {} });
  assert.ok(!checks(fine).some((c) => c.startsWith("threshold")));
});

test("an EIP-7702 delegation is not reported as a plain contract owner", () => {
  const code = { [SHARED]: { size: 23, delegate: "0x" + "ab".repeat(20) }, [B]: { size: 400, delegate: null } };
  const leads = keysLeads({ safes: [safe({ owners: [SHARED, B], threshold: 2 })], code });
  assert.ok(checks(leads).includes("owner-7702-delegated"));
  assert.equal(leads.filter((l) => l.check === "owner-is-contract").length, 1);
  assert.equal(leads.find((l) => l.check === "owner-is-contract").where, B);
});

test("a module is High; modules with no guard add a Low note", () => {
  const leads = keysLeads({ safes: [safe({ owners: [B, SHARED], threshold: 2, modules: [MODULE] })], code: {} });
  assert.equal(leads.find((l) => l.check === "module-enabled").impact, "High");
  assert.equal(leads.find((l) => l.check === "no-guard").impact, "Low");
});

test("a Safe with a guard and no module has no no-guard lead", () => {
  const leads = keysLeads({ safes: [safe({ owners: [B, SHARED], threshold: 2, guard: "0x" + "0".repeat(24) + "cd".repeat(20) })], code: {} });
  assert.ok(!checks(leads).includes("no-guard"));
});

test("a fallback handler and an old Safe version are flagged", () => {
  const handler = "0x" + "0".repeat(24) + "ef".repeat(20);
  const leads = keysLeads({ safes: [safe({ owners: [B, SHARED], threshold: 2, fallbackHandler: handler, version: "1.1.1" })], code: {} });
  assert.ok(checks(leads).includes("fallback-handler-set"));
  assert.ok(checks(leads).includes("old-safe-version"));
});

test("signer reuse gives one lead per shared owner", () => {
  const one = safe({ name: "ops", address: A, owners: [SHARED, B], threshold: 2 });
  const two = safe({ name: "treasury", address: MODULE, owners: [SHARED, MODULE], threshold: 2 });
  const leads = keysLeads({ safes: [one, two], code: {} }).filter((l) => l.check === "signer-reuse");
  assert.equal(leads.length, 1);
  assert.equal(leads[0].where, SHARED);
  assert.match(leads[0].description, /2 Safes/);
});

test("a fact both readers return is corroborated and ranks first; a mismatch is not", () => {
  const agree = safe();
  const agreed = keysLeads({ safes: [{ ...agree, sdk: sdkOf(agree) }], code: {} });
  assert.equal(agreed[0].corroborated, true);
  assert.deepEqual(agreed[0].engines, ["Touchstone reader", "Safe SDK"]);
  const differ = keysLeads({ safes: [{ ...agree, sdk: { ...sdkOf(agree), threshold: 2 } }], code: {} });
  assert.equal(differ.find((l) => l.check === "threshold-one").corroborated, false);
  const failed = keysLeads({ safes: [{ ...agree, sdk: { error: "boom" } }], code: {} });
  assert.ok(failed.every((l) => !l.corroborated));
});

test("mergeChain merges on check, place and block, and sorts by impact then agreement", () => {
  const merged = mergeChain([
    { engine: "a", check: "x", impact: "Low", where: "0xAA", block: 1, description: "short" },
    { engine: "a", check: "y", impact: "High", where: "0xbb", block: 1, description: "one" },
    { engine: "a", check: "z", impact: "High", where: "0xcc", block: 2, description: "two" },
    { engine: "b", check: "z", impact: "High", where: "0xCC", block: 2, description: "two, longer text" },
    { engine: "b", check: "x", impact: "Low", where: "0xaa", block: 9, description: "other block" },
  ]);
  assert.deepEqual(merged.map((l) => `${l.check}@${l.block}`), ["z@2", "y@1", "x@1", "x@9"]);
  assert.equal(merged[0].corroborated, true);
  assert.equal(merged[0].description, "two, longer text");
  assert.equal(merged[1].corroborated, false);
});

test("harmOf needs a pass, a deployed contract that lost ETH, and another address that gained it", () => {
  const rows = [
    { address: "0xv", label: "Deployed contract", netWei: "-1000", gained: false },
    { address: "0xa", label: "EOA", netWei: "1000", gained: true },
  ];
  const ok = harmOf({ pass: true, transfers: rows });
  assert.equal(ok.ok, true);
  assert.equal(ok.victim, "0xv");
  assert.equal(ok.attacker, "0xa");
  assert.equal(harmOf({ pass: false, transfers: rows }).ok, false);
  assert.equal(harmOf({ pass: true, transfers: [rows[0]] }).ok, false);
  assert.equal(harmOf({ pass: true, transfers: [] }).ok, false);
  assert.equal(harmOf({ pass: true, transfers: [{ ...rows[1], address: "0xv" }, rows[0]] }).ok, false);
});

test("a lab target that lost ETH is a victim even when the test etched it in place", () => {
  const rows = [
    { address: A, label: "Account", netWei: "-1000", gained: false },
    { address: "0xa", label: "Account", netWei: "1000", gained: true },
  ];
  assert.equal(harmOf({ pass: true, transfers: rows }).ok, false);
  const ok = harmOf({ pass: true, transfers: rows }, targetsOf({ safes: [safe()] }));
  assert.equal(ok.ok, true);
  assert.equal(ok.victim, A);
  assert.deepEqual(targetsOf({ address: PROXY_ADDR }), [PROXY_ADDR]);
});

test("the keys pack is registered and has a stable tool set", () => {
  assert.equal(PACKS.keys, keys);
  assert.equal(keys.id, "keys");
  assert.equal(keys.proof, "forge");
  assert.equal(typeof keys.prepass, "function");
  assert.equal(typeof keys.prove, "function");
  const state = { poc: 0, passed: new Map(), found: [] };
  const names = keys.tools("/nonexistent", state).map((t) => t.name);
  assert.deepEqual(names, ["list_sources", "read_source", "safe_state", "key_leads", "run_poc", "submit_finding"]);
  assert.equal(keys.nudge({ poc: 0, passed: new Map(), found: [] }), null);
});

test("the tools read the observation file and keep read_source inside src/", async () => {
  const ws = mkdtempSync(join(tmpdir(), "keys-tools-"));
  try {
    mkdirSync(join(ws, "src"));
    writeFileSync(join(ws, "src", "A.sol"), "contract A {}");
    writeFileSync(join(ws, "secret.txt"), "no");
    const tools = Object.fromEntries(keys.tools(ws, { poc: 0, passed: new Map(), found: [] }).map((t) => [t.name, t]));
    const text = async (name, args = {}) => (await tools[name].execute(args)).output[0].text;
    assert.equal(await text("list_sources"), join("src", "A.sol"));
    assert.equal(await text("read_source", { file: "A.sol" }), "contract A {}");
    const escape = await tools.read_source.execute({ file: "../secret.txt" });
    assert.equal(escape.isError, true);
    assert.equal((await tools.safe_state.execute({})).isError, true);
    writeFileSync(join(ws, OBSERVATION), JSON.stringify({ safes: [safe()], code: {} }));
    assert.match(await text("key_leads"), /threshold-one/);
    assert.match(await text("safe_state"), /treasury/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("submit_finding refuses a test that has not passed", async () => {
  const ws = mkdtempSync(join(tmpdir(), "keys-submit-"));
  try {
    const state = { poc: 0, passed: new Map(), found: [] };
    const tools = Object.fromEntries(keys.tools(ws, state).map((t) => [t.name, t]));
    const refused = await tools.submit_finding.execute({ title: "t", severity: "high", poc_contract: "Nope", explanation: "x" });
    assert.equal(refused.isError, true);
    state.passed.set("Yes", "contract Yes {}");
    const ok = await tools.submit_finding.execute({ title: "t", severity: "high", poc_contract: "Yes", explanation: "x" });
    assert.ok(!ok.isError);
    const dup = await tools.submit_finding.execute({ title: "t", severity: "high", poc_contract: "Yes", explanation: "x" });
    assert.equal(dup.isError, true);
    assert.equal(state.found.length, 1);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ---- smoke: needs Docker and the tools image. No model spend.

const hasImage = (() => {
  try { execFileSync("docker", ["image", "inspect", "touchstone-chain-tools:wave1"], { stdio: "ignore" }); return true; } catch { return false; }
})();
const LAB = new URL("../packs/keys/lab", import.meta.url).pathname;

test("keys smoke: the lab world is observed, funds and control harm prove, a probe fails", { skip: !hasImage && "image not built", timeout: 900_000 }, async () => {
  const ws = makeWorkspace(LAB);
  try {
    assert.equal(packFor(readTouchstone(ws)).id, "keys");
    const events = [];
    const prep = await keys.prepass(ws, { emit: (e) => events.push(e) });
    assert.ok(prep.record.corroborated >= 3, "the Safe SDK should agree on threshold, owners and modules");
    assert.match(prep.env.CHAIN_BRIEF, /threshold-one/);
    assert.match(prep.env.CHAIN_BRIEF, /owner-known-key/);
    assert.match(prep.env.CHAIN_BRIEF, /owner-7702-delegated/);
    assert.match(prep.env.CHAIN_BRIEF, /module-enabled/);
    assert.match(prep.env.CHAIN_BRIEF, /signer-reuse/);
    assert.equal(events[0].ev, "chain-scan");
    const sourceOf = readFileSync(join(LAB, "oracle", "KeysOracle.t.sol"), "utf8");
    const setupSource = readFileSync(join(LAB, "oracle", "DelegatedSetupTest.t.sol"), "utf8");
    const found = [];
    const runs = [];
    const pocs = ["KnownKeyTest", "ModuleBypassTest", "OwnerTakeoverTest", "ReDelegationTest", "ProbeOnlyTest", "DelegatedSetupTest"];
    for (const poc of pocs) {
      const source = poc === "DelegatedSetupTest" ? setupSource : sourceOf;
      writePoc(ws, source);
      const run = await forgeTest(ws, { matchContract: poc });
      assert.ok(run.passed && !run.failed, `${poc} should pass: ${run.output}`);
      found.push({ n: found.length + 1, title: poc, severity: "high", poc, explanation: "x", source });
      runs.push({ ev: "run_poc-done", passed: run.passed, contract: poc });
    }
    const proved = await keys.prove(ws, found, runs, () => {});
    assert.equal(proved.length, pocs.length);
    const by = Object.fromEntries(proved.map((f) => [f.poc, f.proof]));
    for (const poc of ["KnownKeyTest", "ModuleBypassTest"]) {
      assert.equal(by[poc].status, "pass", poc);
      assert.equal(by[poc].kind, "forge");
      assert.equal(by[poc].harm.kind, "funds", poc);
    }
    assert.equal(by.OwnerTakeoverTest.status, "pass");
    assert.equal(by.OwnerTakeoverTest.harm.kind, "control");
    assert.ok(by.OwnerTakeoverTest.harm.changes.some((c) => /^Safe owner list/.test(c.field)));
    assert.ok(by.OwnerTakeoverTest.harm.changes.some((c) => c.field === "Safe owner count"));
    assert.equal(by.ReDelegationTest.status, "pass");
    assert.equal(by.ReDelegationTest.harm.kind, "control");
    assert.equal(by.ReDelegationTest.harm.changes[0].field, "EIP-7702 delegation");
    // Found by the live agent: setup() on a lab 7702 account that has no Safe state yet.
    assert.equal(by.DelegatedSetupTest.status, "pass");
    assert.equal(by.DelegatedSetupTest.harm.kind, "control");
    assert.ok(by.DelegatedSetupTest.harm.changes.some((c) => c.field === "Safe owner count"));
    assert.equal(by.ProbeOnlyTest.status, "fail");
    assert.equal(by.ProbeOnlyTest.harm.ok, false);
    for (const proof of Object.values(by)) assert.equal(proof.controlTrace, undefined, "the large state trace is not stored");
  } finally { cleanupWorkspace(ws); }
});
