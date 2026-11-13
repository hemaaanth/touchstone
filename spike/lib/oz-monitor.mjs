// OpenZeppelin Monitor adapter for the chain-watch pack.
//
// OpenZeppelin Monitor (AGPL-3.0) is run as a separate program. We run the real
// binary in its own image and read the matches its script trigger prints. No
// Monitor code is copied or imported.
//
// The monitor needs a live chain. So we start our own copy of the chain-watch lab
// world (the chain-tools image, observe.mjs --serve) on a fresh `--internal` Docker
// network. That network has no route out. Its only members are the lab Anvil and the
// monitor. The monitor runs through lib/wrap.mjs runTool() on that network,
// --pull=never, no capabilities. It never reaches a public RPC.
//
// The lab world is deterministic, so this copy has the same addresses and blocks as
// the copy the pre-pass observes. The monitor config is built from this copy's own
// observation, so it never depends on that.
//
// Three monitors run once per block over the lab block range:
//   admin      the proxy's admin functions and events. It reads calls, so it also
//              sees an upgrade that emits no event.
//   non_owner  the same admin functions, but only when the sender is not the owner the
//              lab read at the baseline block, and the call succeeded.
//   canary     any successful transaction sent by the canary wallet.
//
// Fail closed: a missing image, a lab that does not start, a network that is not
// --internal or not our own lab network, a timeout, a run that exits non-zero, a
// match count that does not agree with the monitor's own count, a match we cannot
// read, or a match that is not bound to this lab (network, watched address, the
// proxy or the canary) gives `available: false` with a reason. It never gives a
// clean result.
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTool } from "./wrap.mjs";
import { createLabNetwork, removeLabNetwork } from "./lab-net.mjs";
import { removeTempDir, trackTempDir } from "./temp-dirs.mjs";

export const OZ_MONITOR_DEFAULT_IMAGE = "touchstone/oz-monitor:1.7.0";
// Read at call time, so a test can point it at a missing image.
export const ozMonitorImage = () => process.env.OZ_MONITOR_IMAGE || OZ_MONITOR_DEFAULT_IMAGE;
export const OZ_LAB_IMAGE = "touchstone-chain-tools:wave1";
const ENGINE = "OpenZeppelin Monitor";
const LAB_ALIAS = "labchain";
// The baked observe.mjs in the chain-tools image listens on 127.0.0.1 only. The
// source copy honors ANVIL_HOST, so we mount it, as lib/fork-proof.mjs does.
const OBSERVE_SRC = fileURLToPath(new URL("../packs/keys/runtime/observe.mjs", import.meta.url));

const lc = (value) => String(value ?? "").toLowerCase();
const shortHash = (hash) => String(hash ?? "?").slice(0, 10);

// The proxy's admin surface, as the monitor's contract spec (an ABI).
const fn = (name, inputs) => ({ type: "function", name, stateMutability: "nonpayable", outputs: [],
  inputs: inputs.map(([n, type]) => ({ name: n, type })) });
const ev = (name, inputs) => ({ type: "event", name, anonymous: false,
  inputs: inputs.map(([n, type, indexed]) => ({ name: n, type, indexed: Boolean(indexed) })) });
const ABI = [
  fn("upgradeTo", [["implementation", "address"], ["announce", "bool"]]),
  fn("changeAdmin", [["admin", "address"]]),
  fn("transferOwnership", [["next", "address"]]),
  fn("grantRole", [["role", "bytes32"], ["account", "address"]]),
  fn("revokeRole", [["role", "bytes32"], ["account", "address"]]),
  ev("Upgraded", [["implementation", "address", true]]),
  ev("AdminChanged", [["previousAdmin", "address"], ["newAdmin", "address"]]),
  ev("OwnershipTransferred", [["previousOwner", "address", true], ["newOwner", "address", true]]),
  ev("RoleGranted", [["role", "bytes32", true], ["account", "address", true], ["sender", "address", true]]),
  ev("RoleRevoked", [["role", "bytes32", true], ["account", "address", true], ["sender", "address", true]]),
];
const signature = (item) => `${item.name}(${item.inputs.map((i) => i.type).join(",")})`;
const FUNCTIONS = ABI.filter((i) => i.type === "function").map(signature);
const EVENTS = ABI.filter((i) => i.type === "event").map(signature);

