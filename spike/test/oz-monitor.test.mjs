// OpenZeppelin Monitor through runTool() for the chain-watch pack (lib/oz-monitor.mjs).
// The real-run tests need the monitor image (tools/build-oz-monitor-image.sh) and the
// chain-tools image, and skip when one is missing. The parse tests need no Docker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MONITORS, OZ_MONITOR_DEFAULT_IMAGE, blockRange, monitorConfig, ozMonitorLeads, parseOzMonitor,
  runMonitors, startWatchLab, stopWatchLab,
} from "../lib/oz-monitor.mjs";
import { chainPrepass, readObservation, sourceLeads, watchLeads } from "../packs/keys/common.mjs";
import chainWatch from "../packs/chain-watch/pack.mjs";
import { runTool } from "../lib/wrap.mjs";
import { cleanupWorkspace, makeWorkspace } from "../lib/sandbox.mjs";

const imageExists = (image) => {
  try { execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" }); return true; } catch { return false; }
};
const hasMonitor = imageExists(OZ_MONITOR_DEFAULT_IMAGE);
const hasTools = imageExists("touchstone-chain-tools:wave1");
const needs = (!hasMonitor || !hasTools) && "monitor or chain-tools image not built";
const CHAIN_LAB = new URL("../packs/chain-watch/lab", import.meta.url).pathname;

const PROXY = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512";
const OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const ATTACKER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const CANARY = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";

const withImage = async (image, fn) => {
  const prev = process.env.OZ_MONITOR_IMAGE;
  process.env.OZ_MONITOR_IMAGE = image;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.OZ_MONITOR_IMAGE; else process.env.OZ_MONITOR_IMAGE = prev; }
};

// Our containers and networks, so a test can show it left nothing behind.
const ours = () => {
  const list = (args) => execFileSync("docker", args, { encoding: "utf8" }).split("\n").filter((n) => n.startsWith("touchstone-ozmon-"));
  return [...list(["ps", "-a", "--format", "{{.Names}}"]), ...list(["network", "ls", "--format", "{{.Name}}"])].sort();
};
const leftNothing = (before) => assert.deepEqual(ours().filter((n) => !before.includes(n)), [], "no lab container or network is left");

// ---- parse: pure, no Docker

// One match in the shape the script trigger receives on stdin.
const match = (monitor, block, { from = ATTACKER, functions = [], events = [], hash = "0xabc0000000000000" } = {}) => ({
  args: [],
  monitor_match: { EVM: {
    monitor: { name: monitor },
    transaction: { blockNumber: `0x${block.toString(16)}`, from, hash, to: PROXY },
    matched_on: { functions: functions.map((s) => ({ signature: s, expression: null })), events: events.map((s) => ({ signature: s, expression: null })), transactions: [] },
    matched_on_args: { functions: functions.map((s) => ({ signature: s, args: [{ name: "implementation", value: "0xdead" }] })), events: null },
  } },
});
const CTX = { address: PROXY, owner: OWNER, baseline: 4 };
const EXPECT = { monitors: ["admin", "non_owner"], from: 5, to: 6 };
const run = (m, b, code, total) => `RUN ${m} ${b} ${code} ${total}`;
const line = (m, b, json) => `MATCH ${m} ${b} ${JSON.stringify(json)}`;
const UPGRADE = "upgradeTo(address,bool)";

const goodOutput = () => [
  run("admin", 5, 0, 1), line("admin", 5, match("admin", 5, { functions: [UPGRADE] })),
  run("admin", 6, 0, 1), line("admin", 6, match("admin", 6, { functions: [UPGRADE], events: ["Upgraded(address)"] })),
  run("non_owner", 5, 0, 1), line("non_owner", 5, match("non_owner", 5, { functions: [UPGRADE] })),
  run("non_owner", 6, 0, 1), line("non_owner", 6, match("non_owner", 6, { functions: [UPGRADE] })),
].join("\n");

