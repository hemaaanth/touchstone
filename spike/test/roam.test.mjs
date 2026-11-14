// Tests for the free-roam machine (lib/daytona.mjs roamMachine) and its
// `shell` tool (lib/roam.mjs).
//
// Part 1 gives `shell` a fake machine, a fake `record` and a fake `egress`.
// Part 2 uses the real roamMachine against a fake Daytona API. No machine, no
// network, no key, no cost.
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROAM_SNAPSHOT, closeRun, remoteDocker, roamMachine, shq } from "../lib/daytona.mjs";
import { withAgent } from "../lib/event.mjs";
import { REPLACED_NOTICE, roamTools } from "../lib/roam.mjs";

// The value lane B's EGRESS_ENV has.
const ENV = "export HTTP_PROXY=http://127.0.0.1:8899 HTTPS_PROXY=http://127.0.0.1:8899 http_proxy=http://127.0.0.1:8899 https_proxy=http://127.0.0.1:8899; ";
const RAW = "raw output with sk-secret-0000";
const textOf = (res) => res.output[0].text;

// A fake record(), egress and machine. `steps` holds what ran, in order.
function fakes({ id = "m-1", fresh = true, replaced = false, exitCode = 0, startFails = 0, pulled = [] } = {}) {
  const steps = [];
  const entries = [];
  let n = 0;
  const m = {
    id, fresh, replaced,
    exec: async (command, seconds) => {
      steps.push("exec");
      m.calls.push({ command, seconds });
      return { exitCode, result: RAW };
    },
    upload: async () => {},
    calls: [],
  };
  return {
    steps, entries, m,
    machine: async (ws, agent) => {
      steps.push(`machine ${agent}`);
      return m;
    },
    record: (e) => {
      steps.push(`record ${e.kind}`);
      entries.push(e);
      return e.kind === "shell" ? { poc: `session:${e.agent}:${++n}`, output: "scrubbed output" } : {};
    },
    egress: {
      env: ENV,
      start: async (x) => {
        steps.push(`start ${x.id}`);
        if (startFails-- > 0) throw new Error("the request log did not start");
      },
      pull: async (x) => {
        steps.push(`pull ${x.id}`);
        return pulled;
      },
    },
  };
}

const shellOf = (f, ws = "/tmp/redteam-run-none") => roamTools(ws, { record: f.record, egress: f.egress, machine: f.machine })[0];
const as = (agent, tool, args) => withAgent(agent, () => tool.execute(args));

// ---- Part 1: the shell tool

test("shell runs its six steps in order and returns only what record() returned", async () => {
  const f = fakes({ exitCode: 3, pulled: [{ t: 11, method: "GET", url: "https://x.test/a", status: 200, extra: "no" }, { t: 12, method: "POST", url: "https://x.test/b", status: 500 }] });
  const shell = shellOf(f);
  assert.equal(shell.name, "shell");
  const before = Date.now();
  const res = await as("a-1", shell, { command: "echo 'hi' && id" });

  assert.deepEqual(f.steps, ["machine a-1", "start m-1", "exec", "record shell", "pull m-1", "record egress", "record egress"]);
  // The command goes to the machine as one string, inside sh -c, after the proxy variables.
  assert.deepEqual(f.m.calls, [{ command: `sh -c ${shq(`${ENV}echo 'hi' && id`)}`, seconds: 120 }]);
  const [s, e1, e2] = f.entries;
  assert.ok(s.t >= before && s.t <= Date.now());
  assert.deepEqual({ ...s, t: 0 }, { agent: "a-1", kind: "shell", t: 0, sandbox: "m-1", command: "echo 'hi' && id", exit_code: 3, output: RAW });
  assert.deepEqual(e1, { agent: "a-1", kind: "egress", t: 11, method: "GET", url: "https://x.test/a", status: 200 });
  assert.deepEqual(e2, { agent: "a-1", kind: "egress", t: 12, method: "POST", url: "https://x.test/b", status: 500 });
  // The raw output never reaches the model.
  assert.equal(textOf(res), "session session:a-1:1\nexit 3\nscrubbed output");
  assert.ok(!JSON.stringify(res).includes("sk-secret"));

  // The log starts once, on the new machine only.
  f.m.fresh = false;
  f.steps.length = 0;
  assert.equal(textOf(await as("a-1", shell, { command: "ls" })), "session session:a-1:2\nexit 3\nscrubbed output");
  assert.deepEqual(f.steps, ["machine a-1", "exec", "record shell", "pull m-1", "record egress", "record egress"]);
});