// A call or an event, named by the same check as the slot diff, so the leads merge.
const CHECK = {
  upgradeTo: "implementation-changed", Upgraded: "implementation-changed",
  changeAdmin: "admin-changed", AdminChanged: "admin-changed",
  transferOwnership: "owner-changed", OwnershipTransferred: "owner-changed",
  grantRole: "role-granted", RoleGranted: "role-granted",
  revokeRole: "role-revoked", RoleRevoked: "role-revoked",
};
const impactOf = (check) => (check === "role-revoked" ? "Low" : "High");
export const MONITORS = ["admin", "non_owner", "canary"];

// The block range to scan: the changes, then the canary move.
export function blockRange(obs) {
  const blocks = [obs.fromBlock, obs.toBlock, ...(obs.canary?.transactions ?? []).map((t) => t.block)].filter(Number.isInteger);
  return blocks.length ? { from: Math.min(...blocks), to: Math.max(...blocks) } : null;
}

// The monitor config for one lab observation. Pure.
export function monitorConfig(obs) {
  const owner = obs.snapshots?.[0]?.owner;
  const monitor = (name, address, contractSpec, matchConditions) => ({ name, paused: false, networks: ["lab"],
    addresses: [contractSpec ? { address, contract_spec: contractSpec } : { address }],
    match_conditions: { functions: [], events: [], transactions: [], ...matchConditions },
    trigger_conditions: [], triggers: ["record_match"] });
  return {
    network: { network_type: "EVM", slug: "lab", name: "Touchstone chain-watch lab (Anvil, internal network)",
      rpc_urls: [{ type_: "rpc", url: { type: "plain", value: `http://${LAB_ALIAS}:8545` }, weight: 100 }],
      chain_id: Number(obs.chainId ?? 31337), block_time_ms: 1000, confirmation_blocks: 1,
      cron_schedule: "0/5 * * * * *", max_past_blocks: 50, store_blocks: false },
    trigger: { record_match: { name: "Record match", trigger_type: "script",
      config: { language: "Bash", script_path: "/opt/touchstone/record.sh", arguments: [], timeout_ms: 10_000 } } },
    monitors: {
      admin: monitor("admin", obs.address, ABI, {
        functions: FUNCTIONS.map((s) => ({ signature: s, expression: null })),
        events: EVENTS.map((s) => ({ signature: s, expression: null })),
        transactions: [{ status: "Success", expression: null }] }),
      non_owner: monitor("non_owner", obs.address, ABI, {
        functions: FUNCTIONS.map((s) => ({ signature: s, expression: null })),
        transactions: [{ status: "Success", expression: `from != ${owner}` }] }),
      canary: monitor("canary", obs.canary?.address, null, {
        transactions: [{ status: "Success", expression: `from == ${obs.canary?.address}` }] }),
    },
  };
}

const argText = (args) => (args ?? []).map((a) => `${a.name}=${a.value}`).join(", ");

