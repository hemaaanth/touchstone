// Capture mode for runTool(): the ONE way a pack tool gets the network.
//
// Every other runTool() call runs with `--network none`. A capture is the step
// where a tool reads a live service (today: the GitHub API) and its raw output
// is saved. Leads come from the saved bytes. Prove and replay stay offline.
//
// What a capture needs, checked in this order, before any container starts:
//   1. A reach grant: reach.granted === true and reach.scope naming each target
//      ("owner/repo" or the whole "owner"). Same model as captureGithub. And
//      each target must be in CAPTURE_TARGETS (today only hemaaanth/touchstone).
//   2. An egress allow-list (hosts). The tool runs on a Docker `--internal`
//      network. Its only path out is the scope proxy (lib/reach-confine.mjs),
//      which allows these hosts and nothing else. A raw socket has no route.
//
// The argv always has `--pull=never` (the image is built locally and pinned).
// A secret (the GitHub token) goes into the container by NAME only: the argv
// holds `-e GITHUB_TOKEN`, and the value rides in the docker CLI's own
// environment. So it is never in argv, the host `ps`, or a log line. It IS in
// the container's Config.Env while the container lives, so anyone who can run
// `docker inspect` on it can read it (the owner rule allows env). Any copy of a
// secret value in the tool's stdout or stderr is replaced before the result
// returns, and output that still holds part of it is dropped.
//
// Capture runs on local Docker only, never on a Daytona machine: the secret
// would have to cross to the remote host, and the boundary is built locally.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { confineReach } from "./reach-confine.mjs";

// The GitHub hosts a capture may reach. codeload.github.com serves the repo
// archive that api.github.com/.../tarball redirects to (Scorecard reads files
// that way). A tool gets only the hosts its spec names, never more than these.
export const GITHUB_CAPTURE_HOSTS = ["api.github.com", "codeload.github.com"];

const SCOPE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9._-]{1,100})?$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

export const inCaptureScope = (t, scope) => {
  const keys = (scope ?? []).map((s) => String(s).toLowerCase());
  return keys.includes(String(t.owner).toLowerCase()) || (t.repo != null && keys.includes(`${t.owner}/${t.repo}`.toLowerCase()));
};

// The only repos a capture may read, whatever the grant says. A capture puts
// the owner's token into a third-party tool's container, so a self-made grant
// for another repo is not enough. Widening this list is a code change.
export const CAPTURE_TARGETS = ["hemaaanth/touchstone"];
export const isCaptureTarget = (t) => t?.repo != null && CAPTURE_TARGETS.includes(`${t.owner}/${t.repo}`.toLowerCase());

// Refuse a capture with no grant, for a target the grant does not name, or for
// a target outside CAPTURE_TARGETS.
// targets: [{ owner, repo|null }]. An owner-wide target needs the owner in scope.
export function assertCaptureReach(reach, targets) {
  if (!reach || reach.granted !== true || !Array.isArray(reach.scope)) throw new Error("A capture needs an operator grant (reach.granted and reach.scope).");
  if (!Array.isArray(targets) || !targets.length) throw new Error("A capture needs at least one target.");
  for (const t of targets) {
    if (!t || !SCOPE_RE.test(t.repo ? `${t.owner}/${t.repo}` : String(t.owner))) throw new Error("A capture target must be owner or owner/repo.");
    if (!inCaptureScope(t, reach.scope)) throw new Error(`${t.repo ? `${t.owner}/${t.repo}` : t.owner} is not in the granted scope`);
    if (!isCaptureTarget(t)) throw new Error(`${t.repo ? `${t.owner}/${t.repo}` : t.owner} is not a capture target (only ${CAPTURE_TARGETS.join(", ")})`);
  }
}

function assertHosts(hosts) {
  if (!Array.isArray(hosts) || !hosts.length) throw new Error("A capture needs an egress allow-list.");
  for (const h of hosts) if (!GITHUB_CAPTURE_HOSTS.includes(h)) throw new Error(`${h} is not a capture host`);
}

