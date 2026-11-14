// Demo-only local execution ownership. Owner-mode sandbox calls do not enter here.
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const LAUNCHER = fileURLToPath(new URL("./demo-resource-launcher.mjs", import.meta.url));
const PYTHON = fileURLToPath(new URL("./demo-processes.py", import.meta.url));
const scope = new AsyncLocalStorage();
const pending = new Map();
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{16}$/;
const BOOT = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const refusal = () => new Error("Demo execution cleanup is unresolved. New work is blocked.");
let checked = false;

export function checkDemoResourceRuntime() {
  if (checked) return;
  if (process.platform !== "linux" || execFileSync("python3", [PYTHON, "--check"], { timeout: 2000, encoding: "utf8", env: { PATH: process.env.PATH } }).trim() !== "ok") throw refusal();
  checked = true;
}
function context(value) {
  if (!value || !isAbsolute(value.file ?? "") || !HASH.test(value.namespace ?? "")) throw refusal();
  return value;
}
export function withDemoResources(value, fn) { return scope.run(context(value), fn); }
export function currentDemoResources() {
  const value = scope.getStore();
  if (value) return value;
  if (process.env.TOUCHSTONE_DEMO !== "1") return null;
  return context({ file: process.env.TOUCHSTONE_DEMO_RESOURCE_FILE, namespace: process.env.TOUCHSTONE_DEMO_RESOURCE_NAMESPACE });
}
export function demoResourceEnvironment(value) {
  context(value);
  return { TOUCHSTONE_DEMO: "1", TOUCHSTONE_DEMO_RESOURCE_FILE: value.file, TOUCHSTONE_DEMO_RESOURCE_NAMESPACE: value.namespace };
}
const identityValid = (g) => g && Number.isSafeInteger(g.pid) && g.pid > 1 && Number.isSafeInteger(g.uid) && g.uid >= 0 && BOOT.test(g.boot) && /^[1-9][0-9]*$/.test(g.start);
const nameOf = (namespace, id) => `touchstone-demo-${namespace}-${id}`;
function validate(state, value) {
  if (!state || state.version !== 1 || state.namespace !== value.namespace || typeof state.closing !== "boolean" || typeof state.cancelled !== "boolean" || !state.groups || !state.resources || !state.directories || Array.isArray(state.groups) || Array.isArray(state.resources) || Array.isArray(state.directories)) throw refusal();
  for (const [key, group] of Object.entries(state.groups)) {
    if (!(key === "worker" || ID.test(key)) || !["intent", "running", "complete"].includes(group.phase) || (group.identity !== null && !identityValid(group.identity))) throw refusal();
    if (group.phase === "running" && !group.identity) throw refusal();
  }
  for (const [id, resource] of Object.entries(state.resources)) {
    if (!ID.test(id) || resource.name !== nameOf(value.namespace, id) || !["intent", "created", "starting", "complete"].includes(resource.phase) || (resource.containerId !== null && !HASH.test(resource.containerId)) || !state.groups[id] || !state.directories[resource.directory]) throw refusal();
  }
  for (const [dir, record] of Object.entries(state.directories)) if (!isAbsolute(dir) || resolve(dir) !== dir || !["open", "complete"].includes(record.phase)) throw refusal();
  return state;
}
function transaction(value, fn) {
  context(value);
  const st = lstatSync(value.file);
  if (!st.isFile() || st.isSymbolicLink() || st.mode & 0o077) throw refusal();
  const db = new DatabaseSync(value.file, { timeout: 1000 });
  try {
    db.exec("BEGIN IMMEDIATE");
    const row = db.prepare("SELECT data FROM demo WHERE id=1").get();
    const state = validate(JSON.parse(row.data), value);
    const result = fn(state);
    validate(state, value);
    db.prepare("UPDATE demo SET data=? WHERE id=1").run(JSON.stringify(state));
    db.exec("COMMIT");
    return result;
  } finally { db.close(); }
}
export function createDemoResources(file) {
  if (!isAbsolute(file)) throw refusal();
  const value = { file, namespace: randomBytes(32).toString("hex") };
  closeSync(openSync(file, "wx", 0o600));
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA synchronous=FULL; CREATE TABLE demo(id INTEGER PRIMARY KEY, data TEXT NOT NULL)");
    db.prepare("INSERT INTO demo VALUES(1, ?)").run(JSON.stringify({ version: 1, namespace: value.namespace, closing: false, cancelled: false, groups: {}, resources: {}, directories: {} }));
  } finally { db.close(); }
  return value;
}
export function demoResourcesComplete(value, { directories = true } = {}) {
  return transaction(value, (state) => state.closing && Object.values(state.groups).every((g) => g.phase === "complete") && Object.values(state.resources).every((r) => r.phase === "complete") && (!directories || Object.values(state.directories).every((d) => d.phase === "complete")));
}
export function reopenDemoResources(value) {
  transaction(value, (state) => { if (state.cancelled || Object.values(state.groups).some((g) => g.phase !== "complete") || Object.values(state.resources).some((r) => r.phase !== "complete")) throw refusal(); state.closing = false; });
}

