// The LIVE lane every web-facing pack shares — the same request scripts, aimed at
// the operator's real target instead of the pack's planted lab.
//
// WHY THIS EXISTS. Every other target kind copies or generates code, so the lab
// is the target. A live target has no code to copy: the target IS the website
// the operator added and ticked permission for. So nothing about the lab may
// stand in for it:
//   - the prepass does not start a lab container; it scans the real target;
//   - run_request_script sends real requests to the target;
//   - prove() replays each finding's script against the target again.
//
// AIM. The workspace config (written by lib/targets.mjs prepareWorkspace) holds
// `baseUrl` — the exact origin the operator typed, scheme and port included.
// Every request is resolved against it. Nothing here guesses `http://lab:8080`.
//
// CONFINEMENT. A live script runs in a hardened container on the reach
// boundary's client network (lib/reach-confine.mjs): its only route off that
// network is the scope gate, which enforces the run's network policy. The harness routes
// through the gate explicitly, so target traffic cannot leave any other way.
// The pack supplies the image (its own lab image, already carrying the script
// runtime) and its own scan; this file knows nothing about a website or an MCP
// server in particular.
//
// TRANSCRIPT. The oracle must read something the script cannot quietly rewrite.
// The lab path gets that from a separate recording proxy container. Here the
// request helper itself is injected before the script runs and appends the real
// exchange to a file the parent reads after the container exits. The script
// shares the process, so this is weaker than the lab's out-of-band recorder;
// the helper never calls global fetch, so monkeypatching fetch cannot fake it.
import { requestWithRedirects, retrySend } from "./redirect-request.mjs";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireImage } from "./proof-http.mjs";
import { readTouchstone, writeTouchstone } from "./sandbox.mjs";

// The scan stage needs a route to the internet, so it runs on the default bridge
// network and is aimed straight at the base URL. The scan only produces leads;
// the confined script run is what proves anything.
export const SCAN_NETWORK = "bridge";

// Same hardening as lib/reach-confine.mjs and lib/proof-http.mjs.
const HARDEN = ["--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "128", "--memory", "256m"];

export function isLive(ws) {
  return readTouchstone(ws).kind === "live";
}

// What the live lane runs against: the persisted confinement, the gate URL as
// the script's container sees it, and the base URL from the workspace.
export function liveTarget(ws) {
  const cfg = readTouchstone(ws);
  const net = cfg.live?.net;
  const gate = cfg.live?.gate;
  const baseUrl = cfg.baseUrl ?? cfg.live?.baseUrl;
  if (!net || !gate) throw new Error("Live requests are unavailable: this workspace has no confinement boundary. It was not prepared, or its live route has ended. Do not retry request scripts. Start a new run for live testing; saved files can still be inspected.");
  if (!baseUrl) throw new Error("this live run has no base URL");
  if (!cfg.live?.image) throw new Error("this live run has no script image");
  return { net, gate, baseUrl, image: cfg.live.image };
}

// Persist the boundary on the workspace, so the agent tool AND the later proof
// replay (a different call site) find the same one.
export function bindLive(ws, { net, gate, baseUrl, image }) {
  writeTouchstone(ws, { ...readTouchstone(ws), live: { net, gate, baseUrl, image } });
}

// The request helpers, injected into the script before it runs. `request` goes
// through the gate on the client network; each redirect uses the same checked
// route. Every response, including intermediate redirects, is recorded.
export const HARNESS = `const requestWithRedirects = ${requestWithRedirects.toString()};\nconst retrySend = ${retrySend.toString()};\n` + String.raw`
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { appendFileSync } from "node:fs";
import { Wallet } from "ethers";
import { SiweMessage } from "siwe";

const BASE = process.env.TOUCHSTONE_BASE_URL;
const PROXY = new URL(process.env.TOUCHSTONE_SCOPE_PROXY);
const OUT = process.env.TOUCHSTONE_TRANSCRIPT;
const LIMIT = 200_000;

const flat = (h) => { const o = {}; for (const [k, v] of Object.entries(h || {})) o[k] = Array.isArray(v) ? v.join(", ") : v; return o; };
const record = (e) => appendFileSync(OUT, JSON.stringify(e) + "\n");
const parse = (s) => { try { return JSON.parse(s); } catch { return s; } };

function connectProxy() {
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(PROXY.port), PROXY.hostname, () => resolve(s));
    s.once("error", reject);
  });
}

// Read exactly one HTTP head off a socket, then hand the rest back. The bytes
// after the head are tunnel payload; the caller pushes them back with unshift.
// Flowing mode (data events) is what makes the TLS wrap below work at all.
function readHead(sock) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d) => {
      buf += d.toString("latin1");
      const i = buf.indexOf("\r\n\r\n");
      if (i < 0) return;
      sock.removeListener("data", onData);
      resolve({ head: buf.slice(0, i), rest: Buffer.from(buf.slice(i + 4), "latin1") });
    };
    sock.on("data", onData);
    sock.once("error", reject);
  });
}

async function openTunnel(host) {
  const sock = await connectProxy();
  sock.write("CONNECT " + host + " HTTP/1.1\r\nHost: " + host + "\r\n\r\n");
  const { head, rest } = await readHead(sock);
  if (!/^HTTP\/1\.[01] 200/.test(head)) throw new Error("the gate refused " + host + ": " + head.split("\r\n")[0]);
  if (rest.length) sock.unshift(rest);
  return new Promise((resolve, reject) => {
    const s = tls.connect({ socket: sock, servername: host.replace(/:\d+$/, "") }, () => resolve(s));
    s.once("error", reject);
  });
}

async function send(url, method, headers, body) {
  const secure = url.protocol === "https:";
  const sock = secure ? await openTunnel(url.host) : await connectProxy();
  // A fresh agent per call whose connection IS the socket we already made, so
  // the request cannot re-resolve the name or open a second route. Per call, so
  // a torn socket is never reused.
  const agent = new (secure ? https : http).Agent({ keepAlive: false });
  agent.createConnection = () => sock;
  const opts = {
    method,
    headers: { ...headers, host: url.host },
    path: secure ? url.pathname + url.search : url.href,
    agent,
  };
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request(opts, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { if (text.length < LIMIT) text += d; });
      res.on("end", () => resolve({ status: res.statusCode, headers: flat(res.headers), body: text }));
    });
    req.once("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const sendRetrying = retrySend(send);

globalThis.request = async function request(method, path, o = {}) {
  const url = new URL(path, BASE);
  const headers = { "content-type": "application/json", "accept-encoding": "identity", ...(o.headers || {}) };
  const hasBody = o.body !== undefined;
  const body = hasBody ? (typeof o.body === "string" ? o.body : JSON.stringify(o.body)) : undefined;
  return requestWithRedirects(sendRetrying, record, method, url, headers, body, o);
};

globalThis.signPersonal = async function signPersonal(privateKey, message) {
  return new Wallet(privateKey).signMessage(message);
};

// The same EIP-4361 helper the lab harness gives a script, so a live finding's
// script replays unchanged on a lab and the other way round.
globalThis.buildSiwe = function buildSiwe(fields) {
  return new SiweMessage(fields).prepareMessage();
};
`;

function docker(args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    execFile("docker", args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        timedOut: Boolean(err?.killed),
      });
    });
  });
}

