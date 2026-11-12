// The reach confinement boundary — the ENFORCEABLE version of the scope gate.
//
// WHY THIS EXISTS. lib/scope-proxy.mjs is a forward proxy: it enforces the grant
// allow-list for a client that ROUTES THROUGH IT. That is confinement for a
// cooperating client. But a live run's tools are attacker-authored: a tool can
// open a raw socket that skips the proxy entirely. A proxy the client can ignore
// is advisory, not a boundary. The reviewer's distinction: option (a) is "set a
// proxy env var and hope"; option (b) is "make bypass physically impossible".
//
// THIS IS OPTION (b). A live run's traffic runs inside a container on a Docker
// `--internal` network with NO default route. The ONLY other thing on that
// network is the scope-proxy sidecar. So the client's one and only path off its
// network is the proxy, and the proxy enforces the grant allow-list. An
// agent-authored raw socket to an arbitrary address has nowhere to go: the
// address is not on the client's network, and the client has no route to it.
// Even DNS for an off-network name fails. Bypass is not refused by policy; it is
// refused by the absence of a route. That is the boundary this module builds.
//
// Network topology (mirrors lib/proof-http.mjs's proven `--internal` + sidecar
// pattern, but the sidecar bridges to an EGRESS network so it can reach the
// granted hosts the run is allowed to touch):
//
//   netClient (--internal):   client  ---> scope-gate (the proxy's alias) --+
//                                                                            |
//   egress network:           proxy  <--- granted hosts / the internet  <---+
//
// The client joins netClient ONLY. The proxy is the one container on both
// networks, and the one bridge between them. Every byte the client sends toward a
// target is forced through the proxy, where the grant allow-list decides it.
//
// NOT YET THE DISPATCHER. This module builds and proves the boundary
// (spike/test/reach-confine.test.mjs). Wiring a full live run's tool execution to
// run INSIDE this client container is the remaining step (it touches the agent
// tool-execution path); until that lands, a live target is deliberately not
// dispatchable (lib/targets.mjs isRunnable). This is the built boundary that
// makes "live" honest: the refusal is pre-flight, the confinement is real.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const PROXY_IMAGE = "node:20-slim";
const DEFAULT_PROXY_PORT = 8080;
const GATE_ALIAS = "scope-gate"; // what the client names to reach the proxy
const READY_MARKER = "__SCOPE_READY__";

// Run one docker command. Returns { code, stdout, stderr, timedOut }. Never
// throws, so a caller branches on code like lib/proof-http.mjs does.
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

// Is docker usable right now? Tests skip honestly when it is not, rather than
// pass vacuously (the pattern in spike/test/sandbox-isolation.test.mjs).
export async function dockerReady() {
  const r = await docker(["info"], { timeoutMs: 8_000 });
  if (r.code !== 0) return { ok: false, reason: "docker is not available" };
  const img = await docker(["image", "inspect", PROXY_IMAGE], { timeoutMs: 8_000 });
  if (img.code !== 0) return { ok: false, reason: `${PROXY_IMAGE} image not present` };
  return { ok: true };
}

