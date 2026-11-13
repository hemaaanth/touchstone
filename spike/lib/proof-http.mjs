// The `http` proof: a practice web/API service runs in Docker on a private,
// `--internal` network with no route to the internet. A finding's request
// script runs in a second, throwaway container that can reach the lab ONLY
// through a recording reverse proxy. An independent oracle reads the proxy's
// out-of-band transcript -- never the script's own console output, return
// values, or claims -- to decide whether the harm is real. Any pack whose
// `proof` is `"http"` (Web and sign-in, APIs, and later Nodes/RPC, AI/MCP,
// Infra/cloud) shares this file. See packs/README.md "Proof kinds".
//
// Why a proxy, not an in-script transcript. The finding's script is attacker
// code: it is concatenated into the same process we run, so anything that
// process can see, it can forge -- it could push fabricated entries onto an
// in-memory transcript, monkeypatch `fetch`, or print the transcript marker
// itself. So the transcript must be recorded at a trust boundary the script's
// process cannot write to. The proxy is a separate container on a network
// segment the script cannot reach directly; it records every real exchange to
// ITS OWN stdout, which the harness reads with `docker logs`. The script can
// still LIE in its console output, but the oracle never reads that -- it reads
// only what actually crossed the wire. This mirrors the "never trust the
// agent's own test" rule lib/proof.mjs enforces for Foundry, and the
// out-of-band ground-truth capture used by production red-team harnesses
// (XBOW/Mako): "either the effect shows up in the real traffic, or it does not."
//
// Network topology (two `--internal` networks, no internet on either):
//   netInner:  lab (alias "origin")  <--+
//                                        |  proxy forwards + records
//   netOuter:  proxy (alias "lab")  <----+----  script container
// The script joins netOuter ONLY, so it can reach "lab" (the proxy) but has no
// route to "origin" (the lab). The proxy is the one and only bridge, so every
// request the script makes is forced through the recorder.
//
// Two lifetimes:
//   - A pack's prepass starts ONE lab (+proxy) and keeps it running for the
//     whole agent session (the agent explores it live through a pack tool).
//     That handle is persisted to a file under the run workspace (see
//     writeLabHandle/readLabHandle/teardownPersistedLab) because prepass and
//     the agent session run in different processes (the agent is a spawned
//     child); only a value on disk survives that boundary reliably.
//   - prove() replays each finding against a FRESH lab, independent of
//     whatever the live session mutated. httpProof() does this in one call:
//     start, run the script, read the proxy transcript, stop, ask the oracle.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createLabNetwork, removeLabNetwork } from "./lab-net.mjs";

function docker(args, { timeoutMs = 30_000, maxBuffer = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolveDocker) => {
    execFile("docker", args, { timeout: timeoutMs, maxBuffer }, (err, stdout, stderr) => {
      resolveDocker({
        code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        timedOut: Boolean(err?.killed),
      });
    });
  });
}

// Fail loudly when a lab image is not built. Without this, `docker run` tries to
// pull a local-only tag and the error reads "pull access denied". The packs have
// no source to fall back on, so a missing image means the module cannot run.
export async function requireImage(image, buildArg) {
  const r = await docker(["image", "inspect", image]);
  if (r.code !== 0) {
    throw new Error(`lab image ${image} is not built. This pack has no source to fall back on, so it cannot run. Build it with: npm run build:labs -- ${buildArg}  (that is: bash scripts/build-labs.sh ${buildArg})`);
  }
}

const PROXY_PORT = 8080;          // the port the proxy listens on (what scripts call)
const ORIGIN_ALIAS = "origin";    // the lab's alias on the inner network
export const REC_MARKER = "__TOUCHSTONE_REC__";
const PROXY_IMAGE = "node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0";