test("parseOzMonitor turns matches into leads and groups the non-owner calls into one lead per sender", () => {
  const r = parseOzMonitor(goodOutput(), EXPECT, CTX);
  assert.equal(r.available, true);
  const upgrades = r.leads.filter((l) => l.check === "implementation-changed");
  assert.deepEqual(upgrades.map((l) => l.block), [5, 6, 6], "the call at 5, the call and the event at 6");
  assert.ok(upgrades.every((l) => l.where === PROXY && l.engine === "OpenZeppelin Monitor"));
  const nonOwner = r.leads.filter((l) => l.check === "admin-call-by-non-owner");
  assert.equal(nonOwner.length, 1);
  assert.equal(nonOwner[0].where, ATTACKER);
  assert.deepEqual(nonOwner[0].blocks, [5, 6]);
  assert.equal(nonOwner[0].impact, "High");
  assert.equal(nonOwner[0].block, undefined, "no block: it groups calls from several blocks");
  assert.match(nonOwner[0].description, /is not the owner \(0xf39f.*\) the lab read at block 4/);
  assert.ok(!r.leads.some((l) => "proven" in l || "status" in l), "a tool never marks anything proven");
});

test("parseOzMonitor fails closed when a run is missing", () => {
  const out = goodOutput().split("\n").filter((l) => !l.startsWith("RUN non_owner 6") && !l.startsWith("MATCH non_owner 6")).join("\n");
  const r = parseOzMonitor(out, EXPECT, CTX);
  assert.equal(r.available, false);
  assert.match(r.reason, /no run for monitor non_owner at block 6/);
  assert.deepEqual(r.leads, []);
});

test("parseOzMonitor fails closed on a non-zero exit and names the error", () => {
  const out = goodOutput().replace("RUN admin 6 0 1", "RUN admin 6 1 -\nERR Failed to get EVM client");
  const r = parseOzMonitor(out, EXPECT, CTX);
  assert.equal(r.available, false);
  assert.match(r.reason, /monitor admin failed at block 6: Failed to get EVM client/);
});

test("parseOzMonitor fails closed when the trigger kept fewer matches than the monitor found", () => {
  // Seen for real: the monitor exits 0 even when its script trigger fails.
  const out = goodOutput().split("\n").filter((l) => !l.startsWith("MATCH admin 5")).join("\n");
  const r = parseOzMonitor(out, EXPECT, CTX);
  assert.equal(r.available, false);
  assert.match(r.reason, /found 1 matches but the trigger kept 0/);
});

test("parseOzMonitor fails closed on unreadable match JSON, a missing count, or a match from another block", () => {
  const unreadable = parseOzMonitor(goodOutput().replace(/^MATCH admin 5 .*$/m, "MATCH admin 5 {unreadable"), EXPECT, CTX);
  assert.equal(unreadable.available, false);
  assert.match(unreadable.reason, /unreadable match for admin at block 5/);
  const noCount = parseOzMonitor(goodOutput().replace("RUN admin 5 0 1", "RUN admin 5 0 -"), EXPECT, CTX);
  assert.equal(noCount.available, false);
  assert.match(noCount.reason, /printed no match count/);
  const wrongBlock = parseOzMonitor(goodOutput().replace(/^MATCH admin 5 .*$/m, line("admin", 5, match("admin", 9, { functions: [UPGRADE] }))), EXPECT, CTX);
  assert.equal(wrongBlock.available, false);
  assert.match(wrongBlock.reason, /match is in block 0x9, expected 5/);
  assert.equal(parseOzMonitor("", EXPECT, CTX).available, false, "no output is never a clean result");
});

test("monitorConfig points only at the lab alias and keys the non-owner check to the baseline owner", () => {
  const obs = { address: PROXY, chainId: 31337, fromBlock: 5, toBlock: 10, snapshots: [{ block: 4, owner: OWNER }],
    canary: { address: CANARY, transactions: [{ block: 11 }] } };
  const c = monitorConfig(obs);
  assert.deepEqual(c.network.rpc_urls.map((u) => u.url.value), ["http://labchain:8545"]);
  assert.deepEqual(c.monitors.non_owner.match_conditions.transactions, [{ status: "Success", expression: `from != ${OWNER}` }]);
  assert.equal(c.monitors.canary.addresses[0].address, CANARY);
  assert.equal(c.trigger.record_match.config.script_path, "/opt/touchstone/record.sh");
  assert.deepEqual(Object.keys(c.monitors), MONITORS);
  assert.deepEqual(blockRange(obs), { from: 5, to: 11 });
});

// ---- failure cases through the real Docker path

