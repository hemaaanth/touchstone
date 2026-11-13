// The `fork` proof (F1 spike): prove a Keys/Safe finding against the REAL deployed
// lab target, not against a target the attacker's PoC deploys itself.
//
// Why this exists. The `forge` proof (lib/proof.mjs) runs the attacker's PoC with
// `forge test --offline` and NO fork, so the PoC's own setUp() redeploys the weak
// Safe and then attacks that fresh copy. The harness already owns the WIN condition
// (proofDelta/controlChanges read the replay trace, never the PoC source), but it
// does NOT own the TARGET: harm is proven against a Safe the attacker built. Every
// serious red-team harness (DVD, Immunefi, XBOW/Mako) instead has the harness own
// BOTH the target and the win condition, and lets the attacker supply only the
// attack. This module closes that gap for one lab.
//
// How. The keys runtime (packs/keys/runtime/observe.mjs) already deploys the weak
// Safes to a live Anvil and, with `--serve`, keeps it running. We start that lab on
// an `--internal` Docker network (alias "labchain", ANVIL_HOST=0.0.0.0) and read its
// chain-observation.json for the real deployed addresses. The attacker PoC then runs
// with `forge test --fork-url http://labchain:8545 --fork-block-number <pinned>`:
// it forks the real chain at a pinned block and attacks the real Safe BY ADDRESS. It
// deploys nothing. The oracle credits harm ONLY when the real lab target address
// loses ETH (or has its control changed) in the replay. A PoC that deploys its own
// victim and drains that gets NO credit, because the harm did not land on the
// harness-owned address. The target is anchored; the forgery vector is closed.
//
// Air-gap note. Forking needs a route to the chain being forked, so the PoC
// container is NOT fully air-gapped from the lab chain (it joins the internal
// network that reaches "labchain"). It still has no internet. For a real production
// target you would point --fork-url at an archive RPC for the real chain, pinned to
// a block, read-only; the same anchoring logic applies to the real contract address.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createLabNetwork, removeLabNetwork } from "./lab-net.mjs";
import { fileURLToPath } from "node:url";
import { netFlows } from "./proof.mjs";
import { formatAmount } from "../../app/src/lib/amount.mjs"; // the shared amount formatter: no cut harm numbers

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SPIKE = join(HERE, "..");
const KEYS_IMAGE = "touchstone-chain-tools:wave1";
const KEYS_LAB = join(SPIKE, "packs", "keys", "lab");
// The committed touchstone-chain-tools:wave1 image bakes an older observe.mjs that
// hardcodes `anvil --host 127.0.0.1`, so a forked PoC in a peer container cannot reach
// the lab chain. We mount the current source observe.mjs (which honors ANVIL_HOST) over
// the baked copy; its baked siblings (monitor.mjs, node_modules) are untouched.
// PRODUCTION NOTE: rebuild the image from packs/keys/runtime/Dockerfile (which should
// also add `apt-get install -y ca-certificates`) to drop both this mount and the CA copy.
const OBSERVE_SRC = join(SPIKE, "packs", "keys", "runtime", "observe.mjs");
const FORGE_STD = join(KEYS_LAB, "lib", "forge-std");
const LAB_ALIAS = "labchain";
const LAB_RPC = `http://${LAB_ALIAS}:8545`;

// forge's fork HTTP client (reqwest) refuses to initialize when it finds NO system
// trust store, failing with "No CA certificates were loaded from the system" — even
// for a plain-http fork endpoint it verifies nothing against. The chain-tools image
// (node:22-bookworm-slim) ships no CA bundle because the existing keys path only ever
// runs `forge build --offline`, never a fork. We ride a host CA bundle along in the
// already-mounted workspace and point SSL_CERT_FILE at it. PRODUCTION NOTE: the clean
// fix is `apt-get install -y ca-certificates` in packs/keys/runtime/Dockerfile; this
// copy keeps the spike self-contained without rebuilding the committed image.
const HOST_CA = ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/cert.pem"].find((p) => existsSync(p)) || null;
const CA_IN_WS = "ca-bundle.crt";