// One live script, one throwaway container. Returns the transcript the helper
// wrote plus the script's own output. Same shape as lib/proof-http.mjs
// runRequestScript, so the caller's oracle code is identical for both.
const queues = new Map();
function serialize(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(key, next.then(() => {}, () => {}));
  return next;
}

// LIVE_SCRIPT_TIMEOUT_MS is the wall clock one script gets. A real target needs
// pacing: 429 backoff inside request() plus the agent's own wait between waves.
// 30 s killed any script that slept once before its first request, and the
// transcript then read "(no requests recorded)" even though nothing was wrong.
// 180 s: agents keep sleeping 30 to 50 s to pace a rate-limited host even when
// told not to, and 90 s killed those before their first call. The cost is only
// a runaway script holding the queue; the internal retries are bounded anyway.
export const LIVE_SCRIPT_TIMEOUT_MS = 180_000;

export async function runLiveScript(ws, script, { timeoutMs = LIVE_SCRIPT_TIMEOUT_MS } = {}) {
  return serialize(ws, async () => {
    const t = liveTarget(ws);
    await requireImage(t.image, t.image.includes("ai-mcp") ? "ai-mcp" : "web");
    const dir = mkdtempSync(join(tmpdir(), "touchstone-live-"));
    try {
      chmodSync(dir, 0o777);
      writeFileSync(join(dir, "run.mjs"), `${HARNESS}\n(async () => {\n${script}\n})().catch((e) => { console.error(String(e && e.stack || e)); process.exitCode = 1; });\n`);
      writeFileSync(join(dir, "transcript.jsonl"), "");
      // --init: tini reaps a script that leaves a dangling timer, so one hung
      // attempt cannot hold the queue (same reason as the lab runner).
      const r = await docker([
        // Mounted under /app (not /work) and run from there: the image's own
        // node_modules sit at /app, which is where `import "ethers"` resolves.
        "run", "--rm", "--init", "--pull=never", "--network", t.net, ...HARDEN,
        "-v", `${dir}:/app/_run`, "-w", "/app",
        "-e", `TOUCHSTONE_BASE_URL=${t.baseUrl}`,
        "-e", `TOUCHSTONE_SCOPE_PROXY=${t.gate}`,
        "-e", "TOUCHSTONE_TRANSCRIPT=/app/_run/transcript.jsonl",
        "--entrypoint", "node", t.image, "/app/_run/run.mjs",
      ], { timeoutMs });
      const transcript = readFileSync(join(dir, "transcript.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
      return { transcript, stdout: r.stdout.trim(), stderr: r.stderr.trim(), code: r.code, timedOut: r.timedOut };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// A replay against the live site for one finding. Mirrors httpProof()'s return
// shape so proof-view renders it exactly like a lab replay.
export async function liveProof(ws, script, oracle) {
  const run = await runLiveScript(ws, script);
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
    log: run.transcript.map((e, i) => ({
      label: `${i + 1}. ${e.method} ${e.path}`,
      request: { method: e.method, url: e.url, headers: e.reqHeaders, body: e.reqBody },
      response: { status: e.status, headers: e.resHeaders, body: e.resBody },
    })),
  };
}