test("a missing monitor image gives unavailable and starts no lab", async () => {
  const before = ours();
  const r = await withImage("touchstone/oz-monitor:does-not-exist", () => ozMonitorLeads(CHAIN_LAB));
  assert.equal(r.available, false);
  assert.match(r.reason, /image not built \(spike\/tools\/build-oz-monitor-image\.sh\)/);
  assert.deepEqual(r.leads, []);
  leftNothing(before);
});

test("a lab image that is missing gives unavailable and removes the network", { skip: !hasMonitor && "monitor image not built", timeout: 120_000 }, async () => {
  const before = ours();
  const r = await ozMonitorLeads(CHAIN_LAB, { labImage: "touchstone-chain-tools:does-not-exist" });
  assert.equal(r.available, false);
  assert.match(r.reason, /lab did not start/);
  leftNothing(before);
});

test("a lab that stops before it is ready gives unavailable", { skip: needs, timeout: 300_000 }, async () => {
  const before = ours();
  const empty = mkdtempSync(join(tmpdir(), "ozmon-empty-"));
  try {
    const r = await ozMonitorLeads(empty); // no lab source: observe.mjs fails and the container exits
    assert.equal(r.available, false);
    assert.match(r.reason, /lab stopped before it was ready|lab not ready/);
  } finally { rmSync(empty, { recursive: true, force: true }); }
  leftNothing(before);
});

test("the lab network is --internal: a container on it cannot reach the outside", { skip: needs, timeout: 300_000 }, async () => {
  const before = ours();
  const handle = await startWatchLab(CHAIN_LAB);
  try {
    const inspect = execFileSync("docker", ["network", "inspect", "-f", "{{.Internal}}", handle.net], { encoding: "utf8" }).trim();
    assert.equal(inspect, "true");
    // The same flags as the monitor run. The lab answers; a public address does not.
    const probe = await runTool({ image: OZ_MONITOR_DEFAULT_IMAGE, network: handle.net, timeoutMs: 60_000,
      cmd: ["bash", "-c", "(exec 3<>/dev/tcp/labchain/8545) && echo LAB-OK; (exec 3<>/dev/tcp/1.1.1.1/443) 2>/dev/null && echo OUT-OK || echo OUT-BLOCKED"] });
    assert.match(probe.stdout, /LAB-OK/);
    assert.match(probe.stdout, /OUT-BLOCKED/);
    assert.doesNotMatch(probe.stdout, /OUT-OK/);
  } finally { await stopWatchLab(handle); }
  leftNothing(before);
});

test("an unreachable lab RPC gives unavailable, not a clean result", { skip: needs, timeout: 300_000 }, async () => {
  const before = ours();
  const handle = await startWatchLab(CHAIN_LAB);
  try {
    execFileSync("docker", ["rm", "-f", handle.name], { stdio: "ignore" }); // the chain goes away, the network stays
    const r = await runMonitors(handle);
    assert.equal(r.available, false);
    assert.match(r.reason, /monitor admin failed at block 5/);
    assert.deepEqual(r.leads, []);
  } finally { await stopWatchLab(handle); }
  leftNothing(before);
});

test("a monitor run that times out gives unavailable and its container is removed", { skip: needs, timeout: 300_000 }, async () => {
  const before = ours();
  const handle = await startWatchLab(CHAIN_LAB);
  try {
    const r = await runMonitors(handle, { timeoutMs: 1500 });
    assert.equal(r.available, false);
    assert.equal(r.reason, "timed out");
  } finally { await stopWatchLab(handle); }
  leftNothing(before);
});

// ---- the real run on the chain-watch lab

test("chain-watch lab: OpenZeppelin Monitor sees the non-owner upgrades, the silent upgrade and the canary", { skip: needs, timeout: 300_000 }, async () => {
  const before = ours();
  const r = await ozMonitorLeads(CHAIN_LAB);
  assert.equal(r.available, true, r.reason);
  const nonOwner = r.leads.filter((l) => l.check === "admin-call-by-non-owner");
  assert.equal(nonOwner.length, 1, "only the attacker called an admin function and was not the owner");
  assert.equal(nonOwner[0].where, ATTACKER);
  assert.deepEqual(nonOwner[0].blocks, [5, 6]);
  assert.match(nonOwner[0].description, /announce=false at block 5/);
  const at = (check, block) => r.leads.some((l) => l.check === check && l.block === block && l.where === PROXY);
  assert.ok(at("implementation-changed", 5), "the silent upgrade: a call with no Upgraded event");
  assert.ok(at("implementation-changed", 6) && at("admin-changed", 7) && at("role-granted", 8) && at("role-revoked", 9) && at("owner-changed", 10));
  assert.equal(r.leads.find((l) => l.check === "role-revoked").impact, "Low");
  assert.ok(r.leads.some((l) => l.check === "canary-wallet-moved" && l.where === CANARY && l.block === 11));
  leftNothing(before);
});

