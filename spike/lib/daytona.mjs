// The Daytona execution backend for runTool() and the Foundry sandbox.
//
// Local Docker is the default. When the operator picks Daytona (Settings, or
// TOUCHSTONE_EXEC=daytona), each tool call runs in a Daytona sandbox machine
// instead. The machine is a small Linux VM with its own Docker. We copy the
// workspace up, run the SAME `docker run` there, and copy changed files back.
// The caller sees the same { code, stdout, stderr, timedOut } it gets locally.
//
// Machines:
//   - One machine per run and per agent. The root agent shares one machine.
//     Each swarm child (event.mjs agent tag "a-...") gets its own machine.
//   - The machine ids of a run live next to its workspace, in `<ws>.daytona.json`.
//     The run worker then reuses the machine the pre-pass made, and
//     cleanupWorkspace(ws) deletes every machine of the run.
//   - A fuzz scratch dir lives in tmp, outside the run. Its caller passes the
//     run's workspace as `root`, so the call uses that run's machine. Its copy
//     on the machine is deleted right after the call.
//   - Every machine belongs to one run. A call with no run (its ws is in no
//     run workspace, and it passes no `root`) runs on local Docker. Examples:
//     the supply-chain, infra-cloud and domains scans of an evidence snapshot.
//   - Every machine carries the label touchstone=1. We only ever delete ids we
//     created. A machine stops after 15 idle minutes and is deleted when it stops,
//     so a crash cannot leave one running for long.
//
// When we fall back to local Docker (each emits an `exec-fallback` event):
//   - The call uses any network but `none`. Live reach goes through the scope
//     proxy and the grant gate on this host. The remote path has no reach gate
//     yet, so a call with a network stays here.
//   - The call mounts a host path other than the workspace.
//   - The call belongs to no run (see Machines above).
//   - The call uses a docker flag the parser does not know, or a
//     `--flag=value` form other than `--network=` and `--pull=never`. Unknown
//     means local.
//   - A solc version did not install on the machine. Only that call goes local.
//   - The Daytona API fails. The machine is deleted and the call tries once more
//     on a new machine. A second failure keeps every call local for 10 minutes.
//
// What goes through this backend: runTool() (lib/wrap.mjs), runDocker() for
// Slither (static.mjs), Echidna (fuzz.mjs) and Medusa (medusa.mjs), and forge
// in lib/sandbox.mjs. Forge includes the proof replay (proof.mjs proofDelta):
// the proof gate reads files built on the machine and copied back. What always stays on local Docker, by design: the lab
// chain and its network (sandbox/lab.mjs, fork-proof.mjs, txreplay-proof.mjs,
// proof-http.mjs), the jail, image builds (keys/common.mjs), cloud.mjs, and the
// docker calls in packs/domains. They need host networks or the host daemon.
//
// The key comes from Settings (spike/data/providers.json, field execution) or
// the DAYTONA_API_KEY environment variable. It is never logged.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { currentAgent, event } from "./event.mjs";
import { readConfig } from "./providers.mjs";
import { scrubError, scrubUrl } from "./redact-url.mjs";
import { saveStore, withStoreLock } from "./grant-store.mjs";
import { MANIFEST } from "./images.mjs";
import { pendingMachines, recordPendingMachine, clearPendingMachines } from "./daytona-pending.mjs";
import { daytonaError, daytonaShellApi, daytonaExecution, confirmDaytonaDeletion } from "./daytona-api.mjs";
import { checkRoamSelection, requireRoamReady } from "./daytona-setup.mjs";
import { allRoamOperations, beginRoamOperation, roamAccountBinding, roamBinding, setRoamSelectionState, updateRoamOperation } from "./daytona-state.mjs";

export const DEFAULT_API_URL = "https://app.daytona.io/api";
export const DEFAULT_SNAPSHOT = "touchstone-exec-dind-v1";
export const DEFAULT_TARGET = "us-west-3";
const SNAPSHOT_IMAGE = "docker:28.5.1-dind";
const IDLE_STOP_MIN = 15;
const DOWN_MS = 10 * 60_000;
// Check a machine again after this much idle time. It stops at IDLE_STOP_MIN.
const staleMs = () => Number(process.env.DAYTONA_STALE_MS) || 5 * 60_000;
let downUntil = 0;

// ---- Settings

// The execution settings, env first, then Settings, then the defaults.
//   backend   "local" | "daytona"
//   apiKey    the Daytona key, or "" when none is set
//   apiUrl    the Daytona server, with no trailing slash
//   keyHeld   why a key is set but not sent, or null
// A key is sent only to the host it is bound to, and only over https with no
// user name, query or #part. A saved key is bound to saved.keyHost (an older
// key without one: the saved or default URL). DAYTONA_API_KEY is bound to
// DAYTONA_API_URL, else to the default server.
export function execConfig(env = process.env, cfg = safeConfig()) {
  const saved = cfg.execution ?? {};
  const pick = String(env.TOUCHSTONE_EXEC || saved.backend || "local").toLowerCase();
  const apiUrl = String(env.DAYTONA_API_URL || saved.apiUrl || DEFAULT_API_URL).replace(/\/+$/, "");
  const host = hostOf(apiUrl);
  const safe = safeUrl(apiUrl);
  const keyHost = saved.keyHost || hostOf(saved.apiUrl || DEFAULT_API_URL);
  const envKeyHost = hostOf(env.DAYTONA_API_URL || DEFAULT_API_URL);
  const savedKey = safe && saved.apiKey && keyHost === host ? saved.apiKey : "";
  const envKey = safe && env.DAYTONA_API_KEY && envKeyHost === host ? env.DAYTONA_API_KEY : "";
  const apiKey = String(savedKey || envKey || "");
  let keyHeld = null;
  if (!apiKey && (saved.apiKey || env.DAYTONA_API_KEY)) {
    if (!safe) keyHeld = `No key is sent to ${host || "the Daytona server"}: its URL must be https, with no user name, query or #part.`;
    else if (saved.apiKey) keyHeld = `The saved key is for ${keyHost}, not ${host}. Enter the key again.`;
    else keyHeld = `The key from DAYTONA_API_KEY is only sent to ${envKeyHost}, not ${host}.`;
  }
  return {
    backend: pick === "daytona" ? "daytona" : "local",
    apiKey,
    keySource: savedKey ? "settings" : envKey ? "env" : null,
    keyHeld,
    // The host DAYTONA_API_KEY is bound to, or null with no env key. A host
    // name only, so the form can tell if the env key fits a new server.
    envKeyHost: env.DAYTONA_API_KEY ? envKeyHost : null,
    apiUrl,
    target: String(env.DAYTONA_TARGET || saved.target || DEFAULT_TARGET),
    snapshot: String(env.DAYTONA_SNAPSHOT || saved.snapshot || DEFAULT_SNAPSHOT),
    roamSnapshot: String(env.TOUCHSTONE_ROAM_SNAPSHOT || saved.roamSnapshot || ""),
  };
}

// The host and port of a URL, lower case. "" when it is not a URL.
export function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

// True when a key may be sent to this URL: https, and no user name, password,
// query or #part. The same rule as a saved URL (settings.mjs daytonaUrl).
function safeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash;
  } catch {
    return false;
  }
}

function safeConfig() {
  try {
    return readConfig();
  } catch {
    return {};
  }
}

// True when tool calls should go to Daytona. A missing key means local.
export function daytonaOn(env = process.env) {
  const c = execConfig(env);
  return c.backend === "daytona" && Boolean(c.apiKey);
}

// ---- Docker argv