test("shell: the time limit is 120 s by default and at most 900 s", async () => {
  const f = fakes();
  const shell = shellOf(f);
  for (const timeout_s of [undefined, 30, 900, 901, 100000, 0, -5, 2.9]) await as("a-1", shell, { command: "true", timeout_s });
  assert.deepEqual(f.m.calls.map((c) => c.seconds), [120, 30, 900, 900, 900, 120, 1, 2]);
});

test("shell: no agent, no shell", async () => {
  const f = fakes();
  await assert.rejects(shellOf(f).execute({ command: "id" }), /no agent/);
  assert.deepEqual(f.steps, []);
});

test("shell: no log, no shell; the next call starts the log again", async () => {
  const f = fakes({ startFails: 1 });
  const shell = shellOf(f);
  await assert.rejects(as("a-1", shell, { command: "id" }), /did not start/);
  assert.deepEqual(f.steps, ["machine a-1", "start m-1"]);
  assert.equal(f.m.calls.length, 0);
  assert.equal(f.entries.length, 0);
  // The machine is not new any more, but it still has no log.
  f.m.fresh = false;
  f.steps.length = 0;
  await as("a-1", shell, { command: "id" });
  assert.deepEqual(f.steps, ["machine a-1", "start m-1", "exec", "record shell", "pull m-1"]);
});

test("shell: a replaced machine puts the notice line first, once", async () => {
  const f = fakes({ replaced: true });
  const shell = shellOf(f);
  assert.equal(textOf(await as("a-1", shell, { command: "ls" })), `${REPLACED_NOTICE}\nsession session:a-1:1\nexit 0\nscrubbed output`);
  assert.equal(REPLACED_NOTICE, "The machine was replaced. Files from before are gone.");
  f.m.fresh = false;
  f.m.replaced = false;
  assert.equal(textOf(await as("a-1", shell, { command: "ls" })), "session session:a-1:2\nexit 0\nscrubbed output");
});

test("shell: two calls of one child run one after the other", async () => {
  const f = fakes();
  // Like roamMachine: only the call that made the machine sees `fresh`.
  const machine = async (ws, agent) => {
    const m = { ...(await f.machine(ws, agent)) };
    f.m.fresh = false;
    return m;
  };
  const shell = roamTools("/tmp/redteam-run-none", { record: f.record, egress: f.egress, machine })[0];
  const [a, b] = await Promise.all([as("a-1", shell, { command: "one" }), as("a-1", shell, { command: "two" })]);
  // The second call waits. So the log is up before any command runs.
  assert.deepEqual(f.steps, ["machine a-1", "start m-1", "exec", "record shell", "pull m-1", "machine a-1", "exec", "record shell", "pull m-1"]);
  assert.deepEqual(f.m.calls.map((c) => c.command), [`sh -c ${shq(`${ENV}one`)}`, `sh -c ${shq(`${ENV}two`)}`]);
  assert.match(textOf(a), /^session session:a-1:1\n/);
  assert.match(textOf(b), /^session session:a-1:2\n/);
});

test("roam.mjs starts no host process and reads no host environment", () => {
  const src = readFileSync(new URL("../lib/roam.mjs", import.meta.url), "utf8");
  assert.ok(!/child_process|process\.env|node:fs|runTool/.test(src));
  const local = [...src.matchAll(/from "(\.[^"]+)"/g)].map((x) => x[1]).sort();
  assert.deepEqual(local, ["./daytona.mjs", "./event.mjs"]);
});

// ---- Part 2: roamMachine against a fake Daytona API

const KEYS = ["TOUCHSTONE_EXEC", "DAYTONA_API_KEY", "DAYTONA_PENDING", "DAYTONA_RETRY_MS", "DAYTONA_STALE_MS", "EVENTS_FILE", "ROAM_TEST_HOST_SECRET"];

