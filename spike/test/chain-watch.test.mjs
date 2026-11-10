// Tests for the Chain watch pack. The pure parts need no Docker and no model. The
// last test runs the lab world in Docker and replays the oracle exploit. It skips
// when the image is not built.
//
//   node --experimental-test-module-mocks --test test/chain-watch.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OBSERVATION, watchLeads } from "../packs/keys/common.mjs";
import chainWatch from "../packs/chain-watch/pack.mjs";
import { PACKS, packFor } from "../packs/index.mjs";
import { cleanupWorkspace, forgeTest, makeWorkspace, readTouchstone, writePoc } from "../lib/sandbox.mjs";

const PROXY = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512";
const ATTACKER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const slot = (address) => "0x" + "0".repeat(24) + address.slice(2);
const IMPL = [slot("0x" + "11".repeat(20)), slot("0x" + "22".repeat(20)), slot("0x" + "33".repeat(20))];
const ZERO = "0x" + "0".repeat(64);
const ROLE = "0x" + "aa".repeat(32);
const snap = (block, over = {}) => ({ block, implementation: IMPL[0], admin: slot(ATTACKER), owner: "0x" + "99".repeat(20), roles: [], ...over });
const forta = (check, block, where = PROXY) => ({ engine: "Forta", check, impact: "High", where, block, description: `${check} event` });
const find = (leads, check) => leads.find((l) => l.check === check);

test("a silent upgrade is seen only by the slot diff, and the lead says no event was emitted", () => {
  const leads = watchLeads({ address: PROXY, snapshots: [snap(4), snap(5, { implementation: IMPL[1] })],
    transactions: [{ block: 5, from: ATTACKER, to: PROXY }], eventLeads: [] });
  const lead = find(leads, "implementation-changed");
  assert.equal(lead.block, 5);
  assert.equal(lead.silent, true);
  assert.equal(lead.corroborated, false);
  assert.deepEqual(lead.engines, ["Touchstone slot diff"]);
  assert.match(lead.description, /No Upgraded event was emitted/);
});

test("an upgrade with an Upgraded event in the same block is corroborated", () => {
  const leads = watchLeads({ address: PROXY, snapshots: [snap(5), snap(6, { implementation: IMPL[2] })],
    transactions: [], eventLeads: [forta("Upgraded", 6)] });
  const lead = find(leads, "implementation-changed");
  assert.equal(lead.corroborated, true);
  assert.equal(lead.silent, false);
  assert.deepEqual(lead.engines, ["Touchstone slot diff", "Forta"]);
  assert.doesNotMatch(lead.description, /No Upgraded event/);
});

test("an event in a different block does not corroborate the slot diff", () => {
  const leads = watchLeads({ address: PROXY, snapshots: [snap(7), snap(8, { admin: slot("0x" + "55".repeat(20)) })],
    transactions: [], eventLeads: [forta("AdminChanged", 6)] });
  const admin = leads.filter((l) => l.check === "admin-changed");
  assert.equal(admin.length, 2);
  assert.ok(admin.every((l) => !l.corroborated));
  assert.match(admin.find((l) => l.block === 8).description, /No AdminChanged event was emitted/);
});

test("admin, owner and role changes are read from the slots and the role list", () => {
  const before = snap(7, { roles: [{ role: ROLE, account: ATTACKER, granted: false }] });
  const granted = snap(8, { roles: [{ role: ROLE, account: ATTACKER, granted: true }] });
  const revoked = snap(9, { roles: [{ role: ROLE, account: ATTACKER, granted: false }] });
  const owner = snap(10, { owner: ATTACKER, roles: revoked.roles });
  const leads = watchLeads({ address: PROXY, snapshots: [before, granted, revoked, owner], transactions: [],
    eventLeads: [forta("RoleGranted", 8), forta("RoleRevoked", 9), forta("OwnershipTransferred", 10)] });
  assert.equal(find(leads, "role-granted").impact, "High");
  assert.equal(find(leads, "role-granted").corroborated, true);
  assert.equal(find(leads, "role-revoked").impact, "Low");
  assert.equal(find(leads, "owner-changed").corroborated, true);
});

test("the first snapshot is a baseline, not a change", () => {
  const leads = watchLeads({ address: PROXY, snapshots: [snap(1)], transactions: [], eventLeads: [] });
  assert.deepEqual(leads, []);
});

test("one address behind two kinds of change raises an actor-correlation lead", () => {
  const leads = watchLeads({ address: PROXY,
    snapshots: [snap(4), snap(5, { implementation: IMPL[1] }), snap(6, { implementation: IMPL[1], admin: slot(ATTACKER), owner: ATTACKER })],
    transactions: [{ block: 5, from: ATTACKER, to: PROXY }], eventLeads: [] });
  const lead = find(leads, "actor-correlation");
  assert.equal(lead.where, ATTACKER);
  assert.match(lead.description, /implementation-changed, owner-changed/);
});