// The docker argv for one capture. Pure, so a test can check it exactly.
//   network  the --internal client network of the boundary (never none/host/bridge)
//   gate     the scope proxy URL on that network
//   secrets  names only; values are never put here
export function captureArgs({ name, image, cmd, ws = null, network, gate, user, env = {}, secretNames = [] }) {
  if (!network || ["none", "host", "bridge", "default"].includes(network) || network.startsWith("container:")) throw new Error("capture needs its own confined network");
  if (!/^https?:\/\/[a-z0-9.-]+:\d+$/.test(gate ?? "")) throw new Error("capture needs a gate URL");
  for (const k of [...Object.keys(env), ...secretNames]) if (!ENV_NAME.test(k)) throw new Error(`bad env name ${k}`);
  const clash = secretNames.find((k) => Object.hasOwn(env, k));
  if (clash) throw new Error(`${clash} is a secret; pass it only through secrets`);
  return [
    "run", "--rm", "--pull=never", "--name", name, "--network", network,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "512", "--memory", "2g", "--user", user,
    ...(ws ? ["-v", `${ws}:/work`, "-w", "/work"] : []),
    "-e", `HTTPS_PROXY=${gate}`, "-e", `https_proxy=${gate}`,
    "-e", `HTTP_PROXY=${gate}`, "-e", `http_proxy=${gate}`,
    "-e", "NO_PROXY=", "-e", "no_proxy=",
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...secretNames.flatMap((k) => ["-e", k]),
    image, ...cmd,
  ];
}

// Replace every copy of each secret value. Short values are not secrets we
// can match safely, so a secret shorter than 8 characters is refused earlier.
export function scrub(text, values) {
  let out = String(text ?? "");
  for (const v of values) if (v) out = out.split(v).join("[REDACTED]");
  return out;
}

// What a scrub cannot see: a part of the secret, or the secret encoded. These
// are every 12-character piece of the value, its base64 and base64url forms
// (at each of the 3 byte offsets, and every 16-character piece of those), and
// its URL-encoded form. A tool that prints any of them has its output dropped.
export const PIECE = 12;
export function secretForms(v) {
  const forms = new Set([encodeURIComponent(v)]);
  for (let i = 0; i + PIECE <= v.length; i++) forms.add(v.slice(i, i + PIECE));
  for (let k = 0; k < 3; k++) {
    const b = Buffer.from(v.slice(k));
    for (const enc of ["base64", "base64url"]) {
      // Only whole 3-byte groups: the tail depends on the bytes that follow.
      const core = b.toString(enc).slice(0, Math.floor(b.length / 3) * 4);
      for (let i = 0; i + 16 <= core.length; i++) forms.add(core.slice(i, i + 16));
    }
  }
  return [...forms];
}
export function holdsSecret(text, values) {
  const t = String(text ?? "");
  return values.some((v) => v && secretForms(v).some((f) => t.includes(f)));
}
export const LEAK_REASON = "output contained part of the token";

// Scrub stdout and stderr. If any part of a secret is still there, drop both.
export function cleanOutput(r, values) {
  const stdout = scrub(r.stdout, values), stderr = scrub(r.stderr, values);
  if (holdsSecret(stdout, values) || holdsSecret(stderr, values)) return { stdout: "", stderr: "", leaked: LEAK_REASON };
  return { stdout, stderr };
}
// An error message is saved too. Same rule: scrub, and drop it if a part is left.
export const cleanError = (msg, values) => { const m = scrub(msg, values).slice(0, 300); return holdsSecret(m, values) ? `error text dropped: ${LEAK_REASON}` : m; };

function execDocker(args, { env, timeoutMs, maxBuffer }) {
  return new Promise((resolve) => {
    execFile("docker", args, { env, timeout: timeoutMs, maxBuffer }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), timedOut: Boolean(err?.killed) });
    });
  });
}