test("chain-watch prepass (lab mode) adds a lead the pack did not have, and a second engine on the silent upgrade", { skip: needs, timeout: 600_000 }, async () => {
  const before = ours();
  const ws = makeWorkspace(CHAIN_LAB);
  try {
    const events = [];
    const prep = await chainWatch.prepass(ws, { emit: (e) => events.push(e) });
    assert.equal(prep.record.source, false, "the lab world ran");
    assert.equal(prep.record.ozMonitor, true);
    assert.equal(events.find((e) => e.ev === "chain-scan")?.ozMonitor, true);
    assert.ok(events.find((e) => e.ev === "chain-scan").engines.includes("OpenZeppelin Monitor"));
    // Before: the pack's own leads (state diff, Forta, canary, source checks) have no such lead.
    const own = [...watchLeads(readObservation(ws)), ...sourceLeads(ws)];
    assert.ok(!own.some((l) => l.check === "admin-call-by-non-owner"), "the pack did not have this lead");
    const silentBefore = own.find((l) => l.check === "implementation-changed" && l.block === 5);
    assert.equal(silentBefore.corroborated, false, "before: only the slot diff saw the silent upgrade");
    // After: the Monitor's lead is in the 12-lead brief, and the silent upgrade has two engines.
    assert.match(prep.env.CHAIN_BRIEF, new RegExp(`\\[High\\] admin-call-by-non-owner at ${ATTACKER} — seen only by OpenZeppelin Monitor`));
    assert.match(prep.env.CHAIN_BRIEF, /implementation-changed at 0xe7f1725e7734ce288f8367e1bb143e90bb3f0512 block 5 — Touchstone slot diff \+ OpenZeppelin Monitor AGREE/);
    assert.match(prep.env.CHAIN_BRIEF, /No Upgraded event was emitted/, "the pack's text for the silent upgrade is kept");
    assert.doesNotMatch(prep.env.CHAIN_BRIEF, /OpenZeppelin Monitor did NOT run/);
  } finally { cleanupWorkspace(ws); }
  leftNothing(before);
});

test("chain prepass in lab mode with a missing monitor image says so in the brief and the record", { skip: !hasTools && "chain-tools image not built", timeout: 600_000 }, async () => {
  const ws = makeWorkspace(CHAIN_LAB);
  try {
    const prep = await withImage("touchstone/oz-monitor:does-not-exist", () => chainPrepass(ws, { emit: () => {} }, { mode: "chain-watch", analyze: watchLeads, monitor: true }));
    assert.equal(prep.record.source, false);
    assert.equal(prep.record.ozMonitor, false);
    assert.match(prep.record.ozMonitorReason, /image not built/);
    assert.match(prep.env.CHAIN_BRIEF, /NOTE: OpenZeppelin Monitor did NOT run \(image not built/);
    assert.match(prep.env.CHAIN_BRIEF, /does NOT mean the chain is clean/);
    assert.doesNotMatch(prep.env.CHAIN_BRIEF, /admin-call-by-non-owner/);
  } finally { cleanupWorkspace(ws); }
});

test("chain prepass in source mode does not run the monitor or add its fields", async () => {
  const ws = makeWorkspace(CHAIN_LAB);
  try {
    execFileSync("rm", [join(ws, "src", "ChainWatchLab.sol")]);
    const prep = await withImage("touchstone/oz-monitor:does-not-exist", () => chainPrepass(ws, { emit: () => {} }, { mode: "chain-watch", analyze: () => [], monitor: true }));
    assert.equal(prep.record.source, true);
    assert.equal("ozMonitor" in prep.record, false);
    assert.doesNotMatch(prep.env.CHAIN_BRIEF, /OpenZeppelin Monitor/);
  } finally { cleanupWorkspace(ws); }
});
