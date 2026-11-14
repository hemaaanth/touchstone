// Runs ON the remote Linux machine. Cooperative managed process groups only.
// Root tampering and deliberate setsid/daemon escapes are outside this boundary.
// A live group leader pins each PGID until its background members drain.
import { fork, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const script = fileURLToPath(import.meta.url);
const home = join(dirname(script), "touchstone-shell-control");
const stateFile = join(home, "state.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = () => { throw new Error("Managed shell state is unknown."); };
const readState = () => JSON.parse(readFileSync(stateFile, "utf8"));
function save(s) {
  writeFileSync(stateFile + ".next", JSON.stringify(s), { mode: 0o600 });
  renameSync(stateFile + ".next", stateFile);
}
async function locked(fn) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  for (let i = 0; ; i++) {
    try { mkdirSync(join(home, "lock")); break; }
    catch (e) { if (e.code !== "EEXIST" || i === 100) fail(); await sleep(20); }
  }
  try { return await fn(); } finally { rmdirSync(join(home, "lock")); }
}
function proc(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/);
    return { pid: Number(pid), state: f[0], group: Number(f[2]), session: Number(f[3]), birth: f[19] };
  } catch (e) { if (e.code === "ENOENT" || e.code === "ESRCH") return null; throw e; }
}
function members(job) {
  const leader = proc(job.pid);
  if (!leader || leader.birth !== job.birth || leader.group !== job.pid || leader.session !== job.pid || leader.state === "Z") fail();
  return readdirSync("/proc").filter((p) => /^\d+$/.test(p)).map(proc)
    .filter((p) => p && p.group === job.pid && p.state !== "Z");
}
function check(s) {
  if (!s || s.version !== 1 || !Array.isArray(s.jobs) || !["active", "paused", "closed"].includes(s.mode) ||
      typeof s.generation !== "string" || !Number.isSafeInteger(s.epoch) || s.epoch < 0) fail();
  for (const j of s.jobs) {
    if (!j || !Number.isSafeInteger(j.pid) || j.pid <= 0 || !/^\d+$/.test(j.birth) ||
        typeof j.drained !== "boolean" || !Number.isFinite(j.deadline)) fail();
    if (!j.drained) {
      if (Date.now() >= j.deadline) fail();
      members(j);
    }
  }
}
const ack = (s) => ({ generation: s.generation, epoch: s.epoch, state: s.mode, scope: "managed-shell", ack: true });

async function control(q) {
  return locked(async () => {
    let s;
    try { s = readState(); }
    catch (e) {
      // Missing state on a reused machine could hide an older running job.
      if (e.code !== "ENOENT" || q.op !== "init" || q.fresh !== true) fail();
      s = { version: 1, generation: randomUUID(), epoch: 0, mode: "active", jobs: [] };
      save(s);
    }
    if (q.op !== "init" && q.generation !== s.generation) fail();
    if (q.op === "block") { s.mode = "unknown"; s.epoch++; save(s); fail(); }
    try {
      check(s);
      if (q.op === "init") return ack(s);
      if (s.mode === "closed") { if (q.op === "close") return ack(s); fail(); }
      if (q.op === "pause") {
        s.mode = "paused"; s.epoch++; save(s);
        for (const j of s.jobs) {
          if (j.drained) continue;
          members(j); // verify the live group leader immediately before signalling
          process.kill(-j.pid, "SIGSTOP");
          let stopped = false, previous = "";
          for (let i = 0; i < 100; i++) {
            const group = members(j);
            const census = group.map((p) => `${p.pid}:${p.birth}`).sort().join(",");
            const allStopped = group.every((p) => p.state === "T" || p.state === "t");
            if (allStopped && census === previous) { stopped = true; break; }
            previous = allStopped ? census : "";
            await sleep(20);
          }
          if (!stopped) fail();
        }
      } else if (q.op === "resume") {
        if (s.mode !== "paused") fail();
        for (const j of s.jobs) {
          if (j.drained) continue;
          if (!members(j).every((p) => p.state === "T" || p.state === "t")) fail();
          process.kill(-j.pid, "SIGCONT");
        }
        s.mode = "active"; s.epoch++;
      } else if (q.op === "close") {
        s.mode = "closed"; s.epoch++; save(s);
        for (const j of s.jobs) {
          if (j.drained) continue;
          const owned = members(j);
          process.kill(-j.pid, "SIGKILL");
          let gone = false;
          for (let i = 0; i < 100; i++) {
            if (owned.every((p) => { const now = proc(p.pid); return !now || now.birth !== p.birth || now.state === "Z"; })) { gone = true; break; }
            await sleep(20);
          }
          if (!gone) fail();
          j.drained = true;
        }
      } else fail();
      check(s);
      save(s);
      return ack(s);
    } catch {
      s.mode = "unknown"; s.epoch++; save(s); fail();
    }
  });
}