// One match as leads. `ctx` is { address, owner, baseline, canary }.
// A match must be bound to this lab: network slug "lab", the monitor's own address,
// and a transaction to the proxy (a log from the proxy for an event), or from the
// canary for the canary monitor, and not from the owner for the non-owner monitor.
// A match that is not is a failure, not a lead.
// The texts for the admin and canary monitors stay short on purpose. mergeChain keeps the
// longest text, and the pack's own text for the same change says more (the slots, the
// missing event). The monitor's own lead, admin-call-by-non-owner, carries the detail.
function matchLeads(monitor, block, match, ctx) {
  const m = match?.monitor_match?.EVM;
  if (!m || typeof m !== "object" || !m.transaction || !m.matched_on) throw new Error("match has no EVM transaction");
  if (m.monitor?.name !== monitor) throw new Error(`match names monitor ${m.monitor?.name}, expected ${monitor}`);
  if (m.network_slug !== "lab") throw new Error(`match is on network ${m.network_slug}, expected lab`);
  // Every monitor matches only successful transactions. The match must say so, and a
  // receipt, when the trigger gets one, must agree.
  if (!(m.matched_on.transactions ?? []).some((t) => t?.status === "Success")) throw new Error("match was not matched on a successful transaction");
  if (m.receipt && m.receipt.status != null && !["0x1", 1, true].includes(m.receipt.status)) throw new Error(`match has receipt status ${m.receipt.status}`);
  const tx = m.transaction;
  if (Number(BigInt(tx.blockNumber)) !== block) throw new Error(`match is in block ${tx.blockNumber}, expected ${block}`);
  const from = lc(tx.from);
  const where = lc(ctx.address);
  const watched = monitor === "canary" ? lc(ctx.canary) : where;
  const addresses = (m.monitor.addresses ?? []).map((a) => lc(a.address));
  if (!watched || addresses.length !== 1 || addresses[0] !== watched) throw new Error(`match watches ${addresses.join(",") || "no address"}, expected ${watched}`);
  if (monitor === "canary" && from !== watched) throw new Error(`match is from ${from}, expected the canary ${watched}`);
  if (monitor === "non_owner" && (!ctx.owner || from === lc(ctx.owner))) throw new Error(`match is from the owner ${lc(ctx.owner)}, expected a non-owner`);
  if (monitor !== "canary" && (m.matched_on.functions ?? []).length && lc(tx.to) !== where) throw new Error(`match calls ${lc(tx.to)}, expected ${where}`);
  if (monitor === "admin" && (m.matched_on.events ?? []).length && !(m.logs ?? []).some((l) => lc(l.address) === where)) {
    throw new Error(`match has an event but no log from ${where}`);
  }
  const fnArgs = new Map((m.matched_on_args?.functions ?? []).map((f) => [f.signature, f.args]));
  const leads = [];
  if (monitor === "canary") {
    leads.push({ engine: ENGINE, check: "canary-wallet-moved", impact: "High", where: from, block,
      description: `Block ${block}: OpenZeppelin Monitor saw the canary wallet send a transaction.` });
    return leads;
  }
  for (const f of m.matched_on.functions ?? []) {
    const name = String(f.signature).split("(")[0];
    const call = `${f.signature}${fnArgs.has(f.signature) ? ` with ${argText(fnArgs.get(f.signature))}` : ""}`;
    if (monitor === "non_owner") {
      leads.push({ engine: ENGINE, check: "admin-call-by-non-owner", impact: "High", where: from, calls: [{ block, call, hash: tx.hash }] });
    } else if (CHECK[name]) {
      leads.push({ engine: ENGINE, check: CHECK[name], impact: impactOf(CHECK[name]), where, block,
        description: `Block ${block}: OpenZeppelin Monitor saw a successful call to ${name}.` });
    }
  }
  if (monitor === "admin") {
    for (const e of m.matched_on.events ?? []) {
      const name = String(e.signature).split("(")[0];
      if (!CHECK[name]) continue;
      leads.push({ engine: ENGINE, check: CHECK[name], impact: impactOf(CHECK[name]), where, block,
        description: `Block ${block}: OpenZeppelin Monitor saw the event ${name}.` });
    }
  }
  return leads;
}