test("a canary wallet move is a High lead", () => {
  const canary = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
  const leads = watchLeads({ address: PROXY, snapshots: [snap(1)], transactions: [], eventLeads: [],
    canary: { transactions: [{ from: canary, to: ATTACKER, value: "1", block: 11 }] } });
  const lead = find(leads, "canary-wallet-moved");
  assert.equal(lead.impact, "High");
  assert.equal(lead.where, canary);
  assert.equal(lead.block, 11);
});

test("leads rank High before Low, and agreement before no agreement", () => {
  const leads = watchLeads({ address: PROXY,
    snapshots: [snap(5), snap(6, { implementation: IMPL[1] }), snap(7, { implementation: IMPL[2], admin: ZERO })],
    transactions: [], eventLeads: [forta("Upgraded", 7)] });
  const impl = leads.filter((l) => l.check === "implementation-changed");
  assert.equal(impl[0].block, 7);
  assert.equal(impl[0].corroborated, true);
  assert.equal(impl[1].block, 6);
});

test("the chain-watch pack is registered and has a stable tool set", () => {
  assert.equal(PACKS["chain-watch"], chainWatch);
  assert.equal(chainWatch.proof, "forge");
  assert.equal(typeof chainWatch.prepass, "function");
  assert.equal(typeof chainWatch.prove, "function");
  const names = chainWatch.tools("/nonexistent", { poc: 0, passed: new Map(), found: [] }).map((t) => t.name);
  assert.deepEqual(names, ["list_sources", "read_source", "chain_state", "watch_leads", "run_poc", "submit_finding"]);
});

test("watch_leads returns the ranked leads from the observation file", async () => {
  const ws = mkdtempSync(join(tmpdir(), "watch-tools-"));
  try {
    const tools = Object.fromEntries(chainWatch.tools(ws, { poc: 0, passed: new Map(), found: [] }).map((t) => [t.name, t]));
    assert.equal((await tools.watch_leads.execute({})).isError, true);
    writeFileSync(join(ws, OBSERVATION), JSON.stringify({ address: PROXY, snapshots: [snap(4), snap(5, { implementation: IMPL[1] })], transactions: [], eventLeads: [] }));
    assert.match((await tools.watch_leads.execute({})).output[0].text, /implementation-changed .*block 5/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ---- smoke: needs Docker and the tools image. No model spend.

const hasImage = (() => {
  try { execFileSync("docker", ["image", "inspect", "touchstone-chain-tools:wave1"], { stdio: "ignore" }); return true; } catch { return false; }
})();
const LAB = new URL("../packs/chain-watch/lab", import.meta.url).pathname;

test("chain-watch smoke: Forta and the slot diff agree, and the silent upgrade is proven", { skip: !hasImage && "image not built", timeout: 600_000 }, async () => {
  const ws = makeWorkspace(LAB);
  try {
    assert.equal(packFor(readTouchstone(ws)).id, "chain-watch");
    const prep = await chainWatch.prepass(ws, { emit: () => {} });
    const obs = JSON.parse(readFileSync(join(ws, OBSERVATION), "utf8"));
    const leads = watchLeads(obs);
    for (const check of ["admin-changed", "role-granted", "owner-changed"]) {
      assert.equal(leads.find((l) => l.check === check)?.corroborated, true, `${check} should have both engines`);
    }
    const silent = leads.find((l) => l.check === "implementation-changed" && l.silent);
    assert.ok(silent && !silent.corroborated, "the silent upgrade is seen by the slot diff only");
    assert.ok(leads.some((l) => l.check === "canary-wallet-moved"));
    assert.ok(leads.some((l) => l.check === "actor-correlation"));
    assert.match(prep.env.CHAIN_BRIEF, /No Upgraded event was emitted/);
    const source = readFileSync(join(LAB, "oracle", "SilentUpgradeTest.t.sol"), "utf8");
    writePoc(ws, source);
    const run = await forgeTest(ws, { matchContract: "SilentUpgradeTest" });
    assert.ok(run.passed && !run.failed, run.output);
    const found = [{ n: 1, title: "Silent upgrade", severity: "critical", poc: "SilentUpgradeTest", explanation: "x", source }];
    const proved = await chainWatch.prove(ws, found, [{ ev: "run_poc-done", passed: true, contract: "SilentUpgradeTest" }], () => {});
    assert.equal(proved[0].proof.status, "pass");
    assert.equal(proved[0].proof.harm.ok, true);
  } finally { cleanupWorkspace(ws); }
});
