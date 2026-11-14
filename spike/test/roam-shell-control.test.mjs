// Local synthetic owned processes only. This is not live Daytona or root-isolation proof.
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import { once } from "node:events";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { roamTools, pauseRoamShell, resumeRoamShell, closeRoamShell } from "../lib/roam.mjs";
import { withAgent } from "../lib/event.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  for (let i = 0; i < 150; i++) { if (await fn()) return; await sleep(20); }
  assert.fail("bounded wait expired");
}
function identity(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/);
    return { pid: Number(pid), group: Number(f[2]), birth: f[19], state: f[0] };
  } catch (e) { if (e.code === "ENOENT" || e.code === "ESRCH") return null; throw e; }
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "roam-shell-control-"));
  const entries = [], ops = [], owned = new Map();
  const statePath = join(dir, "touchstone-shell-control", "state.json");
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));
  const remember = () => {
    if (!existsSync(statePath)) return;
    for (const j of state().jobs) {
      for (const p of readdirSync("/proc").filter((x) => /^\d+$/.test(x)).map(identity)) {
        if (p && p.group === j.pid) owned.set(p.pid, p);
      }
    }
  };
  const m = {
    id: randomUUID(), fresh: true,
    upload: async (path, bytes) => writeFileSync(join(dir, basename(path)), bytes),
    exec: async (command, seconds) => {
      const match = /^node \/tmp\/touchstone-shell-control\.mjs ([a-f0-9-]{36})$/.exec(command);
      assert.ok(match, "only a fixed supervisor invocation, never interpolated command content");
      const q = JSON.parse(readFileSync(join(dir, `touchstone-shell-${match[1]}.json`), "utf8"));
      ops.push(q);
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [join(dir, "touchstone-shell-control.mjs"), match[1]], { stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        child.stdout.on("data", (d) => { output += d; });
        child.stderr.on("data", (d) => { output += d; });
        const timer = setTimeout(() => { child.kill(); reject(new Error("synthetic exec deadline")); }, Math.min(seconds + 2, 15) * 1000);
        child.on("error", reject);
        child.on("close", (code) => { clearTimeout(timer); remember(); resolve({ exitCode: code, result: output }); });
      });
    },
  };
  const [tool] = roamTools(dir, {
    machine: async () => m,
    egress: { env: "export TEST_PROXY=present; ", start: async () => ops.push({ op: "egress-start" }), pull: async () => [] },
    record: (e) => { entries.push(e); return { poc: `session:test:${entries.length}`, output: e.output }; },
  });
  const run = (command, timeout_s = 10) => withAgent(m.id, () => tool.execute({ command, timeout_s }));
  t.after(async () => {
    remember();
    // Only recorded identities from this fixture's managed groups are stopped.
    for (const p of owned.values()) {
      const now = identity(p.pid);
      if (now?.birth === p.birth && now.state !== "Z") { try { process.kill(p.pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; } }
    }
    await until(() => [...owned.values()].every((p) => { const n = identity(p.pid); return !n || n.birth !== p.birth || n.state === "Z"; }));
    rmSync(dir, { recursive: true, force: true });
  });
  return { m, dir, run, entries, ops, state, statePath, remember, owned };
}