// Parse the stdout of run.sh. Pure, so the failure cases are easy to test.
//   expected  { monitors, from, to }: every monitor must have run on every block.
//   ctx       { address, owner, baseline, canary }: the lab target, to bind each
//             match to, and the lead text.
// Returns { available, reason?, leads }.
export function parseOzMonitor(stdout, expected, ctx) {
  const fail = (reason) => ({ available: false, reason, leads: [] });
  const runs = new Map();
  const matches = new Map();
  let lastRun = null;
  for (const line of String(stdout ?? "").split("\n")) {
    let r;
    if ((r = /^RUN (\S+) (\d+) (\d+) (\d+|-)$/.exec(line))) {
      lastRun = `${r[1]} ${r[2]}`;
      // One run per monitor and block. A second one would hide the first one's failure.
      if (runs.has(lastRun)) return fail(`two runs for monitor ${r[1]} at block ${r[2]}`);
      runs.set(lastRun, { code: Number(r[3]), total: r[4] === "-" ? null : Number(r[4]), error: null });
    } else if ((r = /^ERR (.*)$/.exec(line)) && lastRun) {
      runs.get(lastRun).error = r[1].trim();
    } else if ((r = /^MATCH (\S+) (\d+) (.*)$/.exec(line))) {
      const key = `${r[1]} ${r[2]}`;
      let json;
      try { json = JSON.parse(r[3]); } catch { return fail(`unreadable match for ${r[1]} at block ${r[2]}`); }
      matches.set(key, [...(matches.get(key) ?? []), json]);
    }
  }
  const leads = [];
  for (const monitor of expected.monitors) {
    for (let block = expected.from; block <= expected.to; block++) {
      const key = `${monitor} ${block}`;
      const run = runs.get(key);
      if (!run) return fail(`no run for monitor ${monitor} at block ${block}`);
      if (run.code !== 0) return fail(`monitor ${monitor} failed at block ${block}: ${(run.error || `exit ${run.code}`).slice(0, 200)}`);
      if (run.total === null) return fail(`monitor ${monitor} at block ${block} printed no match count`);
      const found = matches.get(key) ?? [];
      if (found.length !== run.total) return fail(`monitor ${monitor} at block ${block} found ${run.total} matches but the trigger kept ${found.length}`);
      for (const match of found) {
        try { leads.push(...matchLeads(monitor, block, match, ctx)); } catch (error) { return fail(`bad match for ${monitor} at block ${block}: ${error.message}`); }
      }
    }
  }
  return { available: true, leads: groupNonOwner(leads, ctx) };
}

// One lead per sender for admin calls by a non-owner, with every call it made.
function groupNonOwner(leads, ctx) {
  const out = [];
  const bySender = new Map();
  for (const lead of leads) {
    if (lead.check !== "admin-call-by-non-owner") { out.push(lead); continue; }
    const prev = bySender.get(lead.where);
    if (prev) prev.calls.push(...lead.calls); else bySender.set(lead.where, lead);
  }
  for (const lead of bySender.values()) {
    const list = lead.calls.map((c) => `${c.call} at block ${c.block} (tx ${shortHash(c.hash)})`).join("; ");
    out.push({ engine: ENGINE, check: lead.check, impact: lead.impact, where: lead.where,
      blocks: lead.calls.map((c) => c.block),
      description: `OpenZeppelin Monitor saw ${lead.where} call admin functions on ${lc(ctx.address)} and succeed: ${list}. `
        + `${lead.where} is not the owner (${lc(ctx.owner)}) the lab read at block ${ctx.baseline}. `
        + "So a sender who is not the owner can call these admin functions. Check who is allowed to call each one." });
  }
  return out;
}

// ---------------------------------------------------------------- the lab chain

