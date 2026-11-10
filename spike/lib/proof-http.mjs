// The `http` proof: a practice web/API service runs in Docker on a private,
// `--internal` network with no route to the internet. A finding's request
// script runs in a second, throwaway container on that same network. An
// independent oracle reads the recorded request/response transcript -- never
// the script's own console output or claims -- to decide whether the harm is
// real. Any pack whose `proof` is `"http"` (Web and sign-in, APIs, and later
// Nodes/RPC, AI/MCP, Infra/cloud) shares this file. See packs/README.md
// "Proof kinds".
//
// Two lifetimes:
//   - A pack's prepass starts ONE lab and keeps it running for the whole
//     agent session (the agent explores it live through a pack tool). That
//     handle is persisted to a file under the run workspace (see
//     writeLabHandle/readLabHandle/teardownPersistedLab) because prepass and
//     the agent session run in different processes (the agent is a spawned
//     child); only a value on disk survives that boundary reliably.
//   - prove() replays each finding against a FRESH lab, independent of
//     whatever the live session mutated, mirroring lib/proof.mjs's "never
//     trust the agent's own test" rule for Foundry. httpProof() does this in
//     one call: start, run the script, stop, ask the oracle.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

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

// Start a lab: an isolated internal Docker network with no gateway (so the
// container inside it has no route out), plus the lab image running detached
// on it, reachable by the other containers we put on the same network under
// `alias` (default "lab" -- match this in the pack's openapi.yaml `servers`
// url and BRIEF.md). There is no host port publish: Docker does not forward
// ports on a `--internal` network at all (confirmed by testing -- a `-p`
// flag on one is silently accepted but never bound; `docker inspect` shows
// the container port mapped to null). So a live agent process, same as a
// finding's replay, always reaches the lab from a throwaway container on
// `net` via runRequestScript() -- one mechanism for every reach, no
// publish-vs-isolation tradeoff to get wrong. Returns a handle; the caller
// must eventually call stopLab(handle).
export async function startLab({
  image,
  alias = "lab",
  containerPort = 8080,
  env = {},
  readyPath = "/healthz",
  readyTimeoutMs = 20_000,
}) {
  const tag = randomBytes(4).toString("hex");
  const net = `touchstone-net-${tag}`;
  const name = `touchstone-lab-${tag}`;
  const created = await docker(["network", "create", "--internal", net]);
  if (created.code !== 0) {
    throw new Error(`startLab: docker network create failed: ${created.stderr.trim().slice(0, 500)}`);
  }
  const args = [
    "run", "-d", "--rm", "--name", name,
    "--network", net, "--network-alias", alias,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "256", "--memory", "512m",
  ];
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  args.push(image);
  const started = await docker(args, { timeoutMs: 30_000 });
  if (started.code !== 0) {
    await docker(["network", "rm", net]);
    throw new Error(`startLab: docker run failed: ${started.stderr.trim().slice(0, 500)}`);
  }
  const handle = { net, name, alias, image, containerPort, netBaseUrl: `http://${alias}:${containerPort}` };
  try {
    await waitReady(handle, { readyPath, timeoutMs: readyTimeoutMs });
  } catch (err) {
    await stopLab(handle);
    throw err;
  }
  return handle;
}