export function registerDemoDirectory(value, dir) {
  const canonical = realpathSync(dir), marker = join(canonical, ".touchstone-demo-resource-owner");
  transaction(value, (state) => {
    if (state.closing || state.cancelled || state.directories[canonical]?.phase === "complete") throw refusal();
    if (!lstatSync(canonical).isDirectory()) throw refusal();
    if (!existsSync(marker)) writeFileSync(marker, value.namespace, { flag: "wx", mode: 0o600 });
    if (!lstatSync(marker).isFile() || lstatSync(marker).isSymbolicLink() || readFileSync(marker, "utf8") !== value.namespace) throw refusal();
    state.directories[canonical] = { phase: "open" };
  });
  return canonical;
}

export function removeDemoDirectory(value, dir) {
  transaction(value, (state) => {
    const entry = state.directories[dir];
    if (!entry) throw refusal();
    if (entry.phase === "complete") return;
    if (Object.entries(state.resources).some(([id, resource]) => resource.directory === dir && (resource.phase !== "complete" || state.groups[id].phase !== "complete"))) throw refusal();
    if (existsSync(dir)) {
      const marker = join(dir, ".touchstone-demo-resource-owner");
      if (lstatSync(dir).isSymbolicLink() || !lstatSync(marker).isFile() || lstatSync(marker).isSymbolicLink() || readFileSync(marker, "utf8") !== value.namespace) throw refusal();
      rmSync(dir, { recursive: true, force: true });
      if (existsSync(dir)) throw refusal();
    }
    entry.phase = "complete";
  });
}
function processIdentity(pid) {
  const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(/\) /).at(-1).split(" ");
  if (Number(fields[2]) !== pid || Number(fields[3]) !== pid) throw refusal();
  return { pid, uid: process.getuid(), start: fields[19], boot: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() };
}
function reserve(value, key, directory = null) {
  transaction(value, (state) => {
    if (state.closing || state.cancelled || state.groups[key]) throw refusal();
    state.groups[key] = { phase: "intent", identity: null };
    if (directory) {
      if (state.directories[directory]?.phase !== "open") throw refusal();
      state.resources[key] = { name: nameOf(value.namespace, key), containerId: null, phase: "intent", directory };
    }
  });
}
function launch(value, key, mode, args, options = {}) {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", LAUNCHER, mode, JSON.stringify(value), ...args], {
    ...options, detached: true, env: { ...process.env, ...options.env, ...demoResourceEnvironment(value) }, stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  child.stdio[3]?.on("error", () => {});
  if (child.pid) {
    let allowed = false;
    try {
      const identity = processIdentity(child.pid);
      allowed = transaction(value, (state) => { state.groups[key] = { phase: "running", identity }; return !state.closing && !state.cancelled; });
    } finally { child.stdio[3].end(allowed ? "go" : ""); }
  }
  child.on("error", () => {
    // A failed spawn never received the gate byte and cannot have run a tool.
    if (!child.pid) transaction(value, (state) => { state.groups[key].phase = "complete"; if (state.resources[key]) state.resources[key].phase = "complete"; });
  });
  return child;
}
export function spawnDemoWorker(value, engine, args, options) {
  reserve(value, "worker");
  return launch(value, "worker", "worker", [engine, JSON.stringify(args)], options);
}
function docker(args, timeout = 5000, maxBuffer = 1024 * 1024) {
  return new Promise((resolveResult) => execFile("docker", args, { timeout, killSignal: "SIGKILL", maxBuffer, env: process.env }, (error, stdout, stderr) => resolveResult({ code: error ? error.code : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), timedOut: Boolean(error?.killed), overflow: error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" })));
}
async function inspect(value, id, resource, timeout) {
  const result = await docker(["inspect", "--type", "container", "--format", "{{json .}}", resource.containerId ?? resource.name], timeout);
  if (result.code === 1 && /no such (?:object|container)\b/i.test(result.stderr)) return null;
  if (result.code !== 0) throw refusal();
  const data = JSON.parse(result.stdout);
  if (!HASH.test(data.Id ?? "") || (resource.containerId && data.Id !== resource.containerId) || data.Name !== `/${resource.name}` || data.Config?.Labels?.["touchstone.demo.owner"] !== value.namespace || data.Config?.Labels?.["touchstone.demo.resource"] !== id) throw refusal();
  return data;
}
async function removeResource(value, id, deadline) {
  const resource = transaction(value, (state) => state.resources[id]);
  if (resource.phase === "complete") return;
  const remaining = () => { const ms = Math.min(5000, deadline - Date.now()); if (ms <= 0) throw refusal(); return ms; };
  const containerId = (await inspect(value, id, resource, remaining()))?.Id;
  if (!containerId && !resource.containerId) throw refusal(); // A create may still commit: absence is not acknowledgement.
  if (containerId) {
    transaction(value, (state) => { state.resources[id].containerId = containerId; });
    const removed = await docker(["rm", "-f", containerId], remaining());
    if (removed.code !== 0) throw refusal();
    if (await inspect(value, id, { ...resource, containerId }, remaining())) throw refusal();
  }
  transaction(value, (state) => { state.resources[id].phase = "complete"; });
}
export async function runRegisteredForge(value, id, args, timeout, maxBuffer) {
  const resource = transaction(value, (state) => { if (state.closing || state.cancelled) throw refusal(); return state.resources[id]; });
  if (args[0] !== "run") throw refusal();
  const created = await docker(["create", "--name", resource.name, "--label", `touchstone.demo.owner=${value.namespace}`, "--label", `touchstone.demo.resource=${id}`, ...args.slice(1).filter((arg) => arg !== "--rm")], 5000);
  const containerId = created.stdout.trim();
  if (created.code !== 0 || !HASH.test(containerId)) throw refusal();
  const allowed = transaction(value, (state) => { Object.assign(state.resources[id], { containerId, phase: "created" }); return !state.closing && !state.cancelled; });
  if (!allowed) throw refusal();
  transaction(value, (state) => { if (state.closing || state.cancelled) throw refusal(); state.resources[id].phase = "starting"; });
  const result = await docker(["start", "--attach", containerId], timeout, maxBuffer);
  if (result.code === 0) {
    const final = await inspect(value, id, { ...resource, containerId }, 5000);
    if (!final || final.State?.Running || !Number.isSafeInteger(final.State?.ExitCode)) throw refusal();
    result.code = final.State.ExitCode;
  }
  await removeResource(value, id, Date.now() + 15000);
  return result;
}
export async function runDemoForge(value, args, timeout, maxBuffer) {
  try { return await executeForge(value, args, timeout, maxBuffer); }
  catch (error) {
    transaction(value, (state) => { state.closing = true; state.cancelled = true; });
    throw error;
  }
}

async function executeForge(value, args, timeout, maxBuffer) {
  const mount = args.find((arg, index) => args[index - 1] === "-v" && arg.endsWith(":/work"));
  if (!mount) throw refusal();
  const directory = registerDemoDirectory(value, mount.slice(0, -6));
  const id = randomBytes(8).toString("hex");
  reserve(value, id, directory);
  const child = launch(value, id, "forge", [id, JSON.stringify(args), String(timeout), String(maxBuffer)]);
  let stdout = "", tooLarge = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { if (stdout.length + chunk.length > maxBuffer * 16 + 4096) tooLarge = true; else if (!tooLarge) stdout += chunk; });
  child.stderr.resume();
  const code = await new Promise((resolveCode, reject) => { child.once("error", reject); child.once("close", resolveCode); });
  if (code !== 0 || tooLarge) throw refusal();
  const identity = transaction(value, (state) => state.groups[id].identity);
  await joinGroups(value, [identity], 0);
  const result = JSON.parse(stdout);
  transaction(value, (state) => { if (state.resources[id].phase !== "complete") throw refusal(); state.groups[id].phase = "complete"; });
  return result;
}

function joinGroups(value, groups, graceMs) {
  return new Promise((resolveDone, reject) => {
    const helper = execFile("python3", [PYTHON], { timeout: 10000, killSignal: "SIGKILL", maxBuffer: 4096, env: { PATH: process.env.PATH } }, (error, stdout) => error || stdout.trim() !== "ok" ? reject(refusal()) : resolveDone());
    helper.stdin.on("error", () => {});
    helper.stdin.end(JSON.stringify({ namespace: value.namespace, groups, graceMs: Math.min(5000, Math.max(0, graceMs)) }));
  });
}

export function settleDemoResources(value, { cancel = true, graceMs = 0, removeDirectories = cancel } = {}) {
  context(value);
  transaction(value, (state) => { state.closing = true; state.cancelled ||= cancel; });
  if (pending.has(value.file)) return pending.get(value.file);
  const task = (async () => {
    checkDemoResourceRuntime();
    const groups = transaction(value, (state) => Object.values(state.groups).filter((group) => group.phase !== "complete").map((group) => { if (!group.identity) throw refusal(); return group.identity; }));
    if (groups.length) {
      await joinGroups(value, groups, graceMs);
      transaction(value, (state) => { for (const group of Object.values(state.groups)) if (group.phase !== "complete") group.phase = "complete"; });
    }
    const deadline = Date.now() + 20000;
    const ids = transaction(value, (state) => Object.keys(state.resources));
    for (const id of ids) await removeResource(value, id, deadline);
    if (removeDirectories) {
      for (const dir of transaction(value, (state) => Object.keys(state.directories))) removeDemoDirectory(value, dir);
    }
    if (!demoResourcesComplete(value, { directories: removeDirectories })) throw refusal();
  })().finally(() => pending.delete(value.file));
  pending.set(value.file, task);
  return task;
}

export function demoLaunchAllowed(value, key) {
  return transaction(value, (state) => {
    const saved = state.groups[key]?.identity;
    if (state.groups[key]?.phase !== "running" || !saved || saved.pid !== process.pid) return false;
    const current = processIdentity(process.pid);
    return saved.start === current.start && saved.boot === current.boot && saved.uid === current.uid && !state.closing && !state.cancelled;
  });
}