function docker(args, { timeoutMs = 30_000, maxBuffer = 16 * 1024 * 1024 } = {}) {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Start the keys lab on an internal network and keep its Anvil alive. Returns a
// handle with the real deployed addresses the oracle will anchor to.
export async function startForkLab({ image = KEYS_IMAGE, mode = "keys", readyTimeoutMs = 240_000 } = {}) {
  const tag = randomBytes(4).toString("hex");
  const net = `touchstone-fork-${tag}`;
  const labName = `touchstone-forklab-${tag}`;
  const labWs = mkdtempSync(join(tmpdir(), `forklab-${tag}-`));
  // Seed the lab's Foundry sources so observe.mjs's `forge build` can compile the
  // KeysLab/OpenModule artifacts it deploys (same inputs the real keys prepass uses:
  // src + lib + foundry.toml; out/cache/oracle are excluded and rebuilt in-container).
  cpSync(join(KEYS_LAB, "src"), join(labWs, "src"), { recursive: true });
  cpSync(join(KEYS_LAB, "lib"), join(labWs, "lib"), { recursive: true });
  cpSync(join(KEYS_LAB, "foundry.toml"), join(labWs, "foundry.toml"));
  // Container runs as the host uid so it can write the observation into the mount.
  const netRun = await createLabNetwork(net, ["--internal"], { docker });
  if (netRun.code !== 0) throw new Error(`startForkLab: network create failed: ${netRun.stderr.trim().slice(0, 300)}`);
  const handle = { net, labName, labWs, image, mode, obs: null, block: null, targets: [] };
  try {
    const labArgs = [
      "run", "-d", "--init", "--name", labName,
      "--network", net, "--network-alias", LAB_ALIAS,
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--pids-limit", "512", "--memory", "2g",
      // Run as the host uid so the lab can write chain-observation.json into the
      // bind-mounted workspace (owned by the host user); /opt/touchstone is world-readable.
      "--user", `${process.getuid()}:${process.getgid()}`,
      "-e", "ANVIL_HOST=0.0.0.0", "-e", "HOME=/tmp",
      "-v", `${labWs}:/work`, "-w", "/work",
      // Override the baked observe.mjs with the current source (honors ANVIL_HOST).
      "-v", `${OBSERVE_SRC}:/opt/touchstone/observe.mjs:ro`,
      "--entrypoint", "node",
      image, "/opt/touchstone/observe.mjs", mode, "--serve",
    ];
    const started = await docker(labArgs, { timeoutMs: 60_000 });
    if (started.code !== 0) throw new Error(`startForkLab: lab run failed: ${started.stderr.trim().slice(0, 300)}`);
    // observe.mjs writes chain-observation.ready once Anvil is up and the lab is deployed.
    const readyFile = join(labWs, "chain-observation.ready");
    const obsFile = join(labWs, "chain-observation.json");
    const deadline = Date.now() + readyTimeoutMs;
    while (!existsSync(readyFile)) {
      if (Date.now() > deadline) {
        const logs = await docker(["logs", labName], { timeoutMs: 10_000 });
        throw new Error(`startForkLab: lab not ready in ${readyTimeoutMs}ms: ${logs.stderr.trim().slice(-300)}`);
      }
      await sleep(500);
    }
    const obs = JSON.parse(readFileSync(obsFile, "utf8"));
    handle.obs = obs;
    handle.block = obs.block;
    // The addresses the oracle is allowed to credit harm against: the deployed Safes.
    handle.targets = (obs.safes ?? []).map((s) => String(s.address).toLowerCase());
    return handle;
  } catch (e) {
    await stopForkLab(handle);
    throw e;
  }
}

export async function stopForkLab(handle) {
  if (!handle) return;
  if (handle.labName) await docker(["rm", "-f", handle.labName], { timeoutMs: 20_000 });
  if (handle.net) await removeLabNetwork(handle.net, { docker, timeoutMs: 20_000 });
  if (handle.labWs) rmSync(handle.labWs, { recursive: true, force: true });
}

// Seed a minimal Foundry workspace that can compile a PoC against vendored forge-std.
function seedPocWorkspace(source) {
  const ws = mkdtempSync(join(tmpdir(), "forkpoc-"));
  mkdirSync(join(ws, "lib"), { recursive: true });
  mkdirSync(join(ws, "test"), { recursive: true });
  mkdirSync(join(ws, "src"), { recursive: true });
  cpSync(FORGE_STD, join(ws, "lib", "forge-std"), { recursive: true });
  // copyFileSync (not cpSync) so a symlinked host CA path (e.g. ca-certificates.crt
  // -> /etc/ca-certificates/extracted/...) is dereferenced to its real bytes. A
  // copied symlink would dangle inside the container, where the target does not
  // exist, and forge's fork client would fail with "No CA certificates were loaded".
  if (HOST_CA) copyFileSync(HOST_CA, join(ws, CA_IN_WS));
  writeFileSync(join(ws, "foundry.toml"), `[profile.default]\nsrc = "src"\ntest = "test"\nout = "out"\nlibs = ["lib"]\n`);
  writeFileSync(join(ws, "test", "AgentPoc.t.sol"), source);
  return ws;
}

// Run the attacker PoC as a forge test FORKED against the live lab chain, pinned to
// the lab's deploy block. The PoC container joins only the lab's internal network, so
// it can reach "labchain" but has no internet. Returns forge's JSON + raw output.
export async function runForkPoc(handle, source, { contract, timeoutMs = 240_000 } = {}) {
  const ws = seedPocWorkspace(source);
  try {
    const cmd = [
      "forge", "test", "--offline", "--use", "/usr/local/bin/solc",
      "--fork-url", LAB_RPC, "--fork-block-number", String(handle.block),
      ...(contract ? ["--match-contract", contract] : []),
      "-vvvv", "--json",
    ];
    const args = [
      "run", "--rm", "--init", "--network", handle.net,
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--pids-limit", "512", "--memory", "2g",
      "--user", `${process.getuid()}:${process.getgid()}`,
      "-e", "HOME=/tmp",
      ...(HOST_CA ? ["-e", `SSL_CERT_FILE=/work/${CA_IN_WS}`] : []),
      "-v", `${ws}:/work`, "-w", "/work",
      "--entrypoint", "forge",
      handle.image, ...cmd.slice(1),
    ];
    const r = await docker(args, { timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    let parsed = null;
    try { parsed = JSON.parse(r.stdout.trim()); } catch { parsed = null; }
    return { parsed, stdout: r.stdout, stderr: r.stderr, code: r.code, timedOut: r.timedOut };
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

// Pull the chosen test result's call traces out of forge's JSON.
function tracesFor(parsed, contract) {
  for (const [suite, sd] of Object.entries(parsed || {})) {
    if (contract && suite.split(":").pop() !== contract) continue;
    const results = sd?.test_results ?? {};
    const entries = Object.entries(results);
    const chosen = entries.find(([, r]) => r?.status === "Success") ?? entries[0];
    if (chosen) return { test: chosen[0], result: chosen[1] };
  }
  return null;
}

// The ANCHORED win condition. Harm counts ONLY when a harness-owned lab target
// (handle.targets) net-loses ETH to some other address in the real replay. A PoC
// that drains a victim it deployed itself is NOT a lab target, so it fails here —
// this is exactly what the fresh-deploy `forge` proof could not distinguish.
export function forkDrainOracle(handle, parsed, contract) {
  const hit = tracesFor(parsed, contract);
  if (!hit) return { pass: false, detail: "no parsable test result for the named contract" };
  if (hit.result.status !== "Success") return { pass: false, detail: `the PoC test did not pass (${hit.result.reason || hit.result.status})` };
  const { net } = netFlows(hit.result.traces);
  const targets = new Set(handle.targets.map((t) => t.toLowerCase()));
  let victim = null;
  for (const [addr, wei] of net.entries()) {
    if (targets.has(addr) && wei < 0n) { victim = { addr, wei }; break; }
  }
  if (!victim) {
    const moved = [...net.entries()].filter(([, w]) => w !== 0n).map(([a, w]) => `${a}:${w}`);
    return { pass: false, detail: `no lab target lost ETH in the replay. Net ETH moves: ${moved.join(", ") || "none"}. Lab targets: ${[...targets].join(", ")}` };
  }
  const gainers = [...net.entries()].filter(([a, w]) => w > 0n && !targets.has(a)).map(([a]) => a);
  if (gainers.length === 0) return { pass: false, detail: "a lab target lost ETH but no non-target address gained it" };
  const eth = (w) => formatAmount((w < 0n ? -w : w).toString()).text;
  return { pass: true, detail: `lab target ${victim.addr} lost ${eth(victim.wei)} to ${gainers.join(", ")} in the forked replay`, victim: victim.addr, amountWei: (-victim.wei).toString() };
}

// Full one-shot fork proof: start the lab, run the PoC forked against it, anchor the
// oracle to the real deployed targets, tear down.
export async function forkProof(startOpts, source, { contract, timeoutMs = 240_000 } = {}) {
  const handle = await startForkLab(startOpts || {});
  try {
    const run = await runForkPoc(handle, source, { contract, timeoutMs });
    const oracle = run.parsed ? forkDrainOracle(handle, run.parsed, contract) : { pass: false, detail: `forge produced no JSON. stderr: ${run.stderr.trim().slice(-300)}` };
    return { status: oracle.pass ? "pass" : "fail", oracle, targets: handle.targets, block: handle.block, run: { code: run.code, timedOut: run.timedOut, stderr: run.stderr.slice(-500) } };
  } finally {
    await stopForkLab(handle);
  }
}
