// Networks this harness creates, and only those.
//
// Docker's default address pools are small. A test that creates a network and
// does not remove it (a timed-out `docker run` still holding an endpoint, a
// process killed before its after() hook) eventually fails every later
// `docker network create` with "all predefined address pools have been fully
// subnetted".
//
// Every harness network uses one of the prefixes below. Creation records the
// name, removal drops containers still attached to it and then the network,
// and process exit retries anything this process still holds. `npm test`
// prunes leftovers from earlier runs first. A name that does not match a
// prefix is never created, removed, or pruned — including bridge, host, and
// none, and any network a person created for something else.
import { execFile, execFileSync } from "node:child_process";

export const OWNER_LABEL = "touchstone.owner=spike";

export const OWNED_NETWORK_PREFIXES = [
  "touchstone-reach-client-",
  "touchstone-reach-targets-",
  "touchstone-exec-targets-",
  "touchstone-inner-",
  "touchstone-outer-",
  "touchstone-fork-",
  "touchstone-txlab-",
  "touchstone-domains-",
  "touchstone-infra-moto-",
  "ts-shield-test-",
];

// Named containers that can pin one of those networks if a run is killed.
const OWNED_CONTAINER_PREFIXES = [
  "touchstone-reach-proxy-",
  "touchstone-reach-run-",
  "touchstone-granted-",
  "touchstone-evil-",
  "touchstone-exec-granted-",
  "touchstone-exec-evil-",
  "touchstone-live-origin-",
  "touchstone-lab-",
  "touchstone-proxy-",
  "touchstone-forklab-",
  "touchstone-txlab-",
  "touchstone-r1lab-",
  "touchstone-domains-",
  "ts-shield-poison-",
  "ts-garak-stub-",
];

const tracked = new Set();

export function isOwnedNetwork(name) {
  return typeof name === "string" && OWNED_NETWORK_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function assertOwned(name) {
  if (!isOwnedNetwork(name)) {
    throw new Error(`refusing to touch Docker network ${JSON.stringify(name)}: not a harness network`);
  }
}

export function trackOwnedNetwork(name) {
  assertOwned(name);
  tracked.add(name);
}

// Run one docker command. Never throws, so callers branch on code the same way
// lib/reach-confine.mjs and lib/proof-http.mjs always have.
export function docker(args, { timeoutMs = 30_000, maxBuffer = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile("docker", args, { timeout: timeoutMs, maxBuffer }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        timedOut: Boolean(err?.killed),
      });
    });
  });
}

function runSync(args, timeoutMs = 20_000) {
  try {
    const stdout = execFileSync("docker", args, {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout: String(stdout ?? ""), stderr: "" };
  } catch (err) {
    return {
      code: typeof err.status === "number" ? err.status : 1,
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? err.message ?? ""),
    };
  }
}

function gone(result) {
  return result.code === 0 || /No such network|not found|no such container/i.test(`${result.stderr}\n${result.stdout}`);
}

function ids(text) {
  return String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
}

function createArgs(name, extra) {
  return ["network", "create", "--label", OWNER_LABEL, ...extra, name];
}

export async function createOwnedNetwork(name, extra = ["--internal"]) {
  assertOwned(name);
  const result = await docker(createArgs(name, extra), { timeoutMs: 20_000 });
  if (result.code === 0) tracked.add(name);
  return result;
}

export function createOwnedNetworkSync(name, extra = ["--internal"]) {
  assertOwned(name);
  const result = runSync(createArgs(name, extra), 20_000);
  if (result.code === 0) tracked.add(name);
  return result;
}

async function dropEndpoints(name) {
  const ps = await docker(["ps", "-aq", "--filter", `network=${name}`], { timeoutMs: 15_000 });
  for (const id of ids(ps.stdout)) await docker(["rm", "-f", id], { timeoutMs: 20_000 });
}

function dropEndpointsSync(name) {
  const ps = runSync(["ps", "-aq", "--filter", `network=${name}`], 15_000);
  for (const id of ids(ps.stdout)) runSync(["rm", "-f", id], 20_000);
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Remove one harness network. Containers still attached (a `docker run` whose
// client was killed before --rm ran) are removed first, otherwise `network rm`
// fails and the subnet stays allocated. A missing network counts as removed.
export async function removeOwnedNetwork(name, { retries = 5 } = {}) {
  assertOwned(name);
  let last = { code: 1, stdout: "", stderr: "not attempted", timedOut: false };
  for (let attempt = 0; attempt < retries; attempt++) {
    await dropEndpoints(name);
    last = await docker(["network", "rm", name], { timeoutMs: 15_000 });
    if (gone(last)) {
      tracked.delete(name);
      return { ...last, code: 0 };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return last;
}

export function removeOwnedNetworkSync(name, { retries = 5 } = {}) {
  assertOwned(name);
  let last = { code: 1, stdout: "", stderr: "not attempted" };
  for (let attempt = 0; attempt < retries; attempt++) {
    dropEndpointsSync(name);
    last = runSync(["network", "rm", name], 15_000);
    if (gone(last)) {
      tracked.delete(name);
      return { ...last, code: 0 };
    }
    if (attempt + 1 < retries) pause(200);
  }
  return last;
}

function prefixAllowed(prefix) {
  return OWNED_NETWORK_PREFIXES.some((owned) => prefix.startsWith(owned));
}

async function pruneContainers() {
  const removed = [];
  for (const prefix of OWNED_CONTAINER_PREFIXES) {
    const ps = await docker(["ps", "-aq", "--filter", `name=${prefix}`], { timeoutMs: 15_000 });
    for (const id of ids(ps.stdout)) {
      const inspect = await docker(["inspect", "-f", "{{.Name}}", id], { timeoutMs: 10_000 });
      const name = inspect.stdout.trim().replace(/^\//, "");
      // Docker's name filter is a substring. Only an exact prefix match is ours.
      if (!name.startsWith(prefix)) continue;
      const rm = await docker(["rm", "-f", id], { timeoutMs: 20_000 });
      if (rm.code === 0) removed.push(name);
    }
  }
  return removed;
}

// Remove leftover harness networks. `prefixes` must be one of the owned
// prefixes or a longer name under one of them, so a caller cannot aim this at
// an unrelated network. `containers` also removes named harness containers
// (pre-test only; a live run of this file must not do that while other tests
// still hold their containers).
export async function pruneOwnedNetworks({ prefixes = OWNED_NETWORK_PREFIXES, containers = false } = {}) {
  for (const prefix of prefixes) {
    if (!prefixAllowed(prefix)) {
      throw new Error(`refusing to prune Docker networks by ${JSON.stringify(prefix)}: not a harness prefix`);
    }
  }
  const info = await docker(["info"], { timeoutMs: 8_000 });
  if (info.code !== 0) return { ok: false, reason: "docker is not available", removed: [], containers: [] };
  const dropped = containers ? await pruneContainers() : [];
  const listed = await docker(["network", "ls", "--format", "{{.Name}}"], { timeoutMs: 15_000 });
  const names = ids(listed.stdout).filter((name) => prefixes.some((prefix) => name.startsWith(prefix)) && isOwnedNetwork(name));
  const removed = [];
  for (const name of names) {
    const result = await removeOwnedNetwork(name);
    if (result.code === 0) removed.push(name);
  }
  return { ok: true, removed, containers: dropped };
}

// A killed test process never reaches its after() hook. Drop only the networks
// this process created. This does not scan the daemon for other names.
process.on("exit", () => {
  for (const name of [...tracked]) {
    try { removeOwnedNetworkSync(name, { retries: 1 }); } catch { /* exit cannot report this */ }
  }
});