function fakeDaytona(dir) {
  // The result tar of a confined tool run (only the confined test reads it).
  const tarDir = join(dir, "res");
  mkdirSync(join(tarDir, "meta"), { recursive: true });
  writeFileSync(join(tarDir, "meta", "code"), "0\n");
  writeFileSync(join(tarDir, "meta", "out"), "hi");
  const resTar = execFileSync("tar", ["-cf", "-", "-C", tarDir, "."]);
  const fake = { calls: [], creates: [], deletes: [], execs: [], state: {}, createStatus: 200, n: 0 };
  const json = (o) => new Response(JSON.stringify(o), { status: 200 });
  fake.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    fake.calls.push({ method, u, body: typeof init.body === "string" ? init.body : "", headers: JSON.stringify(init.headers ?? {}) });
    if (u.includes("/snapshots")) return json({ state: "active" });
    if (method === "POST" && u.endsWith("/api/sandbox")) {
      if (fake.createStatus !== 200) return new Response("Snapshot not found", { status: fake.createStatus });
      const id = `m-${++fake.n}`;
      fake.creates.push(JSON.parse(init.body));
      fake.state[id] = "started";
      return json({ id, toolboxProxyUrl: "https://tb.test" });
    }
    if (method === "DELETE") {
      const id = u.split("/").pop();
      fake.deletes.push(id);
      delete fake.state[id];
      return new Response("", { status: 200 });
    }
    if (u.includes("/api/sandbox?labels=")) return json({ items: [] });
    const got = u.match(/\/api\/sandbox\/([^/?]+)$/);
    if (got) return fake.state[got[1]] ? json({ id: got[1], state: fake.state[got[1]] }) : new Response("not found", { status: 404 });
    if (u.includes("/files/upload")) return new Response("", { status: 200 });
    if (u.includes("/files/download")) return new Response(resTar, { status: 200 });
    if (u.includes("/process/execute")) {
      const body = JSON.parse(init.body);
      fake.execs.push({ id: u.split("/process/")[0].split("/").pop(), ...body });
      return json({ exitCode: 0, result: body.command === "true" ? "" : RAW });
    }
    return new Response("unexpected", { status: 500 });
  };
  return fake;
}

