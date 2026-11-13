// Lab networks with a small fixed subnet.
//
// WHY. `docker network create` with no --subnet takes one whole default pool
// (a /16 or a /20). This host has about 31 of those. Parallel test runs create
// many lab networks at once and Docker fails with "all predefined address pools
// have been fully subnetted". So every lab network gets its own random /28 from
// LAB_RANGE, which the Docker default pools (172.17-31.0.0/16, 192.168.0.0/16)
// do not use and the host does not route.
//
// A /28 has 13 container addresses after the gateway. The largest lab puts 3-4
// containers on one network (two origins and a proxy, or a lab, a proxy and a
// few one-shot script containers), so a /28 is enough.
//
// The flags the caller passes (--internal, enable_icc=false) are kept exactly.
// Only --subnet is added. A lab gets no more network access than before.
//
// CLEANUP ON STOP. Networks made here are tracked. While any is tracked, a
// SIGINT/SIGTERM handler removes the containers attached to those networks and
// then the networks. It touches nothing else. If the handler is the only one for
// that signal, it re-raises the signal so the process still dies as before.

import { execFile, execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";

export const LAB_RANGE = "10.208.0.0/12"; // 10.208.0.0 - 10.223.255.255
export const LAB_PREFIX = 28;
export const MAX_ATTEMPTS = 8;

const RANGE_BASE = (10 << 24) | (208 << 16); // 10.208.0.0 as an unsigned int
const SLOTS = 1 << (LAB_PREFIX - 12); // number of /28 blocks in the /12 (65536)

function defaultDocker(args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    execFile("docker", args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        timedOut: Boolean(err?.killed),
      });
    });
  });
}

// One random /28 inside LAB_RANGE, as "a.b.c.d/28".
export function randomLabSubnet(pick = randomInt) {
  const n = (RANGE_BASE + pick(SLOTS) * (1 << (32 - LAB_PREFIX))) >>> 0;
  return `${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}/${LAB_PREFIX}`;
}

const OVERLAP = /overlap/i;

// Create a lab network. Same result shape as the callers' docker(): { code,
// stdout, stderr }, plus `subnet` on success. On a subnet overlap it picks a new
// subnet and tries again, up to MAX_ATTEMPTS. Any other error, or too many
// overlaps, returns code != 0 with a clear stderr: the caller fails closed.
export async function createLabNetwork(name, extraArgs = [], { docker = defaultDocker, pick = randomInt, attempts = MAX_ATTEMPTS } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    const subnet = randomLabSubnet(pick);
    const r = await docker(["network", "create", ...extraArgs, "--subnet", subnet, name], { timeoutMs: 20_000 });
    if (r.code === 0) {
      track(name);
      return { ...r, subnet };
    }
    last = r;
    if (!OVERLAP.test(r.stderr)) break;
  }
  const why = String(last?.stderr ?? "").trim().slice(0, 400);
  const overlapped = OVERLAP.test(why);
  return {
    code: last?.code || 1,
    stdout: String(last?.stdout ?? ""),
    stderr: overlapped
      ? `createLabNetwork: no free /${LAB_PREFIX} in ${LAB_RANGE} for ${name} after ${attempts} tries: ${why}`
      : `createLabNetwork: docker network create ${name} failed: ${why}`,
    timedOut: Boolean(last?.timedOut),
  };
}

// Remove a lab network and stop tracking it. Same result shape as docker().
export async function removeLabNetwork(name, { docker = defaultDocker, timeoutMs = 15_000 } = {}) {
  const r = await docker(["network", "rm", name], { timeoutMs });
  untrack(name);
  return r;
}

// ---- cleanup on SIGINT / SIGTERM (only what this process created) ----

const tracked = new Set();
const SIGNALS = ["SIGINT", "SIGTERM"];

function onSignal(sig) {
  const alone = process.listenerCount(sig) === 1;
  cleanupTrackedSync();
  for (const s of SIGNALS) process.removeListener(s, onSignal);
  if (alone) process.kill(process.pid, sig); // no other handler: die as before
}

function track(name) {
  if (tracked.size === 0) for (const s of SIGNALS) process.on(s, onSignal);
  tracked.add(name);
}

function untrack(name) {
  if (!tracked.delete(name)) return;
  if (tracked.size === 0) for (const s of SIGNALS) process.removeListener(s, onSignal);
}

export function trackedLabNetworks() { return [...tracked]; }

// Synchronous so it can finish inside a signal handler. For each network this
// process created: force-remove the containers attached to it, then remove it.
export function cleanupTrackedSync() {
  const run = (args) => {
    try { return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }); }
    catch { return ""; }
  };
  for (const net of [...tracked]) {
    const ids = run(["network", "inspect", "-f", "{{range $id, $c := .Containers}}{{$id}} {{end}}", net]).trim().split(/\s+/).filter(Boolean);
    if (ids.length) run(["rm", "-f", ...ids]);
    run(["network", "rm", net]);
    tracked.delete(net);
  }
}
