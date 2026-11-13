// OpenZeppelin Monitor through runTool() for the chain-watch pack (lib/oz-monitor.mjs).
// The real-run tests need the monitor image (tools/build-oz-monitor-image.sh) and the
// chain-tools image, and skip when one is missing. The parse tests need no Docker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// The containers and networks of one lab tag, so a test can show it left nothing behind.
// Other test files (chain-watch lab mode) start their own labs at the same time, so a
// check looks only at its own tag.
const newTag = () => randomBytes(4).toString("hex");
const ours = (tag) => {
  const list = (args) => execFileSync("docker", args, { encoding: "utf8" }).split("\n").filter((n) => n.startsWith("touchstone-ozmon-") && n.endsWith(`-${tag}`));
  return [...list(["ps", "-a", "--format", "{{.Names}}"]), ...list(["network", "ls", "--format", "{{.Name}}"])].sort();
};
const leftNothing = (tag) => assert.deepEqual(ours(tag), [], `no lab container or network with tag ${tag} is left`);
// The prepass picks its own tag. A lab from another test file goes away when that test
// ends; a lab this test leaked stays. So wait for the new ones to go, up to 3 minutes.
const allOurs = () => {
  const list = (args) => execFileSync("docker", args, { encoding: "utf8" }).split("\n").filter((n) => n.startsWith("touchstone-ozmon-"));
  return [...list(["ps", "-a", "--format", "{{.Names}}"]), ...list(["network", "ls", "--format", "{{.Name}}"])].sort();
};
const leftNothingNew = async (before) => {
  let left = [];
  for (const end = Date.now() + 180_000; Date.now() < end; await new Promise((r) => setTimeout(r, 2000))) {
    left = allOurs().filter((n) => !before.includes(n));
    if (!left.length) return;
  }
  assert.deepEqual(left, [], "no lab container or network is left");
};

// ---- parse: pure, no Docker

// One match in the shape the script trigger receives on stdin.
const match = (monitor, block, { from = ATTACKER, to = PROXY, functions = [], events = [], hash = "0xabc0000000000000",
  slug = "lab", watched = monitor === "canary" ? CANARY : PROXY, logs = events.length ? [{ address: PROXY }] : [] } = {}) => ({
  args: [],
  monitor_match: { EVM: {
    monitor: { name: monitor, addresses: [{ address: watched, contract_spec: null }] },
    network_slug: slug,
    logs,
    transaction: { blockNumber: `0x${block.toString(16)}`, from, hash, to },
    matched_on: { functions: functions.map((s) => ({ signature: s, expression: null })), events: events.map((s) => ({ signature: s, expression: null })), transactions: [] },
    matched_on_args: { functions: functions.map((s) => ({ signature: s, args: [{ name: "implementation", value: "0xdead" }] })), events: null },
  } },
});
const CTX = { address: PROXY, owner: OWNER, baseline: 4, canary: CANARY };
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

test("parseOzMonitor fails closed on a match that is not bound to the lab target", () => {
  const swap = (m) => goodOutput().replace(/^MATCH admin 5 .*$/m, line("admin", 5, m));
  const cases = [
    [match("admin", 5, { functions: [UPGRADE], slug: "ethereum_mainnet" }), /on network ethereum_mainnet, expected lab/],
    [match("admin", 5, { functions: [UPGRADE], watched: ATTACKER }), /watches 0x7099.*, expected 0xe7f1/],
    [match("admin", 5, { functions: [UPGRADE], to: ATTACKER }), /calls 0x7099.*, expected 0xe7f1/],
    [match("admin", 5, { events: ["Upgraded(address)"], logs: [{ address: ATTACKER }] }), /an event but no log from 0xe7f1/],
  ];
  for (const [m, reason] of cases) {
    const r = parseOzMonitor(swap(m), EXPECT, CTX);
    assert.equal(r.available, false, reason.source);
    assert.match(r.reason, reason);
    assert.deepEqual(r.leads, []);
  }
  const canary = (from) => [run("canary", 5, 0, 1), line("canary", 5, match("canary", 5, { from, to: ATTACKER }))].join("\n");
  const only = { monitors: ["canary"], from: 5, to: 5 };
  assert.equal(parseOzMonitor(canary(CANARY), only, CTX).leads[0].check, "canary-wallet-moved");
  assert.match(parseOzMonitor(canary(ATTACKER), only, CTX).reason, /from 0x7099.*, expected the canary 0x3c44/);
});