// The recording reverse proxy, run in its own container with built-in `http`
// only (no dependencies). It forwards every request to the real lab
// (ORIGIN_BASE_URL) and writes one REC_MARKER-prefixed JSON line per exchange
// to its OWN stdout, in the transcript shape the oracle reads.
//
// Readiness probes carry `x-touchstone-probe: <PROBE_SECRET>` and are the ONLY
// requests skipped from the recording. The secret is a per-lab random value the
// proxy learns from its own environment; the attacker's script container never
// receives it, so a script cannot set the header to make a real (state-changing)
// request go unrecorded -- every request a script makes IS recorded, no matter
// what headers it sets. The header is also stripped before forwarding, so the
// lab never sees it. (Without this, a script could sign in a second account or
// mutate state under a self-declared "probe" tag and forge a clean-looking
// transcript -- the exact hole this proxy exists to close.)
//
// Hop-by-hop headers are stripped on the way out (fetch sets its own), and the
// response's content-encoding/length are stripped on the way back because
// undici has already decoded the body we re-send.
export const RECORDER = `
import http from "node:http";
const ORIGIN = process.env.ORIGIN_BASE_URL;
const PROBE_SECRET = process.env.PROBE_SECRET || "";
const HOP = new Set(["host","connection","content-length","transfer-encoding","keep-alive","upgrade","te","proxy-connection","proxy-authorization"]);
const strip = (h) => { const o = {}; for (const [k, v] of Object.entries(h || {})) if (!HOP.has(String(k).toLowerCase())) o[k] = v; return o; };
const parse = (s) => { try { return JSON.parse(s); } catch { return s; } };
http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const reqBuf = Buffer.concat(chunks);
    // Only a request carrying the per-lab secret is a readiness probe. A missing
    // secret ("") never matches, so every script request is recorded.
    const probe = PROBE_SECRET !== "" && String(req.headers["x-touchstone-probe"] || "") === PROBE_SECRET;
    const method = req.method;
    const noBody = method === "GET" || method === "HEAD";
    let resText = "", resHeaders = {}, status = 502;
    try {
      const fwd = strip(req.headers);
      delete fwd["x-touchstone-probe"];   // never leak the probe tag to the lab
      const up = await fetch(ORIGIN + req.url, { method, headers: fwd, body: noBody ? undefined : reqBuf, redirect: "manual" });
      resText = await up.text();
      resHeaders = Object.fromEntries(up.headers.entries());
      status = up.status;
    } catch (e) {
      resText = "proxy upstream error: " + String((e && e.message) || e);
    }
    if (!probe) {
      const entry = {
        // path is the RAW request path the origin received, minus ?query and
        // #fragment. It is not normalised (no "//" or "/../" collapsing), so a
        // matcher sees what the origin saw. The full URL stays in url.
        method, path: req.url.split(/[?#]/)[0], url: ORIGIN + req.url,
        reqHeaders: req.headers, reqBody: reqBuf.length ? parse(reqBuf.toString("utf8")) : null,
        status, resHeaders, resBody: parse(resText),
      };
      process.stdout.write(${JSON.stringify(REC_MARKER)} + JSON.stringify(entry) + "\\n");
    }
    const out = strip(resHeaders);
    delete out["content-encoding"];
    res.writeHead(status, out);
    res.end(resText);
  });
}).listen(${PROXY_PORT}, "0.0.0.0");
`;

