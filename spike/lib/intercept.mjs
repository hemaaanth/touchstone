// The capture seam — a client runs through a recording MITM proxy.
//
// WHY THIS EXISTS. Every other request path in the harness is one-shot: an
// anonymous scanner, or a script the agent writes. Neither sees what a real
// client does. A dapp client signs in with a wallet, holds a session, speaks
// JSON-RPC over HTTP and WebSocket, and signs payloads. Most signed-in bugs are
// only reachable through that client. This file puts a client behind mitmproxy
// and records what it actually sent.
//
// NOT A GATE. mitmproxy is a recorder, not a boundary. The run's existing
// recorder proxy (lib/proof-http.mjs) stays in front of the lab, so:
//   - a captured request is written to the SAME oracle transcript shape a
//     script produces, and the pack's oracles read it unchanged;
//   - the HAR is an extra artifact for a human and for the Client pack's HAR
//     reader (research/packs/client.md);
//   - a client that ignores HTTP_PROXY still reaches the lab, and is still
//     recorded by the run recorder. It just has no HAR.
//
// TOPOLOGY (the same two internal networks startLab already made):
//   client container --proxy--> mitmdump (alias "mitm")
//                                   |  forwards to RECORDER_BASE_URL
//                                   v
//                          run recorder proxy (records the transcript)
//                                   v
//                                the lab
// The client joins the OUTER network only, so it has no route to the lab. The
// mitm container is the one bridge, exactly where the recorder used to be.
//
// TRUST. mitmdump mints a CA at start. The client container gets the CA CERT
// (never the key) by file and in the usual env names. The CA directory lives in
// the run's own scratch folder, so it is per capture.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";

// Pinned by digest. The image is pulled by setup.mjs (lib/images.mjs) and never
// pulled at run time (--pull=never), like every other tool image here.
export const MITM_IMAGE = "mitmproxy/mitmproxy:12.3.1@sha256:2711066c855659b5af8b1dbb84494ed3eff69b42ece439c60b4fe09a2db829d4";
export const MITM_PORT = 8080;
export const PROBE_HEADER = "x-touchstone-probe";
// A HAR carries whole bodies. Bound what mitm keeps so a big upload cannot use
// the run's memory. Over the limit a body is truncated, never dropped.
const BODY_LIMIT = "2m";
const READY_TIMEOUT_MS = 20_000;