test("parseOzMonitor fails closed on a non-owner match whose sender is the owner", () => {
  const out = goodOutput().replace(/^MATCH non_owner 5 .*$/m, line("non_owner", 5, match("non_owner", 5, { functions: [UPGRADE], from: OWNER })));
  const r = parseOzMonitor(out, EXPECT, CTX);
  assert.equal(r.available, false);
  assert.match(r.reason, /bad match for non_owner at block 5: match is from the owner 0xf39f/);
  assert.deepEqual(r.leads, []);
  const noOwner = parseOzMonitor(goodOutput(), EXPECT, { ...CTX, owner: undefined });
  assert.equal(noOwner.available, false, "no owner to compare with is a failure");
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

// ---- the argv and the exit code, through the real runTool and a PATH docker shim

// A fake docker on PATH. It logs each call, plays the lab (writes the observation
// into the lab workspace, says the network is internal), and for the monitor run
// prints `out` and exits `code`, after `sleepMs` if given. With `ignoreTerm` it plays
// a client that ignores SIGTERM and exits 0 late, as docker run can today.
const OBS = { chainId: 31337, address: PROXY, fromBlock: 5, toBlock: 5, snapshots: [{ block: 4, owner: OWNER }], canary: { address: CANARY, transactions: [] } };
const SHIM = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const dir = __dirname, args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls"), JSON.stringify(args) + "\\n");
const cfg = JSON.parse(fs.readFileSync(path.join(dir, "cfg.json"), "utf8"));
if (args[0] === "network" && args[1] === "inspect") console.log("true");
else if (args[0] === "inspect") console.log("true");
else if (args[0] === "run" && args.includes("-d")) {
  const ws = args[args.findIndex((a) => a.endsWith(":/work"))].slice(0, -":/work".length);
  fs.writeFileSync(path.join(ws, "chain-observation.json"), JSON.stringify(cfg.obs));
  fs.writeFileSync(path.join(ws, "chain-observation.ready"), "");
} else if (args[0] === "run") {
  if (cfg.ignoreTerm) process.on("SIGTERM", () => {});
  process.stdout.write(cfg.out);
  setTimeout(() => process.exit(cfg.code), cfg.sleepMs || 0);
}
`;
const withDockerShim = async ({ out, code = 0, sleepMs = 0, ignoreTerm = false }, fn) => {
  const dir = mkdtempSync(join(tmpdir(), "ozmon-shim-"));
  writeFileSync(join(dir, "cfg.json"), JSON.stringify({ obs: OBS, out, code, sleepMs, ignoreTerm }));
  writeFileSync(join(dir, "docker"), SHIM, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try {
    const result = await fn();
    const log = join(dir, "calls");
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
    return { result, calls };
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
};
const SHIM_OUT = [
  run("admin", 5, 0, 1), line("admin", 5, match("admin", 5, { functions: [UPGRADE] })),
  run("non_owner", 5, 0, 0), run("canary", 5, 0, 0),
].join("\n") + "\n";

test("the monitor runs from the pinned image with --pull=never, only on the owned --internal lab network", async () => {
  const tag = newTag();
  const { result, calls } = await withDockerShim({ out: SHIM_OUT }, () => ozMonitorLeads(CHAIN_LAB, { tag }));
  assert.equal(result.available, true, result.reason);
  assert.deepEqual(result.leads.map((l) => `${l.check} ${l.block}`), ["implementation-changed 5"]);
  const net = `touchstone-ozmon-${tag}`;
  const create = calls.find((a) => a[0] === "network" && a[1] === "create");
  assert.ok(create.includes("--internal"), "the network has no route out");
  assert.equal(create.at(-1), net);
  const lab = calls.find((a) => a[0] === "run" && a.includes("-d"));
  const monitor = calls.find((a) => a[0] === "run" && !a.includes("-d"));
  for (const argv of [lab, monitor]) {
    assert.ok(argv.includes("--pull=never"));
    assert.equal(argv.filter((a) => a === "--network" || a.startsWith("--network=") || a === "--net").length, 1, "one network flag");
    assert.equal(argv[argv.indexOf("--network") + 1], net, "never bridge, host or none: the lab network");
  }
  assert.deepEqual(monitor.slice(0, 3), ["run", "--rm", "--pull=never"]);
  assert.equal(monitor[monitor.indexOf("bash") - 1], OZ_MONITOR_DEFAULT_IMAGE);
  assert.deepEqual(monitor.slice(monitor.indexOf("bash")), ["bash", "/opt/touchstone/run.sh", "5", "5", ...MONITORS]);
  assert.ok(monitor.includes("--cap-drop") && monitor[monitor.indexOf("--cap-drop") + 1] === "ALL");
  assert.ok(calls.some((a) => a[0] === "network" && a[1] === "rm" && a[2] === net), "the network is removed");
});

test("runMonitors refuses a network that is not an owned lab network", async () => {
  for (const net of ["bridge", "host", "none", "touchstone-ozmon-x", undefined]) {
    const { result, calls } = await withDockerShim({ out: SHIM_OUT }, () => runMonitors({ net, obs: OBS }));
    assert.equal(result.available, false, String(net));
    assert.match(result.reason, /not an owned lab network/);
    assert.ok(!calls.some((a) => a[0] === "run"), "no container is started");
  }
});

test("a monitor run that exits non-zero is unavailable, even with valid output", async () => {
  const { result } = await withDockerShim({ out: SHIM_OUT, code: 3 }, () => ozMonitorLeads(CHAIN_LAB, { tag: newTag() }));
  assert.equal(result.available, false);
  assert.match(result.reason, /^monitor container exited 3/);
  assert.deepEqual(result.leads, []);
});

test("a monitor run that prints nothing and exits 0 is unavailable", async () => {
  const { result } = await withDockerShim({ out: "" }, () => ozMonitorLeads(CHAIN_LAB, { tag: newTag() }));
  assert.equal(result.available, false);
  assert.match(result.reason, /no run for monitor admin at block 5/);
});

test("a monitor run that times out is unavailable, even with valid output so far", async () => {
  const t0 = Date.now();
  const { result } = await withDockerShim({ out: SHIM_OUT, sleepMs: 20_000 }, () => ozMonitorLeads(CHAIN_LAB, { tag: newTag(), timeoutMs: 1000 }));
  assert.equal(result.available, false);
  assert.equal(result.reason, "timed out");
  assert.deepEqual(result.leads, []);
  assert.ok(Date.now() - t0 < 10_000, "the shim dies on the client kill");
});

test("a monitor run that ends after its deadline with code 0 is unavailable", async () => {
  const { result } = await withDockerShim({ out: SHIM_OUT, sleepMs: 3000, ignoreTerm: true }, () => ozMonitorLeads(CHAIN_LAB, { tag: newTag(), timeoutMs: 1000 }));
  assert.equal(result.available, false);
  assert.equal(result.reason, "timed out");
  assert.deepEqual(result.leads, []);
});

// ---- failure cases through the real Docker path

test("a missing monitor image gives unavailable and starts no lab", async () => {
  const tag = newTag();
  const r = await withImage("touchstone/oz-monitor:does-not-exist", () => ozMonitorLeads(CHAIN_LAB, { tag }));
  assert.equal(r.available, false);
  assert.match(r.reason, /image not built \(spike\/tools\/build-oz-monitor-image\.sh\)/);
  assert.deepEqual(r.leads, []);
  leftNothing(tag);
});

test("a lab image that is missing gives unavailable and removes the network", { skip: !hasMonitor && "monitor image not built", timeout: 120_000 }, async () => {
  const tag = newTag();
  const r = await ozMonitorLeads(CHAIN_LAB, { labImage: "touchstone-chain-tools:does-not-exist", tag });
  assert.equal(r.available, false);
  assert.match(r.reason, /lab did not start/);
  leftNothing(tag);
});

test("a lab that stops before it is ready gives unavailable", { skip: needs, timeout: 300_000 }, async () => {
  const tag = newTag();
  const empty = mkdtempSync(join(tmpdir(), "ozmon-empty-"));
  try {
    const r = await ozMonitorLeads(empty, { tag }); // no lab source: observe.mjs fails and the container exits
    assert.equal(r.available, false);
    assert.match(r.reason, /lab stopped before it was ready|lab not ready/);
  } finally { rmSync(empty, { recursive: true, force: true }); }
  leftNothing(tag);
});

test("the lab network is --internal: a container on it cannot reach the outside", { skip: needs, timeout: 300_000 }, async () => {
  const tag = newTag();
  const handle = await startWatchLab(CHAIN_LAB, { tag });
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
  leftNothing(tag);
});

test("an unreachable lab RPC gives unavailable, not a clean result", { skip: needs, timeout: 300_000 }, async () => {
  const tag = newTag();
  const handle = await startWatchLab(CHAIN_LAB, { tag });
  try {
    execFileSync("docker", ["rm", "-f", handle.name], { stdio: "ignore" }); // the chain goes away, the network stays
    const r = await runMonitors(handle);
    assert.equal(r.available, false);
    assert.match(r.reason, /monitor admin failed at block 5/);
    assert.deepEqual(r.leads, []);
  } finally { await stopWatchLab(handle); }
  leftNothing(tag);
});

test("a monitor run that times out gives unavailable", { skip: needs, timeout: 300_000 }, async () => {
  const tag = newTag();
  const handle = await startWatchLab(CHAIN_LAB, { tag });
  try {
    const r = await runMonitors(handle, { timeoutMs: 1500 });
    assert.equal(r.available, false);
    assert.equal(r.reason, "timed out");
    assert.deepEqual(r.leads, []);
  } finally { await stopWatchLab(handle); } // it removes every container on the lab network
  leftNothing(tag);
});

// Seen before 6526bbe: the client is killed, but the monitor container lives on until
// stopWatchLab removes it. This turns green with the shared runDocker timeout fix.
test("a monitor run that times out leaves no monitor container before cleanup", { skip: needs, timeout: 300_000,
  todo: "needs the shared runDocker timeout fix (6526bbe)" }, async () => {
  const tag = newTag();
  const handle = await startWatchLab(CHAIN_LAB, { tag });
  try {
    const t0 = Date.now();
    await runMonitors(handle, { timeoutMs: 1500 });
    const members = execFileSync("docker", ["ps", "-a", "--filter", `network=${handle.net}`, "--format", "{{.Names}}"], { encoding: "utf8" }).trim().split("\n");
    assert.deepEqual(members, [handle.name], "only the lab is left on the network");
    assert.ok(Date.now() - t0 < 1500 + 8000, "returned near timeoutMs");
  } finally { await stopWatchLab(handle); }
  leftNothing(tag);
});

// ---- the real run on the chain-watch lab

test("chain-watch lab: OpenZeppelin Monitor sees the non-owner upgrades, the silent upgrade and the canary", { skip: needs, timeout: 300_000 }, async () => {
  const tag = newTag();
  const r = await ozMonitorLeads(CHAIN_LAB, { tag });
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
  leftNothing(tag);
});

test("chain-watch prepass (lab mode) adds a lead the pack did not have, and a second engine on the silent upgrade", { skip: needs, timeout: 600_000 }, async () => {
  const before = allOurs();
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
  await leftNothingNew(before);
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
