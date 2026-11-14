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
// THE TOOL-EXECUTION SEAM NOW EXISTS. The handle's `runConfined(cmd, opts)` runs
// a live run's TOOL inside this client container — the confined analog of
// lib/wrap.mjs runTool, proven by spike/test/reach-confine-exec.test.mjs (a real
// tool container reaches the granted host through the gate and has no route to a
// non-granted host or a raw IP). The boundary (reach-confine.test.mjs) and the
// primitive that runs tools inside it (runConfined) are both built and proven.
//
// WIRED. openReach() now stands this boundary up for a live run (`mode:
// "confine"`) and hands the run its env plus the handle, and the Web pack drives
// its request tool through it to a proof on the target. The cooperative proxy
// (lib/scope-proxy.mjs on its own) remains the default for tests and for any
// caller that runs on the host.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createLabNetwork, removeLabNetwork } from "./lab-net.mjs";

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const PROXY_IMAGE = "node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0";
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
export async function confineReach({ allowedHosts = [], allowPrivate = false, networkPolicy = "strict", egressNetwork, proxyPort = DEFAULT_PROXY_PORT } = {}) {
  const tag = randomBytes(4).toString("hex");
  const netClient = `touchstone-reach-client-${tag}`;
  const proxyName = `touchstone-reach-proxy-${tag}`;
  const createdNets = [];
  let entryDir = null;

  const cleanup = async () => {
    await docker(["rm", "-f", proxyName]);
    for (const n of createdNets) await removeLabNetwork(n, { docker });
    if (entryDir) { try { rmSync(entryDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  };
  const fail = async (msg) => { await cleanup(); throw new Error(`confineReach: ${msg}`); };

  // The client network: --internal, so a container on it has no default route.
  const nc = await createLabNetwork(netClient, ["--internal"], { docker });
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
    `await startScopeProxy({allowedHosts:allow,host:'0.0.0.0',port:Number(process.env.SCOPE_PORT||${DEFAULT_PROXY_PORT}),allowPrivate:process.env.SCOPE_ALLOW_PRIVATE==='1',networkPolicy:process.env.SCOPE_NETWORK_POLICY});` +
    `process.stderr.write('${READY_MARKER}\\n');`;

  // Start the proxy on the egress network, then connect it to the client network
  // as the gate alias. It is the only container on both; the only bridge.
  // Sealed releases are owner-readable only; capability-dropped root cannot read them.
  const proxyArgs = [
    "run", "-d", "--pull=never", "--name", proxyName,
    "--network", egress,
    ...HARDEN,
    "--user", `${process.getuid()}:${process.getgid()}`,
    "-v", `${LIB_DIR}:/app/lib:ro`,
    "-e", `SCOPE_ALLOW=${allowedHosts.join(",")}`,
    "-e", `SCOPE_NETWORK_POLICY=${networkPolicy}`,
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
      docker(["run", "--rm", "--pull=never", "--network", netClient, ...HARDEN, "--entrypoint", "node", PROXY_IMAGE, ...nodeArgs], { timeoutMs }),

    // Run a live run's TOOL inside the boundary — the dispatch primitive the
    // targets.mjs doc names as the last missing step. This is the confined
    // analog of lib/wrap.mjs runTool: one hardened container per call, a
    // workspace mounted at /work, output parsed by the caller. The difference
    // is the network. runTool uses `--network none` (an offline lab tool);
    // runConfined puts the tool on `netClient`, whose ONLY egress is the gate,
    // and pre-wires the gate under the standard proxy env vars (HTTP_PROXY /
    // HTTPS_PROXY, honored by curl, git, most HTTP clients) and Touchstone's own
    // TOUCHSTONE_SCOPE_PROXY. So a tool that reaches the granted host routes
    // through the grant automatically; a tool that opens a raw socket to
    // anything else has no route (same boundary runClient proves). The tool
    // never has to cooperate: the network, not a policy, is the boundary.
    //   cmd         the tool argv (for the image's entrypoint)
    //   image       the pinned tool image (default: the proxy image, for node tools)
    //   entrypoint  override the image entrypoint (e.g. "node" for a node image)
    //   ws          host dir mounted read-write at /work, or null
    //   user        "uid:gid" so output files stay the caller's (as runTool does)
    //   env         extra -e VAR=value pairs for the tool
    // Resolves (never rejects) with { code, stdout, stderr, timedOut }.
    runConfined: (cmd, { image = PROXY_IMAGE, entrypoint = null, ws = null, user = null, env = {}, timeoutMs = 60_000, maxBuffer = 16 * 1024 * 1024 } = {}) => {
      const gate = gateUrl;
      const args = [
        "run", "--rm", "--pull=never", "--network", netClient, ...HARDEN,
        ...(ws ? ["-v", `${ws}:/work`, "-w", "/work"] : []),
        ...(user ? ["--user", user] : []),
        "-e", `HTTP_PROXY=${gate}`, "-e", `http_proxy=${gate}`,
        "-e", `HTTPS_PROXY=${gate}`, "-e", `https_proxy=${gate}`,
        "-e", `TOUCHSTONE_SCOPE_PROXY=${gate}`, "-e", `TOUCHSTONE_SCOPE_GATE=${gate}`,
        ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
        ...(entrypoint ? ["--entrypoint", entrypoint] : []),
        image, ...cmd,
      ];
      return docker(args, { timeoutMs, maxBuffer });
    },
    stop: cleanup,
  };
}