// Split a `docker run` argv into what Daytona needs to know.
//   args  the argv after "docker", starting with "run"
//   ws    the workspace that may be mounted
// The result names the image and gives the argv with the workspace mount
// rewritten to `remoteWs`. `local` is set when the call must stay on this host:
// any network but "none", a host mount other than the workspace, or a flag
// this parser does not know.
// A call with a network may reach a live target. Live reach goes through the
// scope proxy and the grant gate on this host, so it must not leave it.
// The parser fails safe. A flag it does not know may take a value, so it
// cannot find the image after it. Such a call stays local. So does any
// `--flag=value` form except `--network=` and `--pull=never`, and a second
// network flag. `--pull=always` stays local, since the machine would pull.
// An incoming `--name` is dropped. The remote script names the container
// itself, and its watchdog kills that name. Docker uses the last `--name`, so
// a kept one would make the watchdog miss the container on a timeout.
const VALUE_FLAGS = new Set(["-w", "--user", "-u", "-e", "--memory", "--pids-limit", "--cap-drop", "--security-opt", "--entrypoint"]);
const BARE_FLAGS = new Set(["--rm", "-i", "-t", "-it", "--init"]);

// The images a machine may pull itself under --pull=never (L35): a pull the
// setup manifest pins by digest and marks `daytona: true`. The bytes are fixed by
// the digest, and the fetch is on the remote machine, never on this host.
export const MACHINE_PULL = new Set(
  MANIFEST.filter((m) => m.kind === "pull" && m.daytona && /@sha256:[0-9a-f]{64}$/.test(m.ref)).map((m) => m.ref),
);

// The shell guard that runs the container only when the image is there.
// - --pull=never, an image in MACHINE_PULL: the machine pulls that pinned ref
//   itself when it lacks it, and marks `pulled` for the event log. A failed pull
//   gives code 199, which runOn treats as a failed call (no upload).
// - --pull=never, any other image: nothing is fetched; code 199 sends the image
//   up from this host instead, once.
// - Without the flag the machine may pull as before.
// The tool run itself keeps its own argv (--pull=never and its network).
export function imageGuard(args, image, dir) {
  const inspect = `docker image inspect ${shq(image)} >/dev/null 2>&1`;
  if (!args.includes("--pull=never")) return `if ${inspect} || docker pull -q ${shq(image)} >${dir}/pull 2>&1; then`;
  if (MACHINE_PULL.has(image)) return `if ${inspect} || { docker pull -q ${shq(image)} >${dir}/pull 2>&1 && touch ${dir}/pulled; }; then`;
  return `if ${inspect}; then`;
}

export function planRemote(args, ws, remoteWs) {
  if (args[0] !== "run") return { local: "not a docker run", image: null, args };
  const out = [];
  let image = null;
  let local = null;
  let net = null; // docker's default network has internet access
  const stay = (why) => ({ local: why, image: null, args });
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (image) { out.push(a); continue; }
    if (a === "--network" || a === "--net" || /^--net(work)?=/.test(a)) {
      if (net !== null) return stay("network given twice");
      net = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[++i];
      out.push(a);
      if (!a.includes("=")) out.push(net);
    } else if (a === "-v" || a === "--volume") {
      const spec = String(args[++i] ?? "");
      const [src, ...rest] = spec.split(":");
      if (src.startsWith("/") || src.startsWith(".")) {
        if (!ws || resolve(src) !== resolve(ws)) local = "mounts a host path";
        out.push(a, [remoteWs, ...rest].join(":"));
      } else {
        out.push(a, spec); // a named volume lives on the machine
      }
    } else if (a === "--name") {
      i++;
    } else if (VALUE_FLAGS.has(a)) {
      out.push(a, args[++i]);
    } else if (BARE_FLAGS.has(a)) {
      out.push(a);
    } else if (a === "--pull=never") {
      out.push(a);
    } else if (a.startsWith("-")) {
      return stay(`flag ${a.split("=")[0]} is not known to the remote path`);
    } else {
      image = a;
      out.push(a);
    }
  }
  if (net !== "none") local ??= `network ${net ?? "default"} stays on this host`;
  return { local: image ? local : "no image", image, args: out };
}

// Quote one word for /bin/sh.
export function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// ---- REST client

function client(c) {
  const API = c.apiUrl;
  const auth = { Authorization: `Bearer ${c.apiKey}` };
  async function call(method, url, body, { raw = false, timeoutMs = 60_000, cap = 0 } = {}) {
    const init = { method, headers: { ...auth }, signal: AbortSignal.timeout(timeoutMs) };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
    // The server URL may hold a user name, password or query: no error,
    // cause or echoed body keeps it (redact-url.mjs).
    let r;
    try {
      r = await fetch(url, init);
    } catch (err) {
      throw scrubError(err, API);
    }
    if (!r.ok) {
      // `cap` marks a call to a free-roam machine. Its answer is the child's
      // text and may be huge, so an error does not read it.
      if (cap) r.body?.cancel().catch(() => {});
      const text = cap ? "" : (await r.text()).slice(0, 300);
      const e = new Error(scrubUrl(`Daytona ${method} ${url.replace(/\?.*/, "")} -> ${r.status}: ${text}`, API));
      e.status = r.status;
      throw e;
    }
    if (cap) return cappedExec(r, cap);
    if (raw) return Buffer.from(await r.arrayBuffer());
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  }
  return {
    account: roamAccountBinding(c),
    getSnapshot: (name) => call("GET", `${API}/snapshots/${encodeURIComponent(name)}`),
    createSnapshot: (name) => call("POST", `${API}/snapshots`, {
      name, imageName: SNAPSHOT_IMAGE, sandboxClass: "linux-vm", cpu: 2, memory: 4, disk: 10, regionId: c.target,
    }),
    // Create can block for minutes when the region is busy.
    // The defaults are for a confined tool machine: it holds no state, so it
    // stops after 15 idle minutes and is deleted when it stops.
    create: (labels, { snapshot = c.snapshot, stopMin = IDLE_STOP_MIN, deleteMin = 0 } = {}) => call("POST", `${API}/sandbox`, {
      snapshot, target: c.target, user: "root", labels,
      autoStopInterval: stopMin, autoDeleteInterval: deleteMin,
    }, { timeoutMs: 300_000 }),
    byLabel: (labels) => call("GET", `${API}/sandbox?labels=${encodeURIComponent(JSON.stringify(labels))}`),
    get: (id) => call("GET", `${API}/sandbox/${id}`),
    remove: (id) => call("DELETE", `${API}/sandbox/${id}`),
    exec: async (m, command, seconds) => daytonaExecution(await call("POST", `${m.toolbox}/process/execute`, { command, timeout: seconds },
      { timeoutMs: (seconds + 30) * 1000 })),
    // The same call for a free-roam machine: the answer is read with a size limit.
    roamExec: async (m, command, seconds) => daytonaExecution(await call("POST", `${m.toolbox}/process/execute`, { command, timeout: seconds },
      { timeoutMs: (seconds + 30) * 1000, cap: ROAM_ANSWER_BYTES })),
    upload: (m, path, buf) => {
      const form = new FormData();
      form.append("file", new Blob([buf]), "f");
      return call("POST", `${m.toolbox}/files/upload-v2?path=${encodeURIComponent(path)}`, form, { timeoutMs: 600_000 });
    },
    download: (m, path) => call("GET", `${m.toolbox}/files/download?path=${encodeURIComponent(path)}`, undefined,
      { raw: true, timeoutMs: 600_000 }),
  };
}

// ---- Machines

// The dockerd in the image does not start by itself. Start it and wait for it.
const START_DOCKER = `sh -c '(pgrep dockerd >/dev/null || (nohup dockerd-entrypoint.sh dockerd >/var/log/dockerd.log 2>&1 &)); for i in $(seq 1 60); do docker info >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1'`;

const machines = new Map(); // pool key -> Promise<machine>
let snapshotReady = null;