function docker(args, { timeoutMs = 60_000, maxBuffer = 32 * 1024 * 1024 } = {}) {
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

const parseMaybeJson = (text) => {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
};

function headerMap(list, probeSecret) {
  const out = {};
  for (const h of list || []) {
    const name = String(h.name || "");
    const lower = name.toLowerCase();
    // mitm marks pseudo-headers with a leading ":".
    if (lower.startsWith(":")) continue;
    if (lower === PROBE_HEADER && probeSecret && String(h.value) === probeSecret) return null;
    out[name] = String(h.value ?? "");
  }
  return out;
}

function bodyOf(part) {
  const text = part?.text;
  if (typeof text !== "string") return null;
  if (part?.encoding === "base64") {
    try { return parseMaybeJson(Buffer.from(text, "base64").toString("utf8")); } catch { return null; }
  }
  return parseMaybeJson(text);
}

// Pure: HAR text -> transcript entries in the shape lib/proof-http.mjs records,
// so an oracle reads a capture the same way it reads a script transcript. Only
// http(s) entries are kept; a readiness probe (identified by the per-lab secret
// header the client never gets) is dropped.
//
// `origin` is the base the client actually called (the mitm alias). The entry
// `url` keeps that origin, and `path` is the raw path the origin received, minus
// the query, the same rule the recorder follows.
export function harEntries(harText, { probeSecret = "", origin = null } = {}) {
  let har;
  try { har = JSON.parse(harText); } catch { return []; }
  const entries = Array.isArray(har?.log?.entries) ? har.log.entries : [];
  const out = [];
  for (const e of entries) {
    const rawUrl = String(e?.request?.url ?? "");
    if (!/^https?:\/\//i.test(rawUrl)) continue;
    const reqHeaders = headerMap(e.request.headers, probeSecret);
    if (reqHeaders === null) continue;                    // a readiness probe
    let url = rawUrl;
    try {
      const u = new URL(rawUrl);
      if (origin) url = origin + u.pathname + u.search;
    } catch { /* keep the raw URL */ }
    let path = rawUrl;
    try { path = new URL(rawUrl).pathname; } catch { /* keep the raw URL */ }
    out.push({
      method: String(e.request.method ?? "GET"),
      path,
      url,
      reqHeaders,
      reqBody: bodyOf(e.request.postData),
      status: Number(e?.response?.status ?? 0),
      resHeaders: headerMap(e.response?.headers) ?? {},
      resBody: bodyOf(e.response?.content),
      captures: {
        startedAt: e.startedDateTime ?? null,
        timeMs: typeof e.time === "number" ? Math.round(e.time) : null,
        mime: e?.response?.content?.mimeType ?? null,
      },
    });
  }
  return out;
}

async function waitForCa(dir, name, timeoutMs) {
  const cert = join(dir, "mitmproxy-ca-cert.pem");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(cert)) return cert;
    if (Date.now() >= deadline) {
      const logs = await docker(["logs", name]);
      const status = await docker(["ps", "-a", "--filter", `name=^${name}$`, "--format", "{{.Status}}"]);
      throw new Error(`capture: the proxy wrote no CA within ${timeoutMs}ms (container: ${status.stdout.trim() || "gone"}). ${(logs.stdout + logs.stderr).trim().slice(0, 600)}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

// Ready when a plain TCP connect to the proxy's port succeeds. A connect proves
// the listener; it sends nothing upstream, so a live target never sees a
// phantom request. undici's fetch ignores HTTP_PROXY, hence the raw socket.
const READY_SCRIPT = `
const net = require("node:net");
const s = net.connect(${MITM_PORT}, "mitm", () => { s.end(); process.exit(0); });
s.on("error", () => process.exit(1));
setTimeout(() => process.exit(1), 4000);
`;

async function waitReady({ net, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await docker([
      "run", "--rm", "--pull=never", "--network", net,
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      INIT_IMAGE, "node", "-e", READY_SCRIPT,
    ], { timeoutMs: 10_000 });
    if (r.code === 0) return;
    if (Date.now() >= deadline) throw new Error(`capture: the proxy did not accept a connection within ${timeoutMs}ms`);
    await new Promise((r2) => setTimeout(r2, 250));
  }
}

// A small image for the readiness probe. The lab image varies per pack.
const INIT_IMAGE = "node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0";

/**
 * Start a recording proxy on `ctx.net`, forwarding to `ctx.upstream`, writing its
 * CA and HAR under `dir`. Resolves { name, harPath, caCert, stop }. The caller
 * owns the lifetime; captureThrough uses this and stops it itself.
 */
export async function startProxy(ctx, dir, { readyTimeoutMs = READY_TIMEOUT_MS } = {}) {
  if (!ctx?.net || !ctx?.upstream) throw new Error("startProxy: ctx {net, upstream} is required");
  const tag = randomBytes(4).toString("hex");
  const name = `touchstone-mitm-${tag}`;
  const harPath = join(dir, "capture.har");
  const caDir = join(dir, "ca");
  const user = ctx.user ?? `${process.getuid()}:${process.getgid()}`;
  mkdirSync(caDir, { recursive: true });
  chmodSync(dir, 0o777);
  chmodSync(caDir, 0o777);

  const stop = async () => {
    // SIGINT, not SIGTERM: mitm writes the HAR in its done hook on a graceful
    // stop, and a SIGTERM is not one.
    await docker(["kill", "-s", "INT", name], { timeoutMs: 15_000 });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const ps = await docker(["ps", "-q", "--filter", `name=^${name}$`]);
      if (!ps.stdout.trim()) return;
      await new Promise((r) => setTimeout(r, 150));
    }
    await docker(["rm", "-f", name], { timeoutMs: 15_000 });
  };

  const run = await docker([
    "run", "-d", "--rm", "--pull=never", "--name", name,
    "--network", ctx.net, "--network-alias", "mitm",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "128", "--memory", "1g",
    "--user", user,
    "-v", `${dir}:/work`,
    "--entrypoint", "mitmdump", MITM_IMAGE,
    "--mode", `upstream:${ctx.upstream}`,
    "--listen-port", String(MITM_PORT),
    "--set", "confdir=/work/ca",
    "--set", "hardump=/work/capture.har",
    "--set", "flow_detail=0",
    "--set", `body_size_limit=${BODY_LIMIT}`,
    "--set", "stream_large_bodies=" + BODY_LIMIT,
    "--set", "connection_strategy=lazy",
    "--set", "upstream_cert=false",
  ], { timeoutMs: 60_000 });
  if (run.code !== 0) { await stop(); throw new Error(`capture: proxy run failed: ${run.stderr.trim().slice(0, 500)}`); }
  try {
    const caCert = await waitForCa(caDir, name, readyTimeoutMs);
    await waitReady({ net: ctx.net, timeoutMs: readyTimeoutMs });
    return { name, harPath, caCert, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

/**
 * Run one client through a recording MITM proxy.
 *
 * ctx      { net, upstream, probeSecret? } — `net` is the network the client
 *          may use, `upstream` the proxy the mitm forwards to. A lab run passes
 *          `{ net: handle.net, upstream: handle.netBaseUrl }`; a live run passes
 *          the reach boundary's client network and its gate URL, so the gate
 *          stays the only way out.
 * client   { image, cmd, env?, entrypoint?, user?, workdir?, rw? } — the
 *          program. `cmd` should name a script under the /app/_run mount. `rw`
 *          mounts the scratch dir writable (a client that writes its own files).
 * opts     { dir, timeoutMs?, readyTimeoutMs? }
 *
 * The client's exit code is data, not an error. It rejects only when its own
 * setup fails (proxy start, CA, readiness). On success it resolves
 *   { transcript, harPath, code, stdout, stderr, proxied, dropped }
 * after the proxy is stopped and the HAR is read. This function removes only its
 * own container; the caller owns the network and the target.
 */
export async function captureThrough(ctx, client, { dir, timeoutMs = 180_000, readyTimeoutMs = READY_TIMEOUT_MS } = {}) {
  if (!ctx?.net || !ctx?.upstream) throw new Error("captureThrough: ctx {net, upstream} is required");
  if (!dir) throw new Error("captureThrough: a scratch dir is required");
  if (!client?.image || !Array.isArray(client?.cmd)) throw new Error("captureThrough: client {image, cmd} is required");
  const proxy = await startProxy(ctx, dir, { readyTimeoutMs });
  const user = client.user ?? `${process.getuid()}:${process.getgid()}`;
  let result = null;
  try {
    // The scratch dir is mounted at /app/_run, INSIDE the image, so a client
    // written there resolves its imports against the image's own node_modules.
    // The CA CERT (never the key) sits in that same mount; it is the only thing
    // a client has to trust.
    const certInContainer = `/app/_run/ca/${basename(proxy.caCert)}`;
    const clientArgs = [
      "run", "--rm", "--pull=never", "--network", ctx.net,
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--pids-limit", "512", "--memory", "2g",
      "--user", user,
      "-v", `${dir}:/app/_run${client.rw ? "" : ":ro"}`,
      "-e", `HTTP_PROXY=http://mitm:${MITM_PORT}`,
      "-e", `HTTPS_PROXY=http://mitm:${MITM_PORT}`,
      "-e", `http_proxy=http://mitm:${MITM_PORT}`,
      "-e", `https_proxy=http://mitm:${MITM_PORT}`,
      "-e", `NO_PROXY=`,
      "-e", `NODE_EXTRA_CA_CERTS=${certInContainer}`,
      "-e", `SSL_CERT_FILE=${certInContainer}`,
      "-e", `REQUESTS_CA_BUNDLE=${certInContainer}`,
      "-e", `CURL_CA_BUNDLE=${certInContainer}`,
    ];
    if (client.workdir) clientArgs.push("-w", client.workdir);
    for (const [k, v] of Object.entries(client.env ?? {})) clientArgs.push("-e", `${k}=${v}`);
    if (client.entrypoint) clientArgs.push("--entrypoint", client.entrypoint);
    clientArgs.push(client.image, ...client.cmd);
    // The HAR is written on the proxy's graceful stop, so it is read after it.
    result = await docker(clientArgs, { timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  } finally {
    await proxy.stop();
  }
  return { ...result, harPath: proxy.harPath, ...(await readHar(proxy.harPath, ctx)) };
}

// The prelude a capture client gets. It mirrors the `request()` the proof
// harness gives a request script, but sends through the proxy, so what it does
// is exactly what lands in the HAR. Client scripts are written to the mounted
// scratch dir and run from it, so their `import` resolves against the image's
// own node_modules (`client.workdir`).
export const CLIENT_PRELUDE = `
import http from "node:http";
import { Wallet } from "ethers";
import { SiweMessage } from "siwe";
const BASE_URL = "http://lab:${MITM_PORT}";
const raw = (method, path, headers, body) => new Promise((resolve, reject) => {
  const req = http.request({ host: "mitm", port: ${MITM_PORT}, path: "http://lab:${MITM_PORT}" + path, method,
    headers: Object.assign({ host: "lab:${MITM_PORT}" }, headers, body ? { "content-length": Buffer.byteLength(body) } : {}) }, (res) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
  });
  req.on("error", reject);
  if (body) req.write(body);
  req.end();
});
globalThis.request = async function request(method, path, opts = {}) {
  const headers = Object.assign({ "content-type": "application/json" }, opts.headers || {});
  const hasBody = opts.body !== undefined;
  const body = hasBody ? (typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body)) : undefined;
  const res = await raw(method, path, headers, body);
  let json = null;
  try { json = JSON.parse(res.text); } catch {}
  return { status: res.status, resBody: json ?? res.text };
};
globalThis.signPersonal = async function signPersonal(privateKey, message) {
  return new Wallet(privateKey).signMessage(message);
};
globalThis.buildSiwe = function buildSiwe(fields) {
  return new SiweMessage(fields).prepareMessage();
};
`;

async function readHar(harPath, ctx) {
  let text = "";
  try { text = readFileSync(harPath, "utf8"); } catch { /* no HAR written */ }
  if (!text) return { transcript: [], proxied: false, dropped: 0 };
  const transcript = harEntries(text, { probeSecret: ctx.probeSecret ?? "", origin: ctx.origin ?? null });
  let total = 0;
  try { total = JSON.parse(text)?.log?.entries?.length ?? 0; } catch { /* keep 0 */ }
  return { transcript, proxied: true, dropped: Math.max(0, total - transcript.length) };
}

// Copy the HAR into the run workspace so it outlives the scratch dir. Returns
// the path written, or null when there is no HAR.
export function keepHar(ws, dir, label) {
  const safe = String(label ?? "capture").replace(/[^a-z0-9._-]+/gi, "-").slice(0, 60) || "capture";
  const target = join(ws, "captures", `${safe}.har`);
  mkdirSync(join(ws, "captures"), { recursive: true });
  try {
    writeFileSync(target, readFileSync(join(dir, "capture.har")));
    return target;
  } catch {
    return null;
  }
}