// A container's IP on a given network, or null. Used by the bypass test to aim a
// raw socket straight at a target's address — proving the client has no route to
// it even when it knows the address (the boundary is the network, not DNS).
export async function containerIp(name, network) {
  const r = await docker(["inspect", "-f", `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, name]);
  const ip = r.stdout.trim();
  return r.code === 0 && ip ? ip : null;
}

// The hardening every container gets: no capabilities, no new privileges, a pid
// cap, and a memory cap. Same posture as lib/proof-http.mjs.
const HARDEN = ["--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "128", "--memory", "256m"];

// Build the confinement boundary. Returns a handle with:
//   netClient     the --internal network the client joins (and nothing else can
//                 reach off of except through the proxy)
//   proxyName     the sidecar container name
//   gateUrl       the URL the client uses to reach the proxy (http://scope-gate:port)
//   runClient(cmd, opts)  run a one-shot container on netClient only
//   stop()        tear everything down
//
//   allowedHosts  the grant allow-list the proxy enforces
//   allowPrivate  let the proxy reach private space (Docker container IPs ARE
//                 private, so a test that forwards to a container origin sets this)
//   egressNetwork an existing network to bridge the proxy to for its reach. When
//                 omitted the proxy is bridged to the default `bridge` network, so
//                 it can reach the real internet (the production shape). A test
//                 passes its own origins' network so the reach stays controlled.
export async function confineReach({ allowedHosts = [], allowPrivate = false, egressNetwork, proxyPort = DEFAULT_PROXY_PORT } = {}) {
  const tag = randomBytes(4).toString("hex");
  const netClient = `touchstone-reach-client-${tag}`;
  const proxyName = `touchstone-reach-proxy-${tag}`;
  const createdNets = [];
  let entryDir = null;

  const cleanup = async () => {
    await docker(["rm", "-f", proxyName]);
    for (const n of createdNets) await docker(["network", "rm", n]);
    if (entryDir) { try { rmSync(entryDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  };
  const fail = async (msg) => { await cleanup(); throw new Error(`confineReach: ${msg}`); };

  // The client network: --internal, so a container on it has no default route.
  const nc = await docker(["network", "create", "--internal", netClient]);
  if (nc.code !== 0) return fail(`client network create failed: ${nc.stderr.trim().slice(0, 500)}`);
  createdNets.push(netClient);

  // The egress side the proxy reaches targets through. Default: the real
  // internet via docker's default bridge. A test supplies a controlled network.
  const egress = egressNetwork || "bridge";

  // The proxy's entry: import the scope proxy from the mounted lib and start it
  // bound on all interfaces at the fixed gateway port. The whole of spike/lib is
  // mounted read-only; scope-proxy.mjs + grant-store.mjs depend only on node
  // builtins, so no node_modules is needed in the container.
  const script =
    `const {startScopeProxy}=await import('/app/lib/scope-proxy.mjs');` +
    `const allow=(process.env.SCOPE_ALLOW||'').split(',').map(s=>s.trim()).filter(Boolean);` +
    `await startScopeProxy({allowedHosts:allow,host:'0.0.0.0',port:Number(process.env.SCOPE_PORT||${DEFAULT_PROXY_PORT}),allowPrivate:process.env.SCOPE_ALLOW_PRIVATE==='1'});` +
    `process.stderr.write('${READY_MARKER}\\n');`;

  // Start the proxy on the egress network, then connect it to the client network
  // as the gate alias. It is the only container on both; the only bridge.
  const proxyArgs = [
    "run", "-d", "--name", proxyName,
    "--network", egress,
    ...HARDEN,
    "-v", `${LIB_DIR}:/app/lib:ro`,
    "-e", `SCOPE_ALLOW=${allowedHosts.join(",")}`,
    "-e", `SCOPE_PORT=${proxyPort}`,
    "-e", `SCOPE_ALLOW_PRIVATE=${allowPrivate ? "1" : "0"}`,
    "--entrypoint", "node", PROXY_IMAGE,
    "--input-type=module", "-e", script,
  ];
  const proxyRun = await docker(proxyArgs);
  if (proxyRun.code !== 0) return fail(`proxy run failed: ${proxyRun.stderr.trim().slice(0, 500)}`);
  const conn = await docker(["network", "connect", "--alias", GATE_ALIAS, netClient, proxyName]);
  if (conn.code !== 0) return fail(`proxy connect to client network failed: ${conn.stderr.trim().slice(0, 500)}`);

  // Wait until the proxy has printed its ready marker to its own logs.
  const deadline = Date.now() + 15_000;
  for (;;) {
    const logs = await docker(["logs", proxyName], { timeoutMs: 8_000 });
    if (logs.stderr.includes(READY_MARKER) || logs.stdout.includes(READY_MARKER)) break;
    // A crash (e.g. the mount unreadable) shows up as the container having exited.
    const alive = await docker(["inspect", "-f", "{{.State.Running}}", proxyName]);
    if (alive.stdout.trim() !== "true") return fail(`proxy exited before ready: ${logs.stderr.trim().slice(0, 500)}`);
    if (Date.now() >= deadline) return fail("proxy did not become ready within 15s");
    await new Promise((r) => setTimeout(r, 200));
  }

  const gateUrl = `http://${GATE_ALIAS}:${proxyPort}`;
  return {
    netClient,
    proxyName,
    gateAlias: GATE_ALIAS,
    gateUrl,
    proxyPort,
    // Run a one-shot client container on the client network ONLY, as a node
    // command. Its sole route off-network is the proxy at gateUrl; every other
    // address is unreachable (no route), so a bypass attempt cannot leave.
    runClient: (nodeArgs, { timeoutMs = 20_000 } = {}) =>
      docker(["run", "--rm", "--network", netClient, ...HARDEN, "--entrypoint", "node", PROXY_IMAGE, ...nodeArgs], { timeoutMs }),
    stop: cleanup,
  };
}