// The run workspace a path belongs to. Null for a scratch dir outside any run.
// Inside the tmp base, only a makeWorkspace dir (`<tmp>/redteam-run-*`)
// counts. A .touchstone.json there means nothing: a target repo can commit
// one, and a pack scan copies the repo into its own tmp scratch dir. So a
// touchstone-scan-*, infra-scan-* or touchstone-evidence-* dir is never a run.
// The walk also never goes past the tmp base.
// Outside tmp (a real operator repo), the nearest dir (itself or a parent)
// holding .touchstone.json is the run root.
export function runRoot(dir, tmp = tmpdir()) {
  if (!dir) return null;
  let d = resolve(dir);
  const base = resolve(tmp);
  const rel = relative(base, d);
  if (rel === "") return null;
  if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
    const top = rel.split(sep)[0];
    return top.startsWith("redteam-run-") ? join(base, top) : null;
  }
  for (;;) {
    if (existsSync(join(d, ".touchstone.json"))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

// Keep the existing capped toolbox transport, but use the bounded shell API
// for account metadata and cleanup reconciliation.
function roamClient(config) {
  const api = daytonaShellApi(config);
  return { ...client(config), get: api.sandbox, remove: api.removeSandbox, byLabel: async (labels) => ({ items: await api.sandboxes(labels) }) };
}

const sidecar = (root) => `${root}.daytona.json`;

function readSidecar(root) {
  try {
    const text = readFileSync(sidecar(root), "utf8");
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error();
    const all = JSON.parse(text);
    if (!all || Array.isArray(all) || typeof all !== "object" || Object.entries(all).some(([key, m]) => !m || !controlId(m.id) || (key.startsWith("roam:") && typeof m.toolbox !== "string"))) throw new Error();
    return all;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw daytonaError("daytona_response_invalid");
  }
}

function changeSidecar(root, fn) {
  return withStoreLock(sidecar(root), "Daytona machines", () => {
    const all = readSidecar(root);
    fn(all);
    if (Object.keys(all).length) saveStore(sidecar(root), all, { mode: 0o600 });
    else rmSync(sidecar(root), { force: true });
  });
}

async function cleanupRoamOperation(op, api) {
  if (!op || ["complete", "rejected"].includes(op.phase)) return false;
  updateRoamOperation(op.binding, op.id, op.phase, "cleanup");
  op = { ...op, phase: "cleanup" };
  let id = op.resourceId;
  if (!id) {
    const labels = { touchstone: "1", nonce: op.nonce, loadout: "free-roam", run: op.run.slice(0, 12) };
    const result = await api.byLabel(labels);
    const matches = (result?.items ?? []).filter((m) => Object.entries(labels).every(([k, v]) => m.labels?.[k] === v));
    if (matches.length !== 1 || !controlId(matches[0].id)) return false;
    id = matches[0].id;
  }
  updateRoamOperation(op.binding, op.id, op.phase, "cleanup", id);
  try {
    try { await api.remove(id); } catch (error) { if (error.status !== 404) throw error; }
    await confirmDaytonaDeletion(() => api.get(id));
  } catch { return false; }
  updateRoamOperation(op.binding, op.id, "cleanup", "complete");
  return true;
}

// Find or make the machine for this call, in run `root`. A machine idle for a
// while may have stopped by itself (autoStopInterval). Check it, and open a new
// one if so. Each run gets its own machines, and closeRun deletes them.
async function machineFor(c, root) {
  const agent = currentAgent() || "root";
  const key = `${root}|${agent}`;
  if (!machines.has(key)) {
    const p = openMachine(c, root, agent);
    machines.set(key, p);
    p.catch(() => machines.delete(key));
  }
  const m = await machines.get(key);
  if (m.api.account !== roamAccountBinding(c)) throw daytonaError("daytona_shell_unverified");
  m.key = key;
  if (Date.now() - m.used > staleMs() && !(await alive(m))) {
    retire(m);
    return machineFor(c, root);
  }
  return m;
}

// Drop a machine from the caches, so the next call opens it again.
function forget(m) {
  if (m?.key && machines.has(m.key)) machines.delete(m.key);
}

// Drop a broken machine for good: out of the caches and the sidecar, then
// deleted. The next call opens a new one. An id Daytona will not delete yet
// goes to the pending file, so closeRun retries it.
function retire(m) {
  forget(m);
  if (m.agent?.startsWith("roam:")) {
    // The journal already holds this obligation, including after the workspace
    // goes away. Keep the client captured when the machine was created.
    const op = allRoamOperations().find((o) => o.id === m.operationId && o.account === m.account);
    if (!op) return; // Legacy, unbound records stay in the sidecar for repair.
    return cleanupRoamOperation(op, m.api).then((gone) => {
      if (gone && m.root) changeSidecar(m.root, (all) => { if (all[m.agent]?.id === m.id) delete all[m.agent]; });
    }).catch(() => {});
    return;
  }
  recordPendingMachine(m.id, m.api.account);
  if (m.root) changeSidecar(m.root, (all) => { if (all[m.agent]?.id === m.id) delete all[m.agent]; });
  deleteMachine(m.api, m.id).then((gone) => { if (gone) clearPendingMachines([{ id: m.id, account: m.api.account }]); }).catch(() => {});
}

// True when the machine can still take calls. A 404 means it is gone.
async function alive(m) {
  try {
    const s = await m.api.get(m.id);
    return ["started", "creating", "starting"].includes(s?.state);
  } catch (e) {
    if (e.status === 404) return false;
    throw e;
  }
}

async function openMachine(c, root, agent) {
  const api = client(c);
  const known = root ? readSidecar(root)[agent] : null;
  if (known) {
    if (known.account !== api.account) throw daytonaError("daytona_shell_unverified");
    // Another process of this run (the pre-pass in the app server) made it.
    const m = { id: known.id, toolbox: known.toolbox, api, synced: new Map(), ready: new Set(), lock: Promise.resolve(), used: Date.now(), root, agent };
    try {
      const s = await api.get(m.id);
      if (!["started", "creating", "starting"].includes(s?.state)) throw new Error(s?.state);
      await waitReady(m);
      return m;
    } catch {
      // It stopped or was deleted. Make a new one.
    }
  }
  snapshotReady ??= ensureSnapshot(api, c.snapshot).catch((e) => { snapshotReady = null; throw e; });
  await snapshotReady;
  // The nonce finds the machine again if create times out after Daytona made it.
  const nonce = randomBytes(6).toString("hex");
  const labels = { touchstone: "1", agent: String(agent).slice(0, 60), nonce };
  if (root) labels.run = createHash("sha256").update(root).digest("hex").slice(0, 12);
  let sb;
  try {
    sb = await api.create(labels);
  } catch (e) {
    api.byLabel({ touchstone: "1", nonce }).then((r) => {
      for (const x of r?.items ?? r ?? []) {
        if (x?.labels?.nonce === nonce) {
          recordPendingMachine(x.id, api.account);
          deleteMachine(api, x.id).then((ok) => { if (ok) clearPendingMachines([{ id: x.id, account: api.account }]); }).catch(() => {});
        }
      }
    }).catch(() => {});
    throw e;
  }
  const m = { id: sb.id, toolbox: `${sb.toolboxProxyUrl}/${sb.id}`, api, synced: new Map(), ready: new Set(), lock: Promise.resolve(), used: Date.now(), root, agent };
  changeSidecar(root, (all) => { all[agent] = { id: m.id, toolbox: m.toolbox, account: api.account }; });
  event("exec-machine", { backend: "daytona", sandbox: m.id, run: labels.run ?? null });
  await waitReady(m);
  return m;
}

// The toolbox answers once the VM is up, sometimes before the API says
// "started". Poll it, then start dockerd.
async function waitReady(m) {
  let last;
  for (let i = 0; i < 90; i++) {
    try {
      const r = await m.api.exec(m, START_DOCKER, 90);
      if (r.exitCode === 0) return;
      last = new Error(`dockerd did not start: ${String(r.result).slice(-200)}`);
    } catch (e) {
      last = e;
      if (e.status === 404) throw e;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw last ?? new Error("Daytona machine not ready");
}

async function ensureSnapshot(api, name) {
  try {
    const s = await api.getSnapshot(name);
    if (s?.state === "active") return;
  } catch (e) {
    if (e.status !== 404) throw e;
    await api.createSnapshot(name);
  }
  for (let i = 0; i < 120; i++) {
    const s = await api.getSnapshot(name);
    if (s?.state === "active") return;
    if (/error|fail/.test(String(s?.state))) throw new Error(`Daytona snapshot ${name}: ${s.state}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Daytona snapshot ${name} not active`);
}

// One call at a time per machine. The pack already serializes its calls; this
// guards the case where two of them share a machine anyway.
function locked(m, fn) {
  const next = m.lock.then(fn, fn);
  m.lock = next.catch(() => {});
  return next;
}

// Delete every machine of a run. Called from cleanupWorkspace(ws).
// Returns the ids that are gone. Daytona refuses to delete a machine while it
// is still starting (409). An id that stays undeletable goes to the pending
// file, and every later closeRun tries it again. Nothing is dropped silently.
export async function closeRun(ws) {
  const root = resolve(ws);
  const all = readSidecar(root);
  const config = execConfig();
  const account = roamAccountBinding(config);
  const runHash = createHash("sha256").update(root).digest("hex");
  const captured = new Map();
  for (const [key, promise] of machines) {
    if (!key.startsWith(`${root}|`)) continue;
    try { const m = await promise; captured.set(m.id, m); } catch {}
  }
  const obligations = allRoamOperations().filter((o) => o.action === "runtime" && (o.run === runHash || o.phase === "cleanup") && !["complete", "rejected"].includes(o.phase));
  const gone = [];
  for (const op of obligations) {
    const m = captured.get(op.resourceId);
    if (!m && (op.account !== account || !config.apiKey)) continue;
    try { if (await cleanupRoamOperation(op, m?.api ?? roamClient(config))) gone.push(op.resourceId); } catch {}
  }
  // New confined records also carry their original account. Bare legacy IDs
  // cannot establish ownership, so they remain unresolved without a DELETE.
  for (const [key, entry] of Object.entries(all)) {
    if (!key.startsWith("roam:")) recordPendingMachine(entry.id, entry.account ?? null);
  }
  const done = [];
  for (const row of pendingMachines()) {
    if (typeof row === "string") continue;
    const m = captured.get(row.id);
    const api = m?.api.account === row.account ? m.api : row.account === account && config.apiKey ? client(config) : null;
    if (!api) continue;
    if (await deleteMachine(api, row.id, all && Object.values(all).some((v) => v.id === row.id) ? 10 : 1)) { done.push(row); gone.push(row.id); }
  }
  if (done.length) clearPendingMachines(done);
  const complete = new Set(allRoamOperations().filter((o) => o.phase === "complete").map((o) => o.id));
  if (Object.keys(all).length) changeSidecar(root, (entries) => {
    for (const [key, entry] of Object.entries(entries)) {
      if (key.startsWith("roam:") ? complete.has(entry.operationId) : Boolean(entry.account)) delete entries[key];
    }
  });
  for (const key of [...machines.keys()]) if (key.startsWith(`${root}|`)) machines.delete(key);
  const unresolved = pendingMachines().length;
  if (unresolved) event("exec-cleanup", { backend: "daytona", pending: unresolved, note: "Cleanup remains unresolved; legacy IDs require their original account to be established." });
  const ownIds = new Set(Object.values(all).map((m) => m.id));
  return gone.filter((id) => id && ownIds.has(id));
}

// True when the machine is gone.
async function deleteMachine(api, id, tries = 10) {
  for (let i = 0; i < tries; i++) {
    try {
      await api.remove(id);
      return true;
    } catch (e) {
      if (e.status === 404) return true;
      // 409: the machine is still starting. Wait and try again.
      if (i < tries - 1) await new Promise((r) => setTimeout(r, Number(process.env.DAYTONA_RETRY_MS) || 3000));
    }
  }
  return false;
}

// Compatibility for callers that display pending IDs. Deletion uses only the
// account-bound records above; this view cannot authorize an API request.
export function readPending() {
  return pendingMachines().map((r) => typeof r === "string" ? r : r.id);
}

// ---- Workspace sync

// Every entry under dir, as path -> signature. A file is "size:mtime". A
// directory is "dir", so empty ones are copied too. Symlinks count as files.
export function scan(dir) {
  const out = new Map();
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      const rel = relative(dir, p).split(sep).join("/");
      if (st.isDirectory()) {
        out.set(rel, "dir");
        walk(p);
      } else out.set(rel, `${st.size}:${Math.round(st.mtimeMs)}`);
    }
  };
  if (dir && existsSync(dir)) walk(dir);
  return out;
}

// What to send: files that are new or changed since the last sync, and files
// that are gone. An empty `before` means the machine has nothing yet.
export function delta(before, now) {
  const send = [];
  const gone = [];
  for (const [p, sig] of now) if (before.get(p) !== sig) send.push(p);
  for (const p of before.keys()) if (!now.has(p)) gone.push(p);
  return { send, gone };
}

function hostTar(args, input) {
  return new Promise((done, fail) => {
    const child = execFile("tar", args, { maxBuffer: 1024 * 1024 * 1024, encoding: "buffer" }, (err, stdout, stderr) => {
      if (err) fail(new Error(`tar ${args[0]}: ${String(stderr).slice(-300)}`));
      else done(stdout);
    });
    child.stdin.end(input);
  });
}

function hostDocker(args, timeoutMs, opts = {}) {
  return new Promise((done) => {
    execFile("docker", args, { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 * 1024, encoding: "buffer", ...opts }, (err, stdout) => {
      done({ ok: !err, stdout });
    });
  });
}

// ---- One remote docker run

// Run one `docker run` argv on Daytona. Resolves with the local runTool shape,
// or null when the call must run on this host instead.
//   args        the argv after "docker"
//   ws          the workspace the call may mount at /work (or null)
//   timeoutMs   the tool's time limit
//   maxBuffer   stdout/stderr limit, like execFile
//   owner       "uid:gid" that owns the remote workspace copy
//   pullBack    copy changed workspace files back (default on)
//   skipBack    top-level dirs not to copy back
//   warm        solc versions the machine needs before this call
//   root        the calling run's workspace, when ws is a dir outside it
export async function remoteDocker(args, { ws = null, timeoutMs = 180_000, maxBuffer = 64 * 1024 * 1024, owner, pullBack = true, skipBack = [], warm = [], root = null } = {}) {
  const c = execConfig();
  if (!(c.backend === "daytona" && c.apiKey)) return null;
  const wsAbs = ws ? resolve(ws) : null;
  const remoteWs = wsAbs ? `/ts/w/${createHash("sha256").update(wsAbs).digest("hex").slice(0, 16)}` : null;
  const plan = planRemote(args, wsAbs, remoteWs);
  if (plan.local) {
    event("exec-fallback", { backend: "local", reason: plan.local, image: plan.image });
    return null;
  }
  // Every machine belongs to one run, so closeRun deletes it. A call with no
  // run would need a machine no run owns. It runs locally instead.
  const run = (root && runRoot(root)) || runRoot(wsAbs);
  if (!run) {
    event("exec-fallback", { backend: "local", reason: "the call belongs to no run", image: plan.image });
    return null;
  }
  if (Date.now() < downUntil) {
    event("exec-fallback", { backend: "local", reason: "Daytona failed recently", image: plan.image });
    return null;
  }
  try {
    // A failed call drops its machine and tries once more on a fresh one.
    // Only a second failure puts every call on local Docker for a while.
    for (let attempt = 0; ; attempt++) {
      const m = await machineFor(c, run);
      try {
        return await locked(m, () => runOn(m, plan, { wsAbs, remoteWs, timeoutMs, maxBuffer, owner, pullBack, skipBack, warm }));
      } catch (e) {
        // Only the solc warm failed. The machine is fine; this call runs locally.
        if (e.localOnly) {
          event("exec-fallback", { backend: "local", reason: String(e.message).slice(0, 200), image: plan.image, sandbox: m.id });
          return null;
        }
        retire(m);
        if (attempt >= 1) throw e;
        event("exec-retry", { backend: "daytona", sandbox: m.id, reason: String(e?.message ?? e).slice(0, 200), image: plan.image });
      }
    }
  } catch (e) {
    // Stay local for a while, so one outage does not start a machine per call.
    downUntil = Date.now() + DOWN_MS;
    event("exec-fallback", { backend: "local", reason: String(e?.message ?? e).slice(0, 200), image: plan.image });
    return null;
  }
}

async function runOn(m, plan, { wsAbs, remoteWs, timeoutMs, maxBuffer, owner, pullBack, skipBack, warm }) {
  const t0 = Date.now();
  const cid = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
  const dir = `/ts/r/${cid}`;
  const own = owner || `${process.getuid()}:${process.getgid()}`;

  // 1. Send the workspace delta.
  let now = null;
  let sync = { send: [], gone: [] };
  const fresh = wsAbs && !m.synced.has(wsAbs);
  if (wsAbs) {
    now = scan(wsAbs);
    sync = delta(m.synced.get(wsAbs) ?? new Map(), now);
    if (sync.send.length) {
      const tar = await hostTar(["-cf", "-", "-C", wsAbs, "--no-recursion", "--null", "-T", "-"], Buffer.from(sync.send.map((p) => p + "\0").join("")));
      await m.api.upload(m, `/tmp/ts-${cid}.tar`, tar);
    }
  }

  // 2. Warm solc versions this machine has not seen.
  // A failed warm means forge --offline would not find solc there. Run this
  // call locally instead; warmSolc also warms the local cache.
  for (const v of warm) {
    // warmScript checks the version too. A bad one never reaches a shell.
    if (!SOLC_VERSION.test(String(v))) {
      event("exec-warm-failed", { backend: "daytona", sandbox: m.id, solc: String(v).slice(0, 40), detail: "not an x.y.z version" });
      continue;
    }
    if (m.ready.has(`solc:${v}`)) continue;
    if (m.ready.has(`nosolc:${v}`)) throw Object.assign(new Error(`solc ${v} did not install on Daytona`), { localOnly: true });
    const r = await m.api.exec(m, `sh -c ${shq(warmScript(v))}`, 300);
    if (r.exitCode !== 0) {
      m.ready.add(`nosolc:${v}`);
      event("exec-warm-failed", { backend: "daytona", sandbox: m.id, solc: v, detail: String(r.result ?? "").slice(-200) });
      const e = new Error(`solc ${v} did not install on Daytona`);
      e.localOnly = true;
      throw e;
    }
    m.ready.add(`solc:${v}`);
  }

  // 3. Run. The script extracts the delta, runs the container under a
  // watchdog, and packs the output and the changed files into one tar.
  const name = `ts-${cid}`;
  const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
  const argv = ["docker", "run", "--name", name, ...plan.args].map(shq).join(" ");
  const rmGone = sync.gone.map((p) => shq(p)).join(" ");
  const script = [
    "set -u",
    `mkdir -p ${dir}`,
    remoteWs ? (fresh ? `rm -rf ${remoteWs}; mkdir -p ${remoteWs}` : `mkdir -p ${remoteWs}`) : ":",
    remoteWs && rmGone ? `(cd ${remoteWs} && rm -rf -- ${rmGone})` : ":",
    remoteWs && sync.send.length ? `tar -xf /tmp/ts-${cid}.tar -C ${remoteWs} && rm -f /tmp/ts-${cid}.tar` : ":",
    remoteWs ? `chown -R ${shq(own)} ${remoteWs}` : ":",
    // Pull outside the time limit, as a local warm cache would, unless the
    // argv says --pull=never. Code 199 sends the image up from this host.
    `touch ${dir}/stamp`,
    imageGuard(plan.args, plan.image, dir),
    `touch ${dir}/stamp; sleep 1`,
    // The watchdog checks once a second. Its stdio is closed, so the toolbox
    // does not wait for it.
    `(i=0; while [ $i -lt ${secs} ]; do sleep 1; i=$((i+1)); [ -e ${dir}/done ] && exit 0; done; docker kill ${name} && touch ${dir}/timedout) </dev/null >/dev/null 2>&1 &`,
    `${argv} </dev/null >${dir}/out 2>${dir}/err; echo $? >${dir}/code`,
    `touch ${dir}/done; docker rm -f ${name} >/dev/null 2>&1`,
    `else echo 199 >${dir}/code; fi`,
    `mkdir -p ${dir}/pack/meta ${dir}/pack/ws`,
    `for f in out err code timedout pulled; do [ -e ${dir}/$f ] && cp ${dir}/$f ${dir}/pack/meta/; done`,
    // Copy the changed files with find -exec. Names go as arguments, so a
    // name that starts with "-" or holds a newline is safe. BusyBox tar has
    // no --null, so a tar -T file list would not be.
    remoteWs && pullBack
      ? `(cd ${remoteWs} && find . -type f -newer ${dir}/stamp ${skipBack.map((d) => `! -path ${shq(`./${d}/*`)}`).join(" ")} -exec sh -c 'for f; do mkdir -p "$0/$(dirname "$f")" && cp -p "$f" "$0/$f"; done' ${dir}/pack/ws {} +)`
      : ":",
    `tar -cf ${dir}/res.tar -C ${dir}/pack .`,
  ].join("\n");
  const b64 = Buffer.from(script).toString("base64");
  const ex = await m.api.exec(m, `sh -c ${shq(`echo ${b64} | base64 -d >/tmp/ts-${cid}.sh && sh /tmp/ts-${cid}.sh`)}`, secs + 900);
  if (ex.exitCode !== 0) throw new Error(`remote script failed: ${String(ex.result).slice(-300)}`);

  const res = await m.api.download(m, `${dir}/res.tar`);
  m.used = Date.now();
  m.api.exec(m, `rm -rf ${dir} /tmp/ts-${cid}.sh`, 30).catch(() => {});
  const files = await unpack(res);
  const code = Number(String(files.get("meta/code") ?? "1").trim());
  if (files.has("meta/pulled")) event("exec-pull", { backend: "daytona", sandbox: m.id, image: plan.image });
  if (code === 199) {
    // A pinned, marked image the machine could not pull: a failed call (retry on
    // a fresh machine, then local), never an upload from this host.
    if (MACHINE_PULL.has(plan.image)) throw new Error(`the machine could not pull ${plan.image}`);
    // The image is not on any registry the machine can reach: a locally built
    // image. Copy it up from this host once, then run again.
    if (m.ready.has(`img:${plan.image}`)) throw new Error(`image ${plan.image} not available on Daytona`);
    await pushImage(m, plan.image);
    m.ready.add(`img:${plan.image}`);
    m.synced.set(wsAbs, now);
    return runOn(m, plan, { wsAbs, remoteWs, timeoutMs, maxBuffer, owner, pullBack, skipBack, warm });
  }

  // 4. Take the changed files back.
  if (wsAbs) {
    const back = [...files.keys()].some((k) => k.startsWith("ws/"));
    if (back) await hostTar(["-xf", "-", "-C", wsAbs, "--strip-components=2", "--wildcards", "./ws/*"], res);
    m.synced.set(wsAbs, back ? scan(wsAbs) : now);
    // Keep the copy of the run workspace itself: later calls send only the
    // changes, and the machine goes when the run closes. Delete the copy of
    // any other dir (a fuzz scratch dir) now. Wait for it, so the next call
    // on this machine does not race the delete.
    if (wsAbs !== m.root) {
      m.synced.delete(wsAbs);
      await m.api.exec(m, `rm -rf ${remoteWs}`, 30).catch(() => {});
    }
  }
  const timedOut = files.has("meta/timedout");
  const stdout = clip(files.get("meta/out"), maxBuffer);
  const stderr = clip(files.get("meta/err"), maxBuffer);
  // Like the local path: output above maxBuffer is cut, and the caller must know.
  const overflow = [files.get("meta/out"), files.get("meta/err")].some((buf) => (buf ? buf.toString("utf8").length : 0) > maxBuffer);
  // A local timeout reports code 1, so this does too.
  const result = { code: timedOut ? 1 : code, stdout, stderr, timedOut, overflow };
  event("exec", { backend: "daytona", sandbox: m.id, image: plan.image, code: result.code, ms: Date.now() - t0, synced: sync.send.length });
  return result;
}

function clip(buf, max) {
  const s = buf ? buf.toString("utf8") : "";
  return s.length > max ? s.slice(0, max) : s;
}

// Read a tar into path -> Buffer for the small meta files, and note ws paths.
async function unpack(tar) {
  const out = new Map();
  let off = 0;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const field = (a, b) => h.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
    let name = field(0, 100);
    const prefix = field(345, 500);
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(field(124, 136).trim() || "0", 8);
    const type = String.fromCharCode(h[156]);
    off += 512;
    const clean = name.replace(/^\.\//, "");
    if ((type === "0" || type === "\0") && clean) out.set(clean, clean.startsWith("meta/") ? Buffer.from(tar.subarray(off, off + size)) : null);
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

async function pushImage(m, image) {
  const saved = await hostDocker(["save", image], 600_000);
  if (!saved.ok) throw new Error(`image ${image} is not on a registry and not on this host`);
  const path = `/tmp/ts-img-${randomBytes(4).toString("hex")}.tar`;
  await m.api.upload(m, path, saved.stdout);
  const r = await m.api.exec(m, `sh -c ${shq(`docker load -i ${path} >/dev/null && rm -f ${path}`)}`, 600);
  if (r.exitCode !== 0) throw new Error(`docker load failed: ${String(r.result).slice(-200)}`);
}

// ---- Foundry on the machine

const FOUNDRY_IMG = "ghcr.io/foundry-rs/foundry:latest@sha256:3a392c18f9b16e665e932de159fb6fa9ed972c4b4352f2f76a1a8c7ca9b57d39";

// A solc version we pass to a shell: digits and dots only.
export const SOLC_VERSION = /^\d+\.\d+\.\d+$/;

// Put one solc version into the machine's foundry-svm volume, with network.
// The first call also makes the volume and hands it to the foundry user.
// v comes from the workspace's .touchstone.json, which a target or a
// container may write. So it must be a plain x.y.z, and it is quoted too.
export function warmScript(v) {
  if (!SOLC_VERSION.test(String(v))) throw new Error(`not a solc version: ${String(v).slice(0, 40)}`);
  const img = shq(FOUNDRY_IMG);
  return [
    "set -e",
    `V=${shq(v)}`,
    `docker volume inspect foundry-svm >/dev/null 2>&1 || { docker volume create foundry-svm >/dev/null; docker run --rm -u 0 --entrypoint sh -v foundry-svm:/svm ${img} -c 'chown 1000:1000 /svm'; }`,
    `D=$(mktemp -d); mkdir -p "$D/src"; chmod -R 777 "$D"`,
    `printf '[profile.default]\\nsrc = "src"\\nout = "out"\\n' >"$D/foundry.toml"`,
    `printf '// SPDX-License-Identifier: MIT\\npragma solidity %s;\\ncontract W {}\\n' "$V" >"$D/src/W.sol"`,
    `rc=0; docker run --rm -v foundry-svm:/home/foundry/.svm -v "$D:/work" -w /work ${img} "forge build --use $V" >"$D.log" 2>&1 || rc=$?`,
    `rm -rf "$D"; [ $rc -eq 0 ] || tail -c 400 "$D.log"; rm -f "$D.log"; exit $rc`,
  ].join("\n");
}

// ---- Free-roam machine (Wave 4, I1)
//
// One container machine per free-roam child, kept for the whole run. It is
// not the confined tool machine: no Docker, no workspace copy, open network.
// - Sidecar key `roam:<agent>`, so closeRun deletes it like every other machine.
// - It never runs on this computer. Without Daytona, roamMachine throws.
// - It stops after 60 idle minutes and is deleted 240 minutes after that. This
//   is only the backstop for a leak; closeRun is the normal delete. Never 0
//   here: 0 deletes the child's files at the first stop.
// - A machine that stopped or is gone is replaced by an empty one, and the
//   caller is told (`replaced`). Nothing starts a stopped machine again.
// - Creation uses the saved, tested shell snapshot. Settings owns explicit
//   snapshot builds; runtime calls never register one.
const ROAM_STOP_MIN = 60;
const ROAM_DELETE_MIN = 240;
// Bound retained response bytes, not decoded strings or the transport's current chunk.
const ROAM_ANSWER_BYTES = 4 * 1024 * 1024;

// Retain a fixed `max`-byte tail and a separate 64-byte prefix. For a larger
// answer, exitCode is known only when it stands at the start or end of the JSON.
async function cappedExec(r, max) {
  const tail = Buffer.alloc(max);
  const first = Buffer.alloc(64);
  let prefix = 0;
  let at = 0;
  let total = 0;
  for await (const chunk of r.body ?? []) {
    const n = Math.min(first.length - prefix, chunk.length);
    first.set(chunk.subarray(0, n), prefix);
    prefix += n;
    total += chunk.length;
    if (chunk.length >= max) {
      tail.set(chunk.subarray(chunk.length - max));
      at = 0;
    } else {
      const end = Math.min(chunk.length, max - at);
      tail.set(chunk.subarray(0, end), at);
      tail.set(chunk.subarray(end), 0);
      at = (at + chunk.length) % max;
    }
  }
  if (total <= max) return total ? JSON.parse(new TextDecoder().decode(tail.subarray(0, total))) : null;
  // Rotate the ring in place; do not allocate another response-sized buffer.
  tail.subarray(0, at).reverse();
  tail.subarray(at).reverse();
  tail.reverse();
  const s = tail.toString("utf8");
  // Parse only the retained metadata around result. A fallback code may never
  // override an authoritative exitCode, including an explicitly invalid one.
  const start = first.toString("utf8");
  const resultAt = start.search(/"result"\s*:/);
  let before;
  try {
    if (resultAt < 0) throw new Error();
    before = JSON.parse(`${start.slice(0, resultAt)}"result":""}`);
  } catch { throw daytonaError("daytona_response_invalid"); }
  const suffixStart = Math.max(0, s.length - 1024);
  const suffix = s.slice(suffixStart).match(/"\s*,\s*("(?:exitCode|code)"[\s\S]*)\}\s*$/);
  let after = {};
  if (suffix) {
    try { after = JSON.parse(`{${suffix[1]}}`); }
    catch { throw daytonaError("daytona_response_invalid"); }
  }
  const status = daytonaExecution({ ...before, ...after, result: "" }).exitCode;
  const end = suffix ? suffixStart + suffix.index : s.search(/"\s*\}\s*$/);
  // The cut may fall inside an escape. Skip a few characters until the rest reads.
  for (let k = 0; end > 0 && k < 8; k++) {
    try { return { exitCode: status, result: JSON.parse(`"${s.slice(k, end)}"`) }; } catch {}
  }
  return { exitCode: status, result: "" };
}

// The machine of one free-roam child, opened on first use.
//   -> { id, fresh, replaced, exec(command, seconds) -> { exitCode, result }, upload(path, bytes) }
//   fresh     this call created or replaced the machine
//   replaced  an older machine of this agent was lost (stopped, destroyed or 404)
// `exec` sends one command string to the machine. Nothing else from this host
// goes there: no environment, no file, no key.
export async function roamMachine(ws, agent) {
  const c = execConfig();
  if (!(c.backend === "daytona" && c.apiKey)) throw new Error("Free-roam needs the Daytona backend and its key. It never runs on this computer.");
  if (!agent) throw new Error("A free-roam machine belongs to one child agent. No agent was given.");
  const root = resolve(ws);
  const key = `${root}|roam:${agent}`;
  let opened = false;
  let lost = false;
  let m;
  for (;;) {
    let p = machines.get(key);
    if (!p) {
      opened = true;
      p = openRoam(c, root, agent, key, lost);
      machines.set(key, p);
      const mine = p;
      p.catch(() => machines.get(key) === mine && machines.delete(key));
    }
    m = await p;
    if (m.account !== roamAccountBinding(c) || m.binding !== roamBinding(c)) throw daytonaError("daytona_shell_unverified");
    if (opened || Date.now() - m.used <= staleMs() || (await alive(m))) break;
    // It stopped by itself or it is gone. Open a new one, and say so.
    if (machines.get(key) === p) await retire(m);
    lost = true;
  }
  return {
    id: m.id,
    fresh: opened && m.created,
    replaced: opened && m.replaced,
    exec: async (command, seconds) => {
      try {
        const r = await m.api.roamExec(m, command, seconds);
        m.used = Date.now();
        return { exitCode: r?.exitCode, result: String(r?.result ?? "") };
      } catch (e) {
        m.used = 0; // the next call checks the machine's state first
        throw e;
      }
    },
    upload: (path, bytes) => m.api.upload(m, path, bytes),
  };
}

async function openRoam(c, root, agent, key, lost) {
  const api = roamClient(c);
  const tag = `roam:${agent}`;
  const known = readSidecar(root)[tag];
  if (known) {
    if (known.account !== roamAccountBinding(c) || known.binding !== roamBinding(c)) throw daytonaError("daytona_shell_unverified");
    // An earlier worker of this run made it. It has no cache key, so retire
    // does not drop the entry of this very call.
    const old = { ...known, api, root, agent: tag, used: Date.now(), created: false, replaced: false };
    if (await alive(old)) {
      await roamReady(old);
      old.key = key;
      return old;
    }
    await retire(old);
    lost = true;
  }
  requireRoamReady(c);
  await checkRoamSelection(c);
  const selection = requireRoamReady(c);
  const binding = roamBinding(c);
  const runHash = createHash("sha256").update(root).digest("hex");
  const run = runHash.slice(0, 12);
  const slot = createHash("sha256").update(JSON.stringify([root, agent])).digest("hex");
  const { operation, created } = beginRoamOperation(c, "runtime", slot, { run: runHash });
  const labels = { touchstone: "1", agent: String(agent).slice(0, 60), nonce: operation.nonce, run, loadout: "free-roam" };
  const shellApi = daytonaShellApi(c);
  let sb;
  if (!created) {
    if (!["intent", "unknown", "created"].includes(operation.phase)) throw daytonaError("daytona_unreachable");
    const matches = (await shellApi.sandboxes(labels)).filter((s) => Object.entries(labels).every(([name, value]) => s?.labels?.[name] === value));
    // Empty eventually-consistent listing is not permission to repeat a POST.
    if (matches.length !== 1) throw daytonaError("daytona_unreachable");
    sb = matches[0];
  } else {
    try {
      sb = await shellApi.createSandbox(labels, selection.snapshotId, { stopMin: ROAM_STOP_MIN, deleteMin: ROAM_DELETE_MIN });
    } catch (e) {
      if (e.code === "daytona_snapshot_unavailable" || e.code === "daytona_rejected") {
        setRoamSelectionState(binding, e.code === "daytona_snapshot_unavailable" ? "unavailable" : "rejected");
        updateRoamOperation(binding, operation.id, "intent", "rejected");
      } else {
        updateRoamOperation(binding, operation.id, "intent", "unknown");
      }
      throw e;
    }
  }
  if (!controlId(sb?.id) || typeof sb.toolboxProxyUrl !== "string" || sb.toolboxProxyUrl.length > 2048 || !safeUrl(sb.toolboxProxyUrl)) {
    if (created) updateRoamOperation(binding, operation.id, "intent", "unknown");
    throw daytonaError("daytona_response_invalid");
  }
  if (operation.phase !== "created") updateRoamOperation(binding, operation.id, operation.phase, "created", sb.id);
  const m = { id: sb.id, toolbox: `${sb.toolboxProxyUrl.replace(/\/$/, "")}/${sb.id}`, account: roamAccountBinding(c), binding, operationId: operation.id, api, root, agent: tag, key, used: Date.now(), created, replaced: lost };
  changeSidecar(root, (all) => { all[tag] = { id: m.id, toolbox: m.toolbox, account: m.account, binding, operationId: operation.id }; });
  event("exec-machine", { backend: "daytona", sandbox: m.id, run, loadout: "free-roam", ...(lost ? { replaced: true } : {}) });
  await roamReady(m);
  return m;
}

// The toolbox answers once the machine is up. A container machine has no
// dockerd, so the check is `true`, not START_DOCKER. The error is a fixed
// text: what the toolbox answered comes from the child's machine, and the
// model reads this error.
async function roamReady(m) {
  let why = "no answer";
  for (let i = 0; i < 60; i++) {
    try {
      const r = await m.api.roamExec(m, "true", 30);
      if (r?.exitCode === 0) return;
      why = "the check command failed";
    } catch (e) {
      why = Number.isInteger(e?.status) ? `HTTP ${e.status}` : "no answer";
      if (e?.status === 404) break;
    }
    await new Promise((r) => setTimeout(r, Number(process.env.DAYTONA_RETRY_MS) || 2000));
  }
  throw new Error(`The free-roam machine is not ready (${why}).`);
}

// ---- Server-only desktop and artifact control. Never offered as agent tools.
const CONTROL_ERROR = "The free-roam control request failed.";
const CONTROL_LIMIT = 64 * 1024;
const DESKTOP_LIMIT = 8192;
const DESKTOP_ENTRY = "/opt/touchstone/roam/desktop/entry.mjs";
const controlId = (s) => typeof s === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(s);
const controlPort = (n) => Number.isInteger(n) && n >= 1 && n <= 65535;
const exactKeys = (o, keys) => o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).sort().join(",") === [...keys].sort().join(",");
const controlOrigin = (s) => {
  try { return typeof s === "string" && s.length <= 2048 && new URL(s).protocol === "https:" && new URL(s).origin === s; } catch { return false; }
};
const controlFail = () => { throw new Error(CONTROL_ERROR); };

// Unlike the existing execution client, refuse oversized bodies rather than
// taking a tail. No response text, URL, credentials or original cause escapes.
async function controlCall(c, method, url, body, limit = CONTROL_LIMIT, raw = false) {
  let r;
  try {
    const headers = { Authorization: `Bearer ${c.apiKey}` };
    if (body !== undefined && !(body instanceof FormData)) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(body);
    }
    r = await fetch(url, { method, headers, body, redirect: "error", signal: AbortSignal.timeout(60_000) });
    if (!r.ok || r.redirected || (r.url && r.url !== url)) {
      await r.body?.cancel().catch(() => {});
      controlFail();
    }
    const bytes = Buffer.alloc(limit);
    let used = 0;
    for await (const chunk of r.body ?? []) {
      if (chunk.length > limit - used) controlFail();
      bytes.set(chunk, used);
      used += chunk.length;
    }
    const result = bytes.subarray(0, used);
    return raw ? result : used ? JSON.parse(new TextDecoder().decode(result)) : null;
  } catch {
    const error = new Error(CONTROL_ERROR);
    if (Number.isInteger(r?.status)) error.status = r.status;
    throw error;
  }
}

function desktopInput(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > DESKTOP_LIMIT) controlFail();
  const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (["configure", "status", "close"].includes(input?.action) && exactKeys(input, ["action"])) return input;
  if (input?.action !== "open" || !exactKeys(input, ["action", "previewOrigin", "appOrigins", "token", "viewOnly"]) ||
      !controlOrigin(input.previewOrigin) || !Array.isArray(input.appOrigins) || input.appOrigins.length !== 1 ||
      !controlOrigin(input.appOrigins[0]) || typeof input.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.token) || typeof input.viewOnly !== "boolean") controlFail();
  return input;
}

function desktopOutput(output, input) {
  const keys = output?.kind === "closed" ? ["kind"] : output?.kind === "configured" ? ["kind", "port", "expires"] : ["kind", "port", "expires", "viewOnly"];
  if (!exactKeys(output, keys) || !["closed", "configured", "open"].includes(output.kind)) controlFail();
  if (output.kind !== "closed" && (!controlPort(output.port) || !Number.isSafeInteger(output.expires) || output.expires <= Date.now() || output.expires > Date.now() + 900_000)) controlFail();
  if (output.kind === "open" && typeof output.viewOnly !== "boolean") controlFail();
  if (input.action !== "status" && output.kind !== ({ configure: "configured", open: "open", close: "closed" })[input.action]) controlFail();
  if (input.action === "open" && output.viewOnly !== input.viewOnly) controlFail();
  return output;
}

// Open every source path component without following symlinks. Keep directory
// descriptors pinned during the walk. A root child can still forge its evidence.
const ARTIFACT_SNAPSHOT = `const fs=require('node:fs'),crypto=require('node:crypto');
const [source,target,max]=process.argv.slice(1),limit=Number(max),fds=[];
try {
 let fd=fs.openSync('/',fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);fds.push(fd);
 const parts=source.slice(1).split('/');
 for(let i=0;i<parts.length;i++) {
  fd=fs.openSync('/proc/self/fd/'+fd+'/'+parts[i],fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|(i<parts.length-1?fs.constants.O_DIRECTORY:fs.constants.O_NONBLOCK));fds.push(fd);
 }
 const before=fs.fstatSync(fd);if(!before.isFile()||before.size>limit)throw Error();
 const data=Buffer.alloc(limit+1);let size=0,n;
 while(size<data.length&&(n=fs.readSync(fd,data,size,data.length-size,null)))size+=n;
 const after=fs.fstatSync(fd);if(size>limit||size!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw Error();
 const out=fs.openSync(target,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);fds.push(out);
 fs.writeFileSync(out,data.subarray(0,size));
 process.stdout.write(JSON.stringify({bytes:size,sha256:crypto.createHash('sha256').update(data.subarray(0,size)).digest('hex')}));
} catch {process.exitCode=1;} finally {for(const fd of fds.reverse())try{fs.closeSync(fd)}catch{}}`;

// Existing-only lookup. The app must first authorize ws + agent from its run.
// Every operation rechecks sidecar identity and control-plane ownership labels.
export async function findRoamMachine(ws, agent) {
  try {
    if (typeof ws !== "string" || !isAbsolute(ws) || !controlId(agent) || agent.length > 60) controlFail();
    const root = resolve(ws);
    const tag = `roam:${agent}`;
    const known = readSidecar(root)[tag];
    if (!known) return null;
    if (!controlId(known.id)) controlFail();
    const id = known.id;
    const c = execConfig();
    if (c.backend !== "daytona" || !c.apiKey || known.account !== roamAccountBinding(c)) controlFail();
    const base = `${c.apiUrl}/sandbox/${encodeURIComponent(id)}`;
    const run = createHash("sha256").update(root).digest("hex").slice(0, 12);
    async function current(revoking = false) {
      if (readSidecar(root)[tag]?.id !== id) controlFail();
      let s;
      try { s = await controlCall(c, "GET", base); } catch (e) { if (e.status === 404) return null; throw e; }
      if (s?.id !== id || s?.labels?.agent !== agent || s?.labels?.run !== run || s?.labels?.touchstone !== "1" || s?.labels?.loadout !== "free-roam") controlFail();
      // Revocation is a control-plane action and must still work after a stop.
      if (revoking) return true;
      if (s.state !== "started") return null;
      if (typeof s.toolboxProxyUrl !== "string" || s.toolboxProxyUrl.length > 2048 || !safeUrl(s.toolboxProxyUrl)) controlFail();
      const url = new URL(s.toolboxProxyUrl);
      if (url.href !== s.toolboxProxyUrl && url.origin !== s.toolboxProxyUrl) controlFail();
      return `${s.toolboxProxyUrl.replace(/\/$/, "")}/${encodeURIComponent(id)}`;
    }
    if (!(await current())) return null;
    async function live() { return (await current()) || controlFail(); }
    async function exec(toolbox, command) {
      const r = await controlCall(c, "POST", `${toolbox}/process/execute`, { command, timeout: 45 });
      if (r?.exitCode !== 0 || typeof r.result !== "string" || Buffer.byteLength(r.result) > DESKTOP_LIMIT) controlFail();
      return r.result;
    }
    async function privateFile(fn) {
      const toolbox = await live();
      const dir = `/tmp/touchstone-control-${randomBytes(16).toString("hex")}`;
      await exec(toolbox, `sh -c ${shq(`umask 077; mkdir -- ${shq(dir)}`)}`);
      const cleanup = `rm -rf -- ${shq(dir)}`;
      try { return await fn(toolbox, `${dir}/request`, cleanup); }
      finally { await exec(toolbox, `sh -c ${shq(cleanup)}`); }
    }
    return {
      id,
      async request(bytes) {
        try {
          const input = desktopInput(bytes);
          // Copy the validated payload before awaiting network I/O.
          const payload = Buffer.from(JSON.stringify(input));
          return await privateFile(async (toolbox, path, cleanup) => {
            const form = new FormData();
            form.append("file", new Blob([payload]), "f");
            await controlCall(c, "POST", `${toolbox}/files/upload-v2?path=${encodeURIComponent(path)}`, form);
            const command = `trap ${shq(cleanup)} EXIT HUP INT TERM; chmod 600 -- ${shq(path)} && node ${DESKTOP_ENTRY} < ${shq(path)}`;
            const result = await exec(toolbox, `sh -c ${shq(command)}`);
            return desktopOutput(JSON.parse(result), input);
          });
        } catch { controlFail(); }
      },
      async previewGrant(port, seconds = 60) {
        let issued;
        try {
          if (!controlPort(port) || !Number.isInteger(seconds) || seconds < 1 || seconds > 900) controlFail();
          await live();
          const expires = Date.now() + seconds * 1000;
          const r = await controlCall(c, "GET", `${base}/ports/${port}/signed-preview-url?expiresInSeconds=${seconds}`);
          if (r?.sandboxId === id && r?.port === port && typeof r?.token === "string" && /^[a-z0-9-]{1,57}$/.test(r.token)) issued = r.token;
          if (!exactKeys(r, ["sandboxId", "port", "token", "url"]) || r.sandboxId !== id || r.port !== port || typeof r.token !== "string" || !/^[a-z0-9-]{1,57}$/.test(r.token) || typeof r.url !== "string" || r.url.length > 2048) controlFail();
          const u = new URL(r.url);
          const labels = u.hostname.split(".");
          if (!controlOrigin(u.origin) || u.port || u.username || u.password || u.search || u.hash || (r.url !== u.origin && r.url !== `${u.origin}/`) || labels.length < 3 || labels[0] !== `${port}-${r.token}` || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || Date.now() >= expires) controlFail();
          // Never spread the API response. The revoke token stays on the server.
          return { url: r.url, expires, revokeToken: r.token };
        } catch {
          // If validation failed after issuance, revoke only the matching grant.
          if (issued) await controlCall(c, "POST", `${base}/ports/${port}/signed-preview-url/${encodeURIComponent(issued)}/expire`).catch(() => {});
          controlFail();
        }
      },
      async expirePreview(port, token) {
        try {
          if (!controlPort(port) || typeof token !== "string" || !/^[\x21-\x7e]{1,512}$/.test(token) || token === "." || token === "..") controlFail();
          if (!(await current(true))) controlFail();
          await controlCall(c, "POST", `${base}/ports/${port}/signed-preview-url/${encodeURIComponent(token)}/expire`);
        } catch { controlFail(); }
      },
      async readArtifact(path, maxBytes) {
        try {
          const cap = path === "/var/lib/touchstone/session/browser.har" ? 2 * 1024 * 1024 : /^\/var\/lib\/touchstone\/session\/shot-(?:[1-9]|1[0-2])\.png$/.test(path) ? 5 * 1024 * 1024 : 0;
          if (typeof path !== "string" || !cap || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > cap) controlFail();
          return await privateFile(async (toolbox, target) => {
            const command = `node -e ${shq(ARTIFACT_SNAPSHOT)} ${shq(path)} ${shq(target)} ${maxBytes}`;
            const receipt = JSON.parse(await exec(toolbox, command));
            if (!exactKeys(receipt, ["bytes", "sha256"]) || !Number.isInteger(receipt.bytes) || receipt.bytes < 0 || receipt.bytes > maxBytes || typeof receipt.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(receipt.sha256)) controlFail();
            const bytes = await controlCall(c, "GET", `${toolbox}/files/download?path=${encodeURIComponent(target)}`, undefined, maxBytes, true);
            if (bytes.length !== receipt.bytes || createHash("sha256").update(bytes).digest("hex") !== receipt.sha256) controlFail();
            return bytes;
          });
        } catch { controlFail(); }
      },
    };
  } catch { controlFail(); }
}