async function waitReady(handle, { readyPath, timeoutMs, intervalMs = 300 }) {
  const url = `${handle.netBaseUrl}${readyPath}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await docker([
      "run", "--rm", "--network", handle.net,
      "node:20-slim", "node", "-e",
      `fetch(${JSON.stringify(url)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`,
    ], { timeoutMs: 8_000 });
    if (r.code === 0) return;
    if (Date.now() >= deadline) throw new Error(`startLab: ${handle.alias} did not answer ${readyPath} within ${timeoutMs}ms`);
    await new Promise((r2) => setTimeout(r2, intervalMs));
  }
}

export async function stopLab(handle) {
  if (!handle) return;
  await docker(["rm", "-f", handle.name], { timeoutMs: 15_000 });
  await docker(["network", "rm", handle.net], { timeoutMs: 15_000 });
}

// --- Persist a live lab handle across the prepass -> agent session -> prove
// boundary (the agent session is a separate spawned process; prepass and
// prove run in the same process as each other, but only a value on disk is
// guaranteed to survive the gap between them). Keyed by workspace, not by any
// in-memory map, so it is correct even if the host process serves several
// runs at once (the app server can).
const HANDLE_FILE = ".touchstone-http-lab.json";

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
// A finding's "request script" is a body of JS that calls two injected
// helpers -- it does not get the network any other way:
//   await request(method, path, { headers, body })
//     Makes one real HTTP call to the lab and returns
//     { method, path, status, reqHeaders, reqBody, resHeaders, resBody }.
//     Every call is appended to a transcript the script cannot see or edit;
//     the oracle reads only that transcript, never the script's own
//     console.log claims about what happened.
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
const __transcript = [];
globalThis.request = async function request(method, path, opts = {}) {
  const headers = Object.assign({ "content-type": "application/json" }, opts.headers || {});
  const hasBody = opts.body !== undefined;
  const body = hasBody ? (typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body)) : undefined;
  const res = await fetch(BASE_URL + path, { method, headers, body });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const entry = {
    method, path, url: BASE_URL + path, reqHeaders: headers, reqBody: hasBody ? opts.body : null,
    status: res.status, resHeaders: Object.fromEntries(res.headers.entries()), resBody: json ?? text,
  };
  __transcript.push(entry);
  return entry;
};
globalThis.signPersonal = async function signPersonal(privateKey, message) {
  return new Wallet(privateKey).signMessage(message);
};
globalThis.buildSiwe = function buildSiwe(fields) {
  return new SiweMessage(fields).prepareMessage();
};
process.on("exit", () => {
  process.stdout.write("\\n__TOUCHSTONE_TRANSCRIPT__" + JSON.stringify(__transcript) + "\\n");
});
`;

// Run a finding's request script in a fresh, throwaway container on
// `handle.net`, so it reaches the lab only as `handle.alias`. Mounted under
// /app/_run inside the SAME image the lab runs (handle.image), so the
// script's `import ... from "ethers"|"siwe"` resolves against that image's
// already-installed node_modules without needing its own network access.
// Returns the independently-recorded transcript, never the script's own
// stdout as truth (that is returned too, but only for a human to read).
export async function runRequestScript(handle, script, { timeoutMs = 20_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "touchstone-script-"));
  try {
    const wrapped = `${HARNESS}\n(async () => {\n${script}\n})().catch((e) => { console.error(String(e && e.stack || e)); process.exitCode = 1; });\n`;
    writeFileSync(join(dir, "run.mjs"), wrapped);
    const args = [
      "run", "--rm", "--network", handle.net,
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--pids-limit", "128", "--memory", "256m",
      "-v", `${dir}:/app/_run:ro`,
      "-e", `TOUCHSTONE_BASE_URL=${handle.netBaseUrl}`,
      "-w", "/app",
      "--entrypoint", "node",
      handle.image, "/app/_run/run.mjs",
    ];
    const r = await docker(args, { timeoutMs });
    const marker = "__TOUCHSTONE_TRANSCRIPT__";
    const idx = r.stdout.lastIndexOf(marker);
    let transcript = [];
    if (idx !== -1) {
      try { transcript = JSON.parse(r.stdout.slice(idx + marker.length)); } catch { transcript = []; }
    }
    const stdout = idx === -1 ? r.stdout : r.stdout.slice(0, idx);
    return { transcript, stdout: stdout.trim(), stderr: r.stderr.trim(), code: r.code, timedOut: r.timedOut };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    label: `${i + 1}. ${e.method} ${e.path}`,
    request: { method: e.method, url: e.url ?? e.path, headers: e.reqHeaders, body: e.reqBody },
    response: { status: e.status, headers: e.resHeaders, body: e.resBody },
  };
}

// The full http proof for one finding: a fresh lab, independent of the live
// session's mutated state, the script replayed against it, the lab torn
// down, then the named oracle's own read of the transcript -- never the
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