function docker(args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    execFile("docker", args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), timedOut: Boolean(err?.killed) });
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Start the chain-watch lab from the workspace's own lab source on a fresh
// --internal network with its own small subnet (lib/lab-net.mjs; no whole default
// Docker pool). Throws with a reason. The caller must stopWatchLab(). On SIGINT/SIGTERM
// lab-net removes the network and every container on it, and lib/temp-dirs.mjs the
// lab workspace.
// tag (8 hex) names the network and the lab container. A test passes its own.
export async function startWatchLab(ws, { readyTimeoutMs = 240_000, labImage = OZ_LAB_IMAGE, tag = randomBytes(4).toString("hex") } = {}) {
  if (!/^[0-9a-f]{8}$/.test(tag)) throw new Error("tag must be 8 hex characters");
  const handle = { net: `touchstone-ozmon-${tag}`, name: `touchstone-ozmon-lab-${tag}`, labWs: trackTempDir(mkdtempSync(join(tmpdir(), `ozmon-lab-${tag}-`))), started: false, netMade: false };
  try {
    for (const part of ["src", "lib", "foundry.toml"]) {
      if (existsSync(join(ws, part))) cpSync(join(ws, part), join(handle.labWs, part), { recursive: true });
    }
    const made = await createLabNetwork(handle.net, ["--internal", "--label", "touchstone=oz-monitor"], { docker });
    if (made.code !== 0) throw new Error(`network create failed: ${made.stderr.trim().slice(0, 200)}`);
    handle.netMade = true;
    // A network name proves nothing. Ask Docker that it really has no route out.
    const internal = await docker(["network", "inspect", "-f", "{{.Internal}}", handle.net]);
    if (internal.stdout.trim() !== "true") throw new Error(`network ${handle.net} is not --internal`);
    const run = await docker(["run", "-d", "--init", "--pull=never", "--name", handle.name, "--label", "touchstone=oz-monitor",
      "--network", handle.net, "--network-alias", LAB_ALIAS,
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "512", "--memory", "2g",
      "--user", `${process.getuid()}:${process.getgid()}`, "-e", "ANVIL_HOST=0.0.0.0", "-e", "HOME=/tmp",
      "-v", `${handle.labWs}:/work`, "-w", "/work", "-v", `${OBSERVE_SRC}:/opt/touchstone/observe.mjs:ro`,
      "--entrypoint", "node", labImage, "/opt/touchstone/observe.mjs", "chain-watch", "--serve"], { timeoutMs: 60_000 });
    if (run.code !== 0) throw new Error(`lab did not start: ${run.stderr.trim().split("\n").pop()?.slice(0, 200) ?? ""}`);
    handle.started = true;
    const deadline = Date.now() + readyTimeoutMs;
    while (!existsSync(join(handle.labWs, "chain-observation.ready"))) {
      const state = await docker(["inspect", "-f", "{{.State.Running}}", handle.name]);
      if (state.stdout.trim() !== "true") throw new Error("lab stopped before it was ready");
      if (Date.now() > deadline) throw new Error(`lab not ready in ${readyTimeoutMs} ms`);
      await sleep(500);
    }
    handle.obs = JSON.parse(readFileSync(join(handle.labWs, "chain-observation.json"), "utf8"));
    return handle;
  } catch (error) {
    await stopWatchLab(handle);
    throw error;
  }
}

export async function stopWatchLab(handle) {
  if (!handle) return;
  if (handle.started) await docker(["rm", "-f", handle.name], { timeoutMs: 30_000 });
  if (handle.netMade) {
    // A monitor run that timed out loses its docker client, but its container can live on
    // and hold the network. Every container on this network is ours: remove them all.
    const left = await docker(["ps", "-aq", "--filter", `network=${handle.net}`]);
    const ids = left.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    if (ids.length) await docker(["rm", "-f", ...ids], { timeoutMs: 30_000 });
    await removeLabNetwork(handle.net, { docker, timeoutMs: 30_000 });
  }
  removeTempDir(handle.labWs);
}

// Write the config tree the monitor reads from /work/config.
function writeConfig(dir, config) {
  for (const sub of ["networks", "monitors", "triggers", "filters"]) mkdirSync(join(dir, "config", sub), { recursive: true });
  writeFileSync(join(dir, "config", "networks", "lab.json"), JSON.stringify(config.network, null, 2));
  writeFileSync(join(dir, "config", "triggers", "record.json"), JSON.stringify(config.trigger, null, 2));
  for (const [name, monitor] of Object.entries(config.monitors)) {
    writeFileSync(join(dir, "config", "monitors", `${name}.json`), JSON.stringify(monitor, null, 2));
  }
}