// Start a lab behind a recording proxy (see the topology diagram at the top).
// The lab runs on an internal network as ORIGIN_ALIAS; the proxy bridges that
// to a second internal network where it answers as `alias` (default "lab" --
// match this in the pack's openapi.yaml `servers` url and BRIEF.md). There is
// no host port publish and no internet route on either network. A live agent
// process, same as a finding's replay, always reaches the lab from a throwaway
// container on the outer network via runRequestScript(), which forces every
// request through the proxy. Returns a handle; the caller must eventually call
// stopLab(handle).
export async function startLab({
  image,
  alias = "lab",
  containerPort = 8080,
  env = {},
  readyPath = "/healthz",
  readyTimeoutMs = 20_000,
  onStart,
}) {
  const tag = randomBytes(4).toString("hex");
  // Per-lab secret that marks a readiness probe. Known only to the proxy (via
  // its env) and to waitReady; never given to a script container, so a script
  // cannot forge the probe tag to hide a request from the recorder.
  const probeSecret = randomBytes(16).toString("hex");
  const netInner = `touchstone-inner-${tag}`;
  const netOuter = `touchstone-outer-${tag}`;
  const labName = `touchstone-lab-${tag}`;
  const proxyName = `touchstone-proxy-${tag}`;
  // Persist the names before Docker creates anything. A restarted prepass can
  // remove even a half-started lab or network by those exact names.
  onStart?.({ netInner, netOuter, labName, proxyName });
  let proxyDir = null;
  const cleanup = async () => stopLab({ proxyName, labName, netInner, netOuter, proxyDir });
  const fail = async (msg) => { await cleanup(); throw new Error(`startLab: ${msg}`); };

  const ni = await createLabNetwork(netInner, ["--internal"], { docker });
  if (ni.code !== 0) return fail(`inner network create failed: ${ni.stderr.trim().slice(0, 500)}`);
  const no = await createLabNetwork(netOuter, ["--internal"], { docker });
  if (no.code !== 0) return fail(`outer network create failed: ${no.stderr.trim().slice(0, 500)}`);

  // Lab on the inner network ONLY. The script never joins this network, so it
  // cannot reach the lab except through the proxy.
  const labArgs = [
    "run", "-d", "--rm", "--name", labName,
    "--network", netInner, "--network-alias", ORIGIN_ALIAS,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "256", "--memory", "512m",
  ];
  for (const [k, v] of Object.entries(env)) labArgs.push("-e", `${k}=${v}`);
  labArgs.push(image);
  const labRun = await docker(labArgs, { timeoutMs: 30_000 });
  if (labRun.code !== 0) return fail(`lab run failed: ${labRun.stderr.trim().slice(0, 500)}`);

  // Proxy: start on the inner network (so it can reach the lab), then also
  // connect it to the outer network as `alias` (what the script calls). It is
  // the only container on both networks, and the only bridge between them.
  proxyDir = mkdtempSync(join(tmpdir(), "touchstone-proxy-"));
  onStart?.({ netInner, netOuter, labName, proxyName, proxyDir });
  writeFileSync(join(proxyDir, "recorder.mjs"), RECORDER);
  // mkdtemp makes the dir 0700. The proxy runs node:20-slim as root, and
  // --cap-drop ALL removes CAP_DAC_OVERRIDE, so that root cannot read a dir
  // owned by the host user unless it is world-readable. (The script container
  // avoids this only because the lab image happens to run as uid 1000.)
  chmodSync(proxyDir, 0o755);
  const proxyArgs = [
    "run", "-d", "--name", proxyName,
    "--network", netInner,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "128", "--memory", "256m",
    "-v", `${proxyDir}:/app/_proxy:ro`,
    "-e", `ORIGIN_BASE_URL=http://${ORIGIN_ALIAS}:${containerPort}`,
    "-e", `PROBE_SECRET=${probeSecret}`,
    "--entrypoint", "node", PROXY_IMAGE, "/app/_proxy/recorder.mjs",
  ];
  const proxyRun = await docker(proxyArgs, { timeoutMs: 30_000 });
  if (proxyRun.code !== 0) return fail(`proxy run failed: ${proxyRun.stderr.trim().slice(0, 500)}`);
  const conn = await docker(["network", "connect", "--alias", alias, netOuter, proxyName]);
  if (conn.code !== 0) return fail(`proxy network connect failed: ${conn.stderr.trim().slice(0, 500)}`);

  const handle = {
    netInner, netOuter, labName, proxyName, proxyDir,
    image, containerPort, alias, proxyPort: PROXY_PORT,
    net: netOuter,                                 // the network scripts join
    netBaseUrl: `http://${alias}:${PROXY_PORT}`,   // scripts point here (the proxy)
  };
  try {
    await waitReady(handle, { readyPath, timeoutMs: readyTimeoutMs, probeSecret });
  } catch (err) {
    await stopLab(handle);
    throw err;
  }
  return handle;
}