async function worker(q) {
  let shell, timer, polling, returned = false;
  let output = Buffer.alloc(0);
  const me = proc(process.pid);
  const job = { id: q.id, pid: process.pid, birth: me.birth, deadline: Date.now() + q.seconds * 1000, drained: false };
  const send = (value) => { if (process.connected) process.send(value); };
  const poison = async () => {
    try { await locked(() => { const s = readState(); s.mode = "unknown"; s.epoch++; save(s); }); } finally {
      // This worker is the still-live leader of its own synthetic/remote group.
      process.kill(-process.pid, "SIGKILL");
    }
  };
  try {
    await locked(() => {
      const s = readState(); check(s);
      if (s.mode !== "active" || s.generation !== q.generation || s.epoch !== q.epoch) fail();
      // Keep only live jobs. A drained job has no managed group left to signal.
      s.jobs = s.jobs.filter((j) => !j.drained);
      s.jobs.push(job); save(s);
      shell = spawn("sh", ["-c", q.command], { stdio: ["ignore", "pipe", "pipe"] });
    });
    const collect = (b) => { output = Buffer.concat([output, b]).subarray(-262144); };
    shell.stdout.on("data", collect); shell.stderr.on("data", collect);
    shell.on("error", () => { void poison(); });
    timer = setTimeout(() => { void poison(); }, q.seconds * 1000);
    shell.on("exit", (code) => {
      if (!Number.isInteger(code)) { void poison(); return; }
      returned = true;
      send({ ok: true, generation: q.generation, epoch: q.epoch, exitCode: code, result: output.toString("utf8") });
      // The leader remains alive after the shell exits, until its group drains.
      polling = setInterval(async () => {
        try {
          const drained = await locked(() => {
            const s = readState();
            if (s.mode === "unknown" || s.mode === "closed") fail();
            if (s.mode === "paused") return;
            if (members(job).some((p) => p.pid !== process.pid)) return;
            const stored = s.jobs.find((j) => j.id === job.id);
            if (!stored || stored.birth !== job.birth) fail();
            stored.drained = true; save(s);
            return true;
          });
          if (drained) { clearTimeout(timer); clearInterval(polling); process.exit(0); }
        } catch { void poison(); }
      }, 50);
    });
    process.on("disconnect", () => { if (!returned) void poison(); });
  } catch {
    send({ ok: false });
    process.exit(1);
  }
}

async function request(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) fail();
  const path = join(dirname(script), `touchstone-shell-${id}.json`);
  const q = JSON.parse(readFileSync(path, "utf8"));
  unlinkSync(path);
  if (q.id !== id) fail();
  if (q.op !== "run") return { ok: true, ...await control(q) };
  if (typeof q.command !== "string" || !Number.isInteger(q.seconds) || q.seconds < 1 || q.seconds > 900) fail();
  return new Promise((resolve) => {
    const child = fork(script, ["worker"], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    child.once("message", (result) => { child.disconnect(); child.unref(); resolve(result); });
    child.once("error", () => resolve({ ok: false }));
    child.once("exit", () => resolve({ ok: false }));
    child.send(q);
  });
}
if (process.argv[2] === "worker") {
  process.once("message", (q) => { void worker(q); });
} else {
  try { console.log(JSON.stringify({ ...await request(process.argv[2]), id: process.argv[2] })); }
  catch { console.log(JSON.stringify({ ok: false })); process.exitCode = 1; }
}