// Run the monitors over a lab that is already up. Resolves (never rejects).
// The only network it runs on is the lab's own --internal network.
const LAB_NET = /^touchstone-ozmon-[0-9a-f]{8}$/;
export async function runMonitors(handle, { timeoutMs = 180_000 } = {}) {
  if (!LAB_NET.test(String(handle?.net))) return { available: false, reason: `not an owned lab network: ${String(handle?.net).slice(0, 60)}`, leads: [] };
  // Ask Docker again here: a caller can pass any handle, not only one from startWatchLab.
  const internal = await docker(["network", "inspect", "-f", "{{.Internal}}", handle.net]);
  if (internal.stdout.trim() !== "true") return { available: false, reason: `network ${handle.net} is not --internal`, leads: [] };
  const obs = handle.obs;
  const range = blockRange(obs);
  if (!range || !obs.address || !obs.snapshots?.[0]?.owner || !obs.canary?.address) {
    return { available: false, reason: "lab observation has no address, owner, canary or block range", leads: [] };
  }
  const dir = trackTempDir(mkdtempSync(join(tmpdir(), "ozmon-cfg-")));
  try {
    writeConfig(dir, monitorConfig(obs));
    const t0 = Date.now();
    const r = await runTool({ image: ozMonitorImage(), ws: dir, network: handle.net, timeoutMs,
      cmd: ["bash", "/opt/touchstone/run.sh", String(range.from), String(range.to), ...MONITORS] });
    // runDocker reports a timeout (main 44ba808). A result after the deadline is a
    // timeout too, as a backstop: before that fix a docker client could wait for the
    // container and report code 0 and timedOut false.
    if (r.timedOut || Date.now() - t0 > timeoutMs) return { available: false, reason: "timed out", leads: [] };
    if (/unable to find image|no such image|pull access denied/i.test(r.stderr)) {
      return { available: false, reason: "image not built (spike/tools/build-oz-monitor-image.sh)", leads: [] };
    }
    if (r.code !== 0) return { available: false, reason: `monitor container exited ${r.code}: ${r.stderr.trim().split("\n").pop()?.slice(0, 200) ?? ""}`, leads: [] };
    return parseOzMonitor(r.stdout, { monitors: MONITORS, ...range },
      { address: obs.address, owner: obs.snapshots[0].owner, baseline: obs.snapshots[0].block, canary: obs.canary.address });
  } finally {
    removeTempDir(dir);
  }
}

// Monitor leads in the shape the chain packs merge (packs/keys/common.mjs). Starts
// and stops its own lab chain. Resolves (never rejects). A lead is never a finding.
export async function ozMonitorLeads(ws, { timeoutMs, readyTimeoutMs, labImage, tag } = {}) {
  let handle = null;
  try {
    // Check the image first: a missing image must not cost a lab start.
    const image = await docker(["image", "inspect", ozMonitorImage()]);
    if (image.code !== 0) return { available: false, reason: "image not built (spike/tools/build-oz-monitor-image.sh)", leads: [] };
    handle = await startWatchLab(ws, { readyTimeoutMs, labImage, tag });
    return await runMonitors(handle, { timeoutMs });
  } catch (error) {
    return { available: false, reason: String(error?.message ?? error).slice(0, 300), leads: [] };
  } finally {
    await stopWatchLab(handle);
  }
}

// Tell the agent when the monitor did not run, so "no monitor leads" is never read as "clean".
export const ozMonitorNote = (monitor) => (monitor.available ? "" : `\n\nNOTE: OpenZeppelin Monitor did NOT run (${String(monitor.reason ?? "unknown").slice(0, 160)}). Having no monitor leads here does NOT mean the chain is clean. Read the chain state yourself.`);