// Run one named `docker run` and always remove the container by name after.
// The timeout is ours, not the docker CLI's: a signal to the CLI does not stop
// the container, and a PID 1 that ignores SIGTERM keeps the CLI waiting. So at
// timeoutMs the container is removed by name, and the call reports timedOut.
// The finally also covers a CLI that died early (maxBuffer, a crash).
export async function runNamed(args, name, { env = process.env, timeoutMs = 180_000, maxBuffer = 64 * 1024 * 1024, exec = execDocker } = {}) {
  const rm = () => exec(["rm", "-f", name], { env: process.env, timeoutMs: 30_000, maxBuffer: 1024 * 1024 }).catch(() => {});
  let late = false, done = false;
  // On a busy host the container may not exist yet when the time is up, and a
  // single rm would miss it. So keep removing it until the docker CLI returns.
  const stop = async () => { late = true; while (!done) { await rm(); if (!done) await new Promise((r) => setTimeout(r, 1_000)); } };
  const timer = setTimeout(stop, timeoutMs);
  try {
    // A backstop only: the timer above stops the tool first.
    const r = await exec(args, { env, timeoutMs: timeoutMs + 60_000, maxBuffer });
    return { ...r, timedOut: Boolean(r.timedOut) || late };
  } finally {
    done = true;
    clearTimeout(timer);
    await rm();
  }
}

// The gate's own log: one __TOUCHSTONE_SCOPE__ JSON line per proxied request.
// With HTTPS each line is one CONNECT tunnel, not one API request.
export function egressSummary(logText) {
  const recs = [];
  for (const line of String(logText ?? "").split("\n")) {
    const at = line.indexOf("__TOUCHSTONE_SCOPE__ ");
    if (at < 0) continue;
    try { recs.push(JSON.parse(line.slice(at + 21))); } catch { /* not a record */ }
  }
  const count = (d) => recs.filter((r) => r.decision === d).reduce((m, r) => ({ ...m, [r.host]: (m[r.host] ?? 0) + 1 }), {});
  return { tunnels: count("allow"), blocked: count("block") };
}

// Run one tool with the network, confined. Resolves (never rejects) with
//   { code, stdout, stderr, timedOut, egress, refused?, leaked? }
// leaked: the output held part of a secret, so stdout and stderr are empty.
// A refusal (no grant, bad hosts, a missing secret) starts nothing.
//   reach, targets   the grant and what this call reads
//   hosts            egress allow-list, a subset of GITHUB_CAPTURE_HOSTS
//   secrets          { NAME: value }. Each must be a non-empty string of 8+ chars.
// confine and exec are seams for tests. Production uses the real boundary.
export async function runCapture({ image, cmd, ws = null, user, env = {}, timeoutMs = 180_000, maxBuffer = 64 * 1024 * 1024,
  reach, targets, hosts, secrets = {}, confine = confineReach, exec = execDocker }) {
  const refuse = (why) => ({ code: -1, stdout: "", stderr: "", timedOut: false, egress: null, refused: why });
  try {
    assertCaptureReach(reach, targets);
    assertHosts(hosts);
    for (const [k, v] of Object.entries(secrets)) if (typeof v !== "string" || v.length < 8) throw new Error(`secret ${k} is missing`);
  } catch (err) { return refuse(err.message); }
  const values = Object.values(secrets);
  const name = `touchstone-capture-${randomBytes(4).toString("hex")}`;
  let box;
  try { box = await confine({ allowedHosts: hosts }); }
  catch (err) { return refuse(`could not build the egress boundary: ${cleanError(err.message, values)}`); }
  try {
    const args = captureArgs({ name, image, cmd, ws, network: box.netClient, gate: box.gateUrl, user, env, secretNames: Object.keys(secrets) });
    // Secrets live only in the docker CLI's environment. The CLI copies a
    // `-e NAME` with no value from there into the container.
    const r = await runNamed(args, name, { env: { ...process.env, ...secrets }, timeoutMs, maxBuffer, exec });
    const logs = box.proxyName ? await exec(["logs", box.proxyName], { env: process.env, timeoutMs: 15_000, maxBuffer: 16 * 1024 * 1024 }) : { stdout: "", stderr: "" };
    const out = cleanOutput(r, values);
    return { code: r.code, ...out, timedOut: r.timedOut, egress: egressSummary(`${logs.stdout}\n${logs.stderr}`) };
  } catch (err) {
    return refuse(cleanError(err.message, values));
  } finally {
    try { await box.stop(); } catch { /* already gone */ }
  }
}