async function withFake(fn) {
  const d = mkdtempSync(join(tmpdir(), "dtn-roam-"));
  const ws = mkdtempSync(join(tmpdir(), "redteam-run-"));
  const saved = { env: Object.fromEntries(KEYS.map((k) => [k, process.env[k]])), fetch: globalThis.fetch, log: console.log };
  const fake = fakeDaytona(d);
  const events = [];
  try {
    process.env.TOUCHSTONE_EXEC = "daytona";
    process.env.DAYTONA_API_KEY = "test-key-not-real";
    process.env.DAYTONA_PENDING = join(d, "pending.json");
    process.env.DAYTONA_RETRY_MS = "1";
    process.env.ROAM_TEST_HOST_SECRET = "host-secret-value";
    delete process.env.DAYTONA_STALE_MS;
    delete process.env.EVENTS_FILE;
    globalThis.fetch = fake.fetch;
    console.log = (line) => String(line).startsWith("EVENT ") && events.push(JSON.parse(String(line).slice(6)));
    await fn({ ws, fake, events });
  } finally {
    await closeRun(ws).catch(() => {});
    globalThis.fetch = saved.fetch;
    console.log = saved.log;
    for (const [k, v] of Object.entries(saved.env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(d, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
    rmSync(`${ws}.daytona.json`, { force: true });
  }
}

const sidecarOf = (ws) => JSON.parse(readFileSync(`${ws}.daytona.json`, "utf8"));
// A real shell tool on the real roamMachine. Only record() and egress are fakes.
function realShell(ws) {
  const f = fakes();
  return { f, shell: roamTools(ws, { record: f.record, egress: f.egress })[0] };
}

test("one machine per free-roam child, kept between calls, deleted at run end", async () => {
  await withFake(async ({ ws, fake, events }) => {
    const { f, shell } = realShell(ws);
    assert.equal(textOf(await as("a-1", shell, { command: "touch /root/x", timeout_s: 7 })), "session session:a-1:1\nexit 0\nscrubbed output");
    await as("a-1", shell, { command: "ls /root" });
    await as("a-2", shell, { command: "id" });

    // a-1 made one machine and used it twice. a-2 has its own.
    assert.equal(fake.creates.length, 2);
    assert.deepEqual(f.steps.filter((s) => s.startsWith("start")), ["start m-1", "start m-2"]);
    assert.deepEqual(f.entries.map((e) => e.sandbox), ["m-1", "m-1", "m-2"]);
    assert.deepEqual(sidecarOf(ws), { "roam:a-1": { id: "m-1", toolbox: "https://tb.test/m-1" }, "roam:a-2": { id: "m-2", toolbox: "https://tb.test/m-2" } });

    // A container snapshot that Daytona has, root, and the long lifecycle.
    const { labels, ...body } = fake.creates[0];
    assert.equal(ROAM_SNAPSHOT, "daytona-medium");
    assert.deepEqual(body, { snapshot: ROAM_SNAPSHOT, target: "us-west-3", user: "root", autoStopInterval: 60, autoDeleteInterval: 240 });
    assert.deepEqual({ ...labels, nonce: "", run: "" }, { touchstone: "1", agent: "a-1", nonce: "", run: "", loadout: "free-roam" });
    assert.deepEqual(events.map(({ t, run, ...e }) => e), [
      { ev: "exec-machine", agent: "a-1", backend: "daytona", sandbox: "m-1", loadout: "free-roam" },
      { ev: "exec-machine", agent: "a-2", backend: "daytona", sandbox: "m-2", loadout: "free-roam" },
    ]);
    assert.equal(events[0].run, labels.run);

    // The command is in the request body of the toolbox call, with the time limit.
    assert.deepEqual(fake.execs.filter((x) => x.command !== "true"), [
      { id: "m-1", command: `sh -c ${shq(`${ENV}touch /root/x`)}`, timeout: 7 },
      { id: "m-1", command: `sh -c ${shq(`${ENV}ls /root`)}`, timeout: 120 },
      { id: "m-2", command: `sh -c ${shq(`${ENV}id`)}`, timeout: 120 },
    ]);
    // It never asks for a snapshot, and nothing from the host goes along.
    assert.ok(!fake.calls.some((c) => c.u.includes("/snapshots")));
    assert.ok(fake.calls.every((c) => c.headers.includes("test-key-not-real")));
    for (const c of fake.calls) assert.ok(!/test-key-not-real|host-secret-value/.test(c.body + c.u), c.u);

    assert.deepEqual((await closeRun(ws)).sort(), ["m-1", "m-2"]);
    assert.deepEqual(fake.deletes.sort(), ["m-1", "m-2"]);
    assert.ok(!existsSync(`${ws}.daytona.json`));
  });
});

test("the machine object has only id, fresh, replaced, exec and upload", async () => {
  await withFake(async ({ ws }) => {
    const m = await roamMachine(ws, "a-1");
    assert.deepEqual(Object.keys(m).sort(), ["exec", "fresh", "id", "replaced", "upload"]);
    assert.deepEqual([m.id, m.fresh, m.replaced], ["m-1", true, false]);
    assert.deepEqual(await m.exec("echo hi", 5), { exitCode: 0, result: RAW });
    const again = await roamMachine(ws, "a-1");
    assert.deepEqual([again.id, again.fresh, again.replaced], ["m-1", false, false]);
  });
});

test("free-roam never runs on this computer: without Daytona it throws", async () => {
  await withFake(async ({ ws, fake }) => {
    const { f, shell } = realShell(ws);
    for (const off of [() => delete process.env.DAYTONA_API_KEY, () => { process.env.DAYTONA_API_KEY = "test-key-not-real"; process.env.TOUCHSTONE_EXEC = "local"; }]) {
      off();
      await assert.rejects(as("a-1", shell, { command: "id" }), /never runs on this computer/);
    }
    assert.equal(fake.calls.length, 0);
    assert.deepEqual(f.steps, []);
    assert.ok(!existsSync(`${ws}.daytona.json`));
  });
});

for (const lostAs of ["stopped", "destroyed", "404"]) {
  test(`a ${lostAs} machine is replaced, with the event and the notice line`, async () => {
    await withFake(async ({ ws, fake, events }) => {
      process.env.DAYTONA_STALE_MS = "-1"; // check the machine's state on every call
      const { f, shell } = realShell(ws);
      await as("a-1", shell, { command: "touch /root/x" });
      if (lostAs === "404") delete fake.state["m-1"];
      else fake.state["m-1"] = lostAs;

      assert.equal(textOf(await as("a-1", shell, { command: "ls /root" })), `${REPLACED_NOTICE}\nsession session:a-1:2\nexit 0\nscrubbed output`);
      assert.equal(textOf(await as("a-1", shell, { command: "ls /root" })), "session session:a-1:3\nexit 0\nscrubbed output");

      assert.equal(fake.creates.length, 2);
      // Nothing starts the old machine again. It is deleted.
      assert.ok(!fake.calls.some((c) => /\/start\b/.test(c.u)));
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(fake.deletes, ["m-1"]);
      assert.deepEqual(sidecarOf(ws), { "roam:a-1": { id: "m-2", toolbox: "https://tb.test/m-2" } });
      assert.deepEqual(events.map(({ t, run, agent, backend, ev, ...e }) => e), [{ sandbox: "m-1", loadout: "free-roam" }, { sandbox: "m-2", loadout: "free-roam", replaced: true }]);
      // The new machine gets its own log before the command runs.
      assert.deepEqual(f.steps.filter((s) => s.startsWith("start")), ["start m-1", "start m-2"]);
      assert.deepEqual(f.entries.map((e) => e.sandbox), ["m-1", "m-2", "m-2"]);
    });
  });
}

test("a machine from an earlier worker of the run: used when it runs, replaced when it stopped", async () => {
  await withFake(async ({ ws, fake, events }) => {
    fake.state.old1 = "started";
    fake.state.old2 = "stopped";
    writeFileSync(`${ws}.daytona.json`, JSON.stringify({ "roam:a-1": { id: "old1", toolbox: "https://tb.test/old1" }, "roam:a-2": { id: "old2", toolbox: "https://tb.test/old2" } }));
    const kept = await roamMachine(ws, "a-1");
    assert.deepEqual([kept.id, kept.fresh, kept.replaced], ["old1", false, false]);
    const made = await roamMachine(ws, "a-2");
    assert.deepEqual([made.id, made.fresh, made.replaced], ["m-1", true, true]);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(fake.deletes, ["old2"]);
    assert.equal(fake.creates.length, 1);
    assert.deepEqual(sidecarOf(ws), { "roam:a-1": { id: "old1", toolbox: "https://tb.test/old1" }, "roam:a-2": { id: "m-1", toolbox: "https://tb.test/m-1" } });
    assert.deepEqual(events.map((e) => [e.sandbox, e.replaced]), [["m-1", true]]);
  });
});

test("a 404 on the snapshot is an error for the operator; no snapshot is created", async () => {
  await withFake(async ({ ws, fake }) => {
    fake.createStatus = 404;
    const { f, shell } = realShell(ws);
    await assert.rejects(as("a-1", shell, { command: "id" }), (e) => {
      assert.match(e.message, /snapshot "daytona-medium"/);
      assert.match(e.message, /TOUCHSTONE_ROAM_SNAPSHOT/);
      assert.match(e.message, /never creates/);
      return true;
    });
    assert.ok(!fake.calls.some((c) => c.u.includes("/snapshots")));
    assert.deepEqual(f.steps, []);
    assert.ok(!existsSync(`${ws}.daytona.json`));
    // The failure is not kept: the next call asks Daytona again.
    fake.createStatus = 200;
    assert.match(textOf(await as("a-1", shell, { command: "id" })), /^session session:a-1:1\n/);
  });
});

test("a confined tool machine still gets its own snapshot, 15 idle minutes and delete at stop", async () => {
  await withFake(async ({ ws, fake }) => {
    const r = await remoteDocker(["run", "--rm", "--network", "none", "-v", `${ws}:/work`, "-w", "/work", "img:1", "true"], { ws });
    assert.equal(r?.stdout, "hi");
    assert.equal(fake.creates.length, 1);
    const { labels, ...body } = fake.creates[0];
    assert.deepEqual(body, { snapshot: "touchstone-exec-dind-v1", target: "us-west-3", user: "root", autoStopInterval: 15, autoDeleteInterval: 0 });
    assert.equal(labels.loadout, undefined);
  });
});