// Ready when a probe (tagged so the proxy does not record it) reaches the lab
// THROUGH the proxy from the outer network -- this confirms the whole chain:
// outer DNS, the proxy process, the bridge to the inner network, and the lab.
async function waitReady(handle, { readyPath, timeoutMs, probeSecret, intervalMs = 300 }) {
  const url = `${handle.netBaseUrl}${readyPath}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await docker([
      "run", "--rm", "--network", handle.net,
      PROXY_IMAGE, "node", "-e",
      `fetch(${JSON.stringify(url)},{headers:{"x-touchstone-probe":${JSON.stringify(probeSecret)}}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`,
    ], { timeoutMs: 8_000 });
    if (r.code === 0) return;
    if (Date.now() >= deadline) throw new Error(`startLab: ${handle.alias} did not answer ${readyPath} within ${timeoutMs}ms`);
    await new Promise((r2) => setTimeout(r2, intervalMs));
  }
}

export async function stopLab(handle) {
  if (!handle) return;
  if (handle.proxyName) await docker(["rm", "-f", handle.proxyName], { timeoutMs: 15_000 });
  if (handle.labName) await docker(["rm", "-f", handle.labName], { timeoutMs: 15_000 });
  // A killed prepass can leave a scanner's `docker run --rm` attached to its
  // private network. Remove only containers on this lab's unique network.
  if (handle.netOuter) {
    const attached = await docker(["network", "inspect", "--format", "{{json .Containers}}", handle.netOuter]);
    if (attached.code === 0) {
      try {
        for (const id of Object.keys(JSON.parse(attached.stdout) ?? {})) await docker(["rm", "-f", id], { timeoutMs: 15_000 });
      } catch { /* no containers reported */ }
    }
    await removeLabNetwork(handle.netOuter, { docker });
  }
  if (handle.netInner) await removeLabNetwork(handle.netInner, { docker });
  if (handle.proxyDir) { try { rmSync(handle.proxyDir, { recursive: true, force: true }); } catch {} }
}

// --- Read the proxy's out-of-band transcript. `docker logs` returns the
// proxy's full stdout history; we parse every REC_MARKER line into an entry.
// The script's process cannot write to the proxy's stdout, so these records
// are authoritative. (Request order: the proxy writes a record the moment an
// exchange completes, before it answers the script, so by the time the script
// container exits every record is already flushed -- no race.)
async function readRecords(handle) {
  const r = await docker(["logs", handle.proxyName], { timeoutMs: 10_000, maxBuffer: 64 * 1024 * 1024 });
  // Fail closed: if the log read errored (proxy gone, or the buffer overflowed in
  // a very long live session), do NOT return a partial/empty list -- that would
  // silently shift the baseCount slice or read as "no harm". Surface it instead.
  if (r.code !== 0) {
    throw new Error(`readRecords: docker logs ${handle.proxyName} failed (code ${r.code}): ${r.stderr.trim().slice(0, 300)}`);
  }
  const out = [];
  for (const line of r.stdout.split("\n")) {
    const idx = line.indexOf(REC_MARKER);
    if (idx === -1) continue;
    try { out.push(JSON.parse(line.slice(idx + REC_MARKER.length))); } catch {}
  }
  return out;
}

// --- Persist a live lab handle across the prepass -> agent session -> prove
// boundary (the agent session is a separate spawned process; prepass and
// prove run in the same process as each other, but only a value on disk is
// guaranteed to survive the gap between them). Keyed by workspace, not by any
// in-memory map, so it is correct even if the host process serves several
// runs at once (the app server can).
const HANDLE_FILE = ".touchstone-http-lab.json";
const SCAN_HANDLE_FILE = ".touchstone-http-scan.json";

export function writeScanHandle(ws, handle) {
  writeFileSync(join(ws, SCAN_HANDLE_FILE), JSON.stringify(handle), { mode: 0o600 });
}

export async function teardownPersistedScan(ws) {
  let handle;
  try { handle = JSON.parse(readFileSync(join(ws, SCAN_HANDLE_FILE), "utf8")); } catch { return; }
  try { await stopLab(handle); }
  finally { rmSync(join(ws, SCAN_HANDLE_FILE), { force: true }); }
}


export function writeLabHandle(ws, handle) {
  writeFileSync(join(ws, HANDLE_FILE), JSON.stringify(handle));
}

export function readLabHandle(ws) {
  try {
    return JSON.parse(readFileSync(join(ws, HANDLE_FILE), "utf8"));
  } catch {
    return null;
  }
}

// Best-effort: tear down whatever lab prepass left running for this
// workspace, then forget it. Safe to call even if nothing was ever started,
// or the workspace is already gone.
export async function teardownPersistedLab(ws) {
  await teardownPersistedScan(ws);
  const handle = readLabHandle(ws);
  if (!handle) return;
  try {
    await stopLab(handle);
  } finally {
    try { rmSync(join(ws, HANDLE_FILE), { force: true }); } catch {}
  }
}

// --- Request scripts.
//
// A finding's "request script" is a body of JS that calls injected helpers --
// it does not get the network any other way:
//   await request(method, path, { headers, body })
//     Makes one real HTTP call to the lab (through the proxy) and returns
//     { method, path, status, reqHeaders, reqBody, resHeaders, resBody } so the
//     script can branch on the response. This return value is for the script's
//     own logic only -- the oracle never sees it. What the oracle sees is the
//     proxy's independent recording of the same exchange.
//   signPersonal(privateKeyHex, message) -> signature hex
//     EIP-191 personal_sign, via ethers (already a dependency of the lab
//     image this runs in). Needed to sign SIWE messages as a test wallet.
//   buildSiwe(fields) -> message text
//     The canonical EIP-4361 text for { domain, address, uri, version,
//     chainId, nonce, issuedAt }, via the `siwe` package.
const HARNESS = `
import { Wallet } from "ethers";
import { SiweMessage } from "siwe";
const BASE_URL = process.env.TOUCHSTONE_BASE_URL;
globalThis.request = async function request(method, path, opts = {}) {
  const headers = Object.assign({ "content-type": "application/json" }, opts.headers || {});
  const hasBody = opts.body !== undefined;
  const body = hasBody ? (typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body)) : undefined;
  const res = await fetch(BASE_URL + path, { method, headers, body });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return {
    method, path, url: BASE_URL + path, reqHeaders: headers, reqBody: hasBody ? opts.body : null,
    status: res.status, resHeaders: Object.fromEntries(res.headers.entries()), resBody: json ?? text,
  };
};
globalThis.signPersonal = async function signPersonal(privateKey, message) {
  return new Wallet(privateKey).signMessage(message);
};
globalThis.buildSiwe = function buildSiwe(fields) {
  return new SiweMessage(fields).prepareMessage();
};
`;

// Run a finding's request script in a fresh, throwaway container on
// `handle.net` (the outer network), so it reaches the lab only as
// `handle.alias` -- the proxy. Mounted under /app/_run inside the SAME image
// the lab runs (handle.image), so the script's `import ... from "ethers"|"siwe"`
// resolves against that image's already-installed node_modules without needing
// its own network access. Returns the proxy's independently-recorded transcript
// for THIS run (the records that appeared while the script ran), never the
// script's own stdout as truth (that is returned too, but only for a human to
// read).
// Serialize runs against the SAME persisted lab. The baseCount/slice below is
// only correct if no other run writes records to this proxy's log between the
// two readRecords() calls. prove() uses a fresh lab per finding, so those never
// contend; this guards the live tool against overlapping run_request_script
// calls in one session. (Per-process by design: the only writer to a persisted
// lab is its own agent-session process; prove's fresh labs have distinct keys.)
const runQueues = new Map();  // proxyName -> tail promise
function serialize(key, fn) {
  const prev = runQueues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);  // run after prev settles, success or not
  runQueues.set(key, next.then(() => {}, () => {}));
  return next;
}

export async function runRequestScript(handle, script, { timeoutMs = 20_000 } = {}) {
  return serialize(handle.proxyName, async () => {
    const dir = mkdtempSync(join(tmpdir(), "touchstone-script-"));
    try {
      const wrapped = `${HARNESS}\n(async () => {\n${script}\n})().catch((e) => { console.error(String(e && e.stack || e)); process.exitCode = 1; });\n`;
      writeFileSync(join(dir, "run.mjs"), wrapped);
      // The proxy's log accumulates across every run against a persisted lab, so
      // take only the records that appear after this run starts.
      const baseCount = (await readRecords(handle)).length;
      const args = [
        // --init runs tini as PID 1. The attacker script runs as a child of tini,
        // not as PID 1, so a run that never exits (e.g. a dangling setInterval) is
        // killed when docker run's timeout sends SIGTERM: PID 1 (node) would ignore
        // SIGTERM, but tini forwards it and reaps the child. Without this a hung
        // script would stall every later run on this lab via the serialize() queue.
        "run", "--rm", "--init", "--network", handle.net,
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--pids-limit", "128", "--memory", "256m",
        "-v", `${dir}:/app/_run:ro`,
        "-e", `TOUCHSTONE_BASE_URL=${handle.netBaseUrl}`,
        "-w", "/app",
        "--entrypoint", "node",
        handle.image, "/app/_run/run.mjs",
      ];
      const r = await docker(args, { timeoutMs });
      const transcript = (await readRecords(handle)).slice(baseCount);
      return { transcript, stdout: r.stdout.trim(), stderr: r.stderr.trim(), code: r.code, timedOut: r.timedOut };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// One transcript entry, in the shape spike/lib/proof-view.mjs's proofView()
// reads: { label, request: { method, url, headers, body },
// response: { status, headers, body } }. Secret-looking header NAMES
// (authorization, cookie, token, ...) are redacted there, by proofView's own
// `cell()`, from the name alone -- not here, and not for body fields, so a
// finding whose harm IS a body-level secret (a leaked signing key, an API
// key) shows that secret in full, because that is the evidence.
function exchange(e, i) {
  return {
    label: `${i + 1}. ${e.method} ${e.url ? e.url.replace(/^https?:\/\/[^/]+/, "") : e.path}`,
    request: { method: e.method, url: e.url ?? e.path, headers: e.reqHeaders, body: e.reqBody },
    response: { status: e.status, headers: e.resHeaders, body: e.resBody },
  };
}

// The full http proof for one finding: a fresh lab (+proxy), independent of the
// live session's mutated state, the script replayed against it, the lab torn
// down, then the named oracle's own read of the proxy transcript -- never the
// script's exit code or console output -- decides pass/fail.
//   labOpts  passed to startLab(); labOpts.image is required
//   script   the finding's request script source (see HARNESS above)
//   oracle   { name: string, check: (transcript, run) => { pass, detail } }
// Returns the `proof` shape spike/lib/proof-view.mjs expects:
//   { kind: "http", status: "pass" | "fail", detail,
//     oracle: { name, detail, passed }, log: [...] }
// Throws only on infrastructure failure (the lab would not start); a script
// error or a failed oracle check is a normal "fail", not a throw.
export async function httpProof(labOpts, script, oracle) {
  const handle = await startLab(labOpts);
  try {
    const run = await runRequestScript(handle, script, { timeoutMs: labOpts.scriptTimeoutMs ?? 20_000 });
    let verdict;
    try {
      verdict = oracle.check(run.transcript, run);
    } catch (err) {
      verdict = { pass: false, detail: `oracle threw: ${String(err?.message || err).slice(0, 300)}` };
    }
    const detail = verdict.detail ?? "";
    return {
      kind: "http",
      status: verdict.pass ? "pass" : "fail",
      detail,
      oracle: { name: oracle.name ?? "", detail, passed: Boolean(verdict.pass) },
      log: run.transcript.map(exchange),
    };
  } finally {
    await stopLab(handle);
  }
}