test("owner loss while queued for admission never launches a shell or records a job", async (t) => {
  const f = fixture(t);
  await pauseRoamShell(f.m);
  await resumeRoamShell(f.m);
  const before = f.state();
  const lock = join(f.dir, "touchstone-shell-control", "lock");
  const marker = join(f.dir, "must-not-launch");
  const id = randomUUID();
  writeFileSync(join(f.dir, `touchstone-shell-${id}.json`), JSON.stringify({
    id, op: "run", generation: before.generation, epoch: before.epoch,
    command: `printf launched > '${marker}'`, seconds: 5,
  }));
  mkdirSync(lock);
  const owner = spawn(process.execPath, [join(f.dir, "touchstone-shell-control.mjs"), id], { stdio: "ignore" });
  const closed = once(owner, "close");
  const ownerIdentity = identity(owner.pid);
  assert.ok(ownerIdentity);
  f.owned.set(owner.pid, ownerIdentity);
  let worker;
  await until(() => {
    const children = readFileSync(`/proc/${owner.pid}/task/${owner.pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
    worker = children.map(identity).find((p) => p && p.group === p.pid);
    if (worker) f.owned.set(worker.pid, worker);
    return worker;
  });
  // Let the owned worker enter its lock wait before disconnecting its owner.
  await sleep(100);
  assert.deepEqual(f.state(), before);
  owner.kill("SIGKILL");
  await closed;
  await sleep(100);
  rmSync(lock, { recursive: true });
  await until(() => { const p = identity(worker.pid); return !p || p.birth !== worker.birth || p.state === "Z"; });
  assert.equal(existsSync(marker), false, "owner loss before admission must prevent shell execution");
  assert.deepEqual(f.state(), before, "no queued job is recorded and supervisor state stays unchanged");
  assert.equal(existsSync(join(f.dir, `touchstone-shell-${id}.json`)), false, "the request payload is consumed");
});

test("uploaded shell payload preserves log env and session record without command-line interpolation", async (t) => {
  const f = fixture(t);
  const command = "printf '%s' \"$TEST_PROXY\"; printf '%s' '\"; not-a-control-command'";
  const result = await f.run(command);
  assert.match(result.output[0].text, /session session:test:1\nexit 0\npresent/);
  assert.deepEqual(f.ops.map((q) => q.op), ["egress-start", "init", "run"]);
  assert.equal(f.ops[2].command, `export TEST_PROXY=present; ${command}`);
  assert.equal(f.entries[0].command, command);
  assert.equal(f.entries[0].kind, "shell");
  assert.equal(f.entries[0].exit_code, 0);
  await until(() => f.state().jobs.every((j) => j.drained));
  assert.deepEqual(await pauseRoamShell(f.m), { ack: true, state: "paused", scope: "managed-shell" });
  assert.deepEqual(await resumeRoamShell(f.m), { ack: true, state: "active", scope: "managed-shell" });
  assert.deepEqual(await closeRoamShell(f.m), { ack: true, state: "closed", scope: "managed-shell" });
});

test("foreground return keeps background group tracked; pause stops writes, resume restarts, close drains", async (t) => {
  const f = fixture(t), file = join(f.dir, "ticks");
  await f.run(`(while :; do printf x >> '${file}'; sleep 0.03; done) >/dev/null 2>&1 & printf launched`);
  await until(() => existsSync(file) && readFileSync(file).length >= 2);
  assert.equal(f.state().jobs.filter((j) => !j.drained).length, 1);
  assert.equal((await pauseRoamShell(f.m)).ack, true);
  const stopped = readFileSync(file).length;
  await sleep(150);
  assert.equal(readFileSync(file).length, stopped);
  await assert.rejects(f.run("printf must-not-run"));
  assert.equal(f.ops.filter((q) => q.op === "run").length, 1);
  await resumeRoamShell(f.m);
  await until(() => readFileSync(file).length > stopped);
  await closeRoamShell(f.m);
  assert.equal(f.state().mode, "closed");
  assert.ok(f.state().jobs.every((j) => j.drained));
  await assert.rejects(f.run("printf closed"));
});

test("pause and close cover every retained background group", async (t) => {
  const f = fixture(t);
  await f.run("sleep 20 >/dev/null 2>&1 & printf first");
  await f.run("sleep 20 >/dev/null 2>&1 & printf second");
  assert.equal(f.state().jobs.filter((j) => !j.drained).length, 2);
  await pauseRoamShell(f.m);
  for (const j of f.state().jobs) assert.equal(identity(j.pid).state, "T");
  await closeRoamShell(f.m);
  assert.ok(f.state().jobs.every((j) => j.drained));
});

test("shell output retains its bounded tail and nonzero exit status", async (t) => {
  const f = fixture(t);
  await f.run(`node -e 'process.stdout.write("x".repeat(300000) + "END")'; exit 7`);
  assert.equal(f.entries[0].exit_code, 7);
  assert.equal(f.entries[0].output, "x".repeat(262141) + "END");
});

test("pause verifies a foreground group while its exec is still waiting", async (t) => {
  const f = fixture(t), file = join(f.dir, "foreground"), done = join(f.dir, "done");
  const running = f.run(`while [ ! -e '${done}' ]; do printf x >> '${file}'; sleep 0.03; done; printf finished`);
  await until(() => existsSync(file) && readFileSync(file).length >= 2);
  assert.equal((await pauseRoamShell(f.m)).state, "paused");
  const count = readFileSync(file).length;
  await sleep(120);
  assert.equal(readFileSync(file).length, count);
  await resumeRoamShell(f.m);
  writeFileSync(done, "done");
  assert.match((await running).output[0].text, /finished/);
});

test("a paused job past its wall-clock deadline cannot resume", async (t) => {
  const f = fixture(t);
  await f.run("sleep 20 >/dev/null 2>&1 & printf started", 1);
  await pauseRoamShell(f.m);
  await sleep(1100);
  await assert.rejects(resumeRoamShell(f.m));
  assert.equal(f.state().mode, "unknown");
});

test("a mismatched remote acknowledgement fails closed", async (t) => {
  const f = fixture(t), exec = f.m.exec;
  await f.run("true");
  f.m.exec = async (command, seconds) => {
    const r = await exec(command, seconds);
    if (f.ops.at(-1).op === "pause") {
      const a = JSON.parse(r.result); a.id = "stale-response";
      return { ...r, result: JSON.stringify(a) };
    }
    return r;
  };
  await assert.rejects(pauseRoamShell(f.m));
  await assert.rejects(resumeRoamShell(f.m));
  await assert.rejects(f.run("true"));
});

test("pause and resume are ordered; an upload pending at pause never launches", async (t) => {
  const f = fixture(t);
  await f.run("true");
  await until(() => f.state().jobs.every((j) => j.drained));
  const upload = f.m.upload;
  let release, uploading;
  const started = new Promise((r) => { uploading = r; });
  f.m.upload = async (path, bytes) => {
    if (path.endsWith(".json") && JSON.parse(bytes).command?.includes("must-not-run")) {
      uploading(); await new Promise((r) => { release = r; });
    }
    return upload(path, bytes);
  };
  const delayed = assert.rejects(f.run("printf must-not-run"));
  await started;
  const pause = pauseRoamShell(f.m);
  const resume = resumeRoamShell(f.m);
  assert.equal((await pause).state, "paused");
  assert.equal((await resume).state, "active");
  release(); await delayed;
  assert.equal(f.ops.filter((q) => q.op === "run").length, 1);
  await f.run("printf resumed");
});

test("remote epoch rejects a delayed launch even after pause and resume", async (t) => {
  const f = fixture(t);
  await f.run("true");
  await until(() => f.state().jobs.every((j) => j.drained));
  const exec = f.m.exec;
  let release, entered;
  const started = new Promise((r) => { entered = r; });
  f.m.exec = async (command, seconds) => {
    const id = command.split(" ").at(-1);
    const q = JSON.parse(readFileSync(join(f.dir, `touchstone-shell-${id}.json`), "utf8"));
    if (q.command?.includes("stale")) { entered(); await new Promise((r) => { release = r; }); }
    return exec(command, seconds);
  };
  const delayed = assert.rejects(f.run("printf stale"));
  await started; await pauseRoamShell(f.m); await resumeRoamShell(f.m);
  release(); await delayed;
  await assert.rejects(pauseRoamShell(f.m));
  assert.equal(f.state().mode, "unknown");
});

test("remote command deadline fails closed even without a toolbox timeout", async (t) => {
  const f = fixture(t);
  const before = Date.now();
  await assert.rejects(f.run("sleep 20", 1));
  assert.ok(Date.now() - before < 5000);
  assert.equal(f.entries[0].exit_code, undefined);
  assert.equal(f.state().mode, "unknown");
  await assert.rejects(pauseRoamShell(f.m));
  await assert.rejects(resumeRoamShell(f.m));
  await assert.rejects(f.run("true"));
});

test("lost exec response latches unknown while a background job remains accounted for", async (t) => {
  const f = fixture(t), exec = f.m.exec;
  f.m.exec = async (command, seconds) => {
    const r = await exec(command, seconds);
    if (f.ops.at(-1).op === "run") throw new Error("synthetic exec timeout");
    return r;
  };
  await assert.rejects(f.run("sleep 20 >/dev/null 2>&1 & printf started"));
  assert.equal(f.state().mode, "unknown");
  await assert.rejects(pauseRoamShell(f.m));
});

for (const loss of ["identity", "leader", "state", "lock"]) {
  test(`${loss} loss never acknowledges pause and bounds failure`, async (t) => {
    const f = fixture(t);
    await f.run("sleep 20 >/dev/null 2>&1 & printf started");
    f.remember();
    const s = f.state();
    if (loss === "identity") { s.jobs[0].birth = String(BigInt(s.jobs[0].birth) + 1n); writeFileSync(f.statePath, JSON.stringify(s)); }
    if (loss === "leader") process.kill(s.jobs[0].pid, "SIGKILL");
    if (loss === "state") rmSync(f.statePath);
    if (loss === "lock") mkdirSync(join(f.dir, "touchstone-shell-control", "lock"));
    const before = Date.now();
    await assert.rejects(pauseRoamShell(f.m), /Keep human input disabled/);
    assert.ok(Date.now() - before < 6000);
    await assert.rejects(resumeRoamShell(f.m));
    await assert.rejects(f.run("true"));
  });
}

test("pause before the first shell blocks launches until resume; close is idempotent", async (t) => {
  const f = fixture(t);
  assert.equal((await pauseRoamShell(f.m)).state, "paused");
  await assert.rejects(f.run("true"));
  assert.equal(f.ops.filter((q) => q.op === "run").length, 0);
  await resumeRoamShell(f.m);
  await f.run("true");
  await closeRoamShell(f.m);
  assert.equal((await closeRoamShell(f.m)).state, "closed");
});

for (const malformed of ["mode", "deadline"]) {
  test(`malformed supervisor ${malformed} refuses pause`, async (t) => {
    const f = fixture(t);
    await f.run("sleep 20 >/dev/null 2>&1 & printf started");
    const s = f.state();
    if (malformed === "mode") s.mode = "unexpected";
    else s.jobs[0].deadline = null;
    writeFileSync(f.statePath, JSON.stringify(s));
    await assert.rejects(pauseRoamShell(f.m), /Keep human input disabled/);
    await assert.rejects(f.run("true"));
  });
}

test("a reused machine with no supervisor state fails closed", async (t) => {
  const f = fixture(t);
  f.m.fresh = false;
  await assert.rejects(f.run("true"));
  assert.equal(f.ops.filter((q) => q.op === "run").length, 0);
});
