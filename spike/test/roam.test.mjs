// Tests for the free-roam machine (lib/daytona.mjs roamMachine) and its
// `shell` tool (lib/roam.mjs).
//
// Part 1 gives `shell` a fake machine, a fake `record` and a fake `egress`.
// Part 2 uses the real roamMachine against a fake Daytona API. No machine, no
// network, no key, no cost.
import "./helpers/isolated-env.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execConfig, closeRun, remoteDocker, roamMachine, shq } from "../lib/daytona.mjs";
import { checkRoamSelection, SHELL_PROBE_VERSION } from "../lib/daytona-setup.mjs";
import { beginRoamOperation, roamBinding, roamAccountBinding, setRoamSelectionState, updateRoamOperation } from "../lib/daytona-state.mjs";
import { createHash } from "node:crypto";
import { withAgent } from "../lib/event.mjs";
let REPLACED_NOTICE, roamTools;
let moduleId = 0;
beforeEach(async () => {
  // Each fake machine set represents a fresh worker registry, not reused ids.
  ({ REPLACED_NOTICE, roamTools } = await import(`../lib/roam.mjs?test=${++moduleId}`));
});
const supervisorAnswer = (q, exitCode = 0) => ({ exitCode: 0, result: JSON.stringify({
  ok: true, id: q.id, generation: "fake-supervisor", epoch: 0,
  ...(q.op === "run" ? { exitCode, result: RAW } : { ack: true, state: "active", scope: "managed-shell" }),
}) });

// The value lane B's EGRESS_ENV has.
const ENV = "export HTTP_PROXY=http://127.0.0.1:8899 HTTPS_PROXY=http://127.0.0.1:8899 http_proxy=http://127.0.0.1:8899 https_proxy=http://127.0.0.1:8899; ";
const RAW = "raw output with sk-secret-0000";
const textOf = (res) => res.output[0].text;

// A fake record(), egress and machine. `steps` holds what ran, in order.
function fakes({ id = "m-1", fresh = true, replaced = false, exitCode = 0, startFails = 0, pullFails = 0, pulled = [] } = {}) {
  const steps = [];
  const entries = [];
  let n = 0;
  const m = {
    id, fresh, replaced,
    exec: async (command, seconds) => {
      assert.match(command, /^node \/tmp\/touchstone-shell-control\.mjs [a-f0-9-]{36}$/);
      const q = m.uploads.get(command.split(" ").at(-1));
      if (q.op === "run") {
        steps.push("exec");
        m.calls.push({ command: q.command, seconds: q.seconds });
      }
      return supervisorAnswer(q, exitCode);
    },
    upload: async (path, bytes) => { if (path.endsWith(".json")) { const q = JSON.parse(bytes); m.uploads.set(q.id, q); } },
    uploads: new Map(), calls: [],
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
        if (pullFails-- > 0) throw new Error("pull failed: machine text sk-secret-0000");
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
  // The command goes in the uploaded supervisor payload, after the proxy variables.
  assert.deepEqual(f.m.calls, [{ command: `${ENV}echo 'hi' && id`, seconds: 120 }]);
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
  assert.deepEqual(f.m.calls.map((c) => c.command), [`${ENV}one`, `${ENV}two`]);
  assert.match(textOf(a), /^session session:a-1:1\n/);
  assert.match(textOf(b), /^session session:a-1:2\n/);
});

test("shell: a machine that is not new still gets its log before the first command", async () => {
  // roamMachine gives `fresh: false` for a machine it took from the sidecar.
  const f = fakes({ id: "old1", fresh: false });
  const shell = shellOf(f);
  await as("a-1", shell, { command: "id" });
  await as("a-1", shell, { command: "id" });
  assert.deepEqual(f.steps, ["machine a-1", "start old1", "exec", "record shell", "pull old1", "machine a-1", "exec", "record shell", "pull old1"]);
});

test("shell: the log cannot be read after the command; the model still gets the result", async () => {
  const f = fakes({ pullFails: 1 });
  const shell = shellOf(f);
  const res = await as("a-1", shell, { command: "curl https://x.test" });
  assert.equal(textOf(res), "session session:a-1:1\nexit 0\nscrubbed output\nThe request log could not be read after this command. It is read again on the next call.");
  assert.ok(!JSON.stringify(res).includes("sk-secret"));
  assert.deepEqual(f.entries.map((e) => e.kind), ["shell"]);
  // The next call starts the log again, before it runs anything.
  f.m.fresh = false;
  f.steps.length = 0;
  assert.equal(textOf(await as("a-1", shell, { command: "id" })), "session session:a-1:2\nexit 0\nscrubbed output");
  assert.deepEqual(f.steps, ["machine a-1", "start m-1", "exec", "record shell", "pull m-1"]);
});

test("shell: no exit code records empty output and throws fixed text", async () => {
  const f = fakes();
  f.m.exec = async () => ({ exitCode: undefined, result: RAW });
  await assert.rejects(as("a-1", shellOf(f), { command: "id" }), (e) => {
    assert.equal(e.message, "The command did not finish on the machine (HTTP no answer). It may still be running.");
    assert.equal(e.cause, undefined);
    return true;
  });
  assert.deepEqual({ ...f.entries[0], t: 0 }, { agent: "a-1", kind: "shell", t: 0, sandbox: "m-1", command: "id", exit_code: undefined, output: "" });
  assert.deepEqual(f.steps, ["machine a-1", "start m-1", "record shell"]);
});

test("shell: the description does not say that the session line is first", () => {
  const { description } = shellOf(fakes());
  assert.match(description, /a line that starts with "session"/);
  assert.ok(!/starts with a session id line|first line/.test(description));
});

test("roam.mjs starts no host process and reads no host environment", () => {
  const src = readFileSync(new URL("../lib/roam.mjs", import.meta.url), "utf8");
  assert.ok(!/child_process|process\.env|runTool/.test(src));
  assert.match(src, /readFileSync\(new URL\("\.\.\/roam\/shell-control\.mjs"/);
  const local = [...src.matchAll(/from "(\.[^"]+)"/g)].map((x) => x[1]).sort();
  assert.deepEqual(local, ["./daytona.mjs", "./event.mjs"]);
});

// ---- Part 2: roamMachine against a fake Daytona API

const KEYS = ["TOUCHSTONE_ROAM_SNAPSHOT", "TOUCHSTONE_DAYTONA_STATE_FILE","TOUCHSTONE_EXEC", "DAYTONA_API_KEY", "DAYTONA_PENDING", "DAYTONA_RETRY_MS", "DAYTONA_STALE_MS", "EVENTS_FILE", "ROAM_TEST_HOST_SECRET"];

function fakeDaytona(dir) {
  // The result tar of a confined tool run (only the confined test reads it).
  const tarDir = join(dir, "res");
  mkdirSync(join(tarDir, "meta"), { recursive: true });
  writeFileSync(join(tarDir, "meta", "code"), "0\n");
  writeFileSync(join(tarDir, "meta", "out"), "hi");
  const resTar = execFileSync("tar", ["-cf", "-", "-C", tarDir, "."]);
  // onExec(body) may return a Response for one toolbox exec call.
  const fake = { calls: [], creates: [], deletes: [], execs: [], uploads: new Map(), state: {}, createStatus: 200, n: 0, onExec: null };
  const json = (o) => new Response(JSON.stringify(o), { status: 200 });
  fake.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    fake.calls.push({ method, u, body: typeof init.body === "string" ? init.body : "", headers: JSON.stringify(init.headers ?? {}) });
    if (u.endsWith("/regions")) return json([{ id: "r-west", name: "us-west-3" }]);
    if (u.includes("/snapshots")) return json({ id: "selected-shell", name: "selected-shell", state: "active", regionIds: ["r-west"], sandboxClass: "container", ref: "test-ref" });
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
    if (u.includes("/files/upload")) {
      const path = new URL(u).searchParams.get("path");
      if (path.endsWith(".json")) {
        const q = JSON.parse(await init.body.get("file").text());
        fake.uploads.set(q.id, q);
      }
      return new Response("", { status: 200 });
    }
    if (u.includes("/files/download")) return new Response(resTar, { status: 200 });
    if (u.includes("/process/execute")) {
      const body = JSON.parse(init.body);
      const id = u.split("/process/")[0].split("/").pop();
      const q = fake.uploads.get(body.command.split(" ").at(-1));
      if (!q || q.op === "run") fake.execs.push({ id, ...(q ? { command: q.command, timeout: q.seconds } : body) });
      const own = fake.onExec?.(body);
      if (own) return own;
      return json(q ? supervisorAnswer(q) : { exitCode: 0, result: body.command === "true" ? "" : RAW });
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
    process.env.TOUCHSTONE_DAYTONA_STATE_FILE = join(d, "setup.json");
    process.env.TOUCHSTONE_ROAM_SNAPSHOT = "selected-shell";
    process.env.DAYTONA_PENDING = join(d, "pending.json");
    process.env.DAYTONA_RETRY_MS = "1";
    process.env.ROAM_TEST_HOST_SECRET = "host-secret-value";
    delete process.env.DAYTONA_STALE_MS;
    delete process.env.EVENTS_FILE;
    globalThis.fetch = fake.fetch;
    console.log = (line) => String(line).startsWith("EVENT ") && events.push(JSON.parse(String(line).slice(6)));
    const config = execConfig();
    const selected = await checkRoamSelection(config);
    setRoamSelectionState(roamBinding(config), "verified", { ...selected, probeVersion: SHELL_PROBE_VERSION, verificationId: "test-proof" });
    fake.calls.length = 0;
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

const sidecarOf = (ws) => Object.fromEntries(Object.entries(JSON.parse(readFileSync(`${ws}.daytona.json`, "utf8"))).map(([key, { id, toolbox }]) => [key, { id, toolbox }]));
function seedSidecar(ws, entries) {
  const config = execConfig();
  const run = createHash("sha256").update(ws).digest("hex");
  for (const [key, entry] of Object.entries(entries)) {
    const slot = createHash("sha256").update(JSON.stringify([ws, key.slice(5), "test-proof"])).digest("hex");
    const { operation } = beginRoamOperation(config, "runtime", slot, { run });
    updateRoamOperation(operation.binding, operation.id, "intent", "created", entry.id);
    Object.assign(entry, { account: roamAccountBinding(config), binding: operation.binding, operationId: operation.id });
  }
  writeFileSync(`${ws}.daytona.json`, JSON.stringify(entries));
}
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
    assert.deepEqual(body, { snapshot: "selected-shell", target: "us-west-3", user: "root", autoStopInterval: 60, autoDeleteInterval: 240 });
    assert.deepEqual({ ...labels, nonce: "", run: "" }, { touchstone: "1", agent: "a-1", nonce: "", run: "", loadout: "free-roam" });
    assert.deepEqual(events.map(({ t, run, ...e }) => e), [
      { ev: "exec-machine", agent: "a-1", backend: "daytona", sandbox: "m-1", loadout: "free-roam" },
      { ev: "exec-machine", agent: "a-2", backend: "daytona", sandbox: "m-2", loadout: "free-roam" },
    ]);
    assert.equal(events[0].run, labels.run);

    // The fake decodes the uploaded supervisor payload, including its own deadline.
    assert.deepEqual(fake.execs.filter((x) => x.command !== "true"), [
      { id: "m-1", command: `${ENV}touch /root/x`, timeout: 7 },
      { id: "m-1", command: `${ENV}ls /root`, timeout: 120 },
      { id: "m-2", command: `${ENV}id`, timeout: 120 },
    ]);
    // Snapshot metadata is checked without registering a snapshot.
    assert.ok(!fake.calls.some((c) => c.method === "POST" && c.u.includes("/snapshots")));
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
    seedSidecar(ws, { "roam:a-1": { id: "old1", toolbox: "https://tb.test/old1" }, "roam:a-2": { id: "old2", toolbox: "https://tb.test/old2" } });
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

test("a create rejection is fixed and stays blocked until explicit verification", async () => {
  await withFake(async ({ ws, fake }) => {
    fake.createStatus = 404;
    await assert.rejects(roamMachine(ws, "a-1"), { code: "daytona_rejected" });
    assert.ok(!fake.calls.some((c) => c.method === "POST" && c.u.includes("/snapshots")));
    fake.createStatus = 200;
    await assert.rejects(roamMachine(ws, "a-1"), { code: "daytona_shell_unverified" });
    assert.equal(fake.creates.length, 0);
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

// A real shell that notes, at each egress.start, the commands that already ran.
function orderedShell(ws, fake) {
  const { f, shell } = realShell(ws);
  const start = f.egress.start;
  f.ranBeforeStart = [];
  f.egress.start = async (m) => {
    f.ranBeforeStart.push(fake.execs.filter((x) => x.command !== "true").map((x) => x.id));
    return start(m);
  };
  return { f, shell };
}

test("the ready check fails once: the next call still starts the log before the command", async () => {
  await withFake(async ({ ws, fake }) => {
    const { f, shell } = orderedShell(ws, fake);
    fake.onExec = () => {
      fake.onExec = null;
      return new Response("toolbox text sk-secret-0000", { status: 404 });
    };
    // The error is a fixed text. It holds nothing of what the toolbox answered.
    await assert.rejects(as("a-1", shell, { command: "id" }), (e) => {
      assert.equal(e.message, "The free-roam machine is not ready (HTTP 404).");
      return true;
    });
    assert.deepEqual(f.steps, []);
    // The machine is in the sidecar now. So the next call does not make it, and gets `fresh: false`.
    await as("a-1", shell, { command: "id" });
    assert.equal(fake.creates.length, 1);
    assert.deepEqual(f.steps, ["start m-1", "record shell", "pull m-1"]);
    assert.deepEqual(f.ranBeforeStart, [[]]);
    assert.deepEqual(fake.execs.map((x) => x.command), ["true", "true", `${ENV}id`]);
  });
});

test("a machine from the sidecar gets its log before the first command", async () => {
  await withFake(async ({ ws, fake }) => {
    fake.state.old1 = "started";
    seedSidecar(ws, { "roam:a-1": { id: "old1", toolbox: "https://tb.test/old1" } });
    const { f, shell } = orderedShell(ws, fake);
    await as("a-1", shell, { command: "id" });
    await as("a-1", shell, { command: "id" });
    assert.equal(fake.creates.length, 0);
    assert.deepEqual(f.steps, ["start old1", "record shell", "pull old1", "record shell", "pull old1"]);
    assert.deepEqual(f.ranBeforeStart, [[]]);
    assert.deepEqual(f.entries.map((e) => e.sandbox), ["old1", "old1"]);
  });
});

test("the command call fails: a shell entry is recorded and the model sees a fixed text", async () => {
  await withFake(async ({ ws, fake }) => {
    const { f, shell } = realShell(ws);
    fake.onExec = (body) => (body.command === "true" ? null : new Response("machine text sk-secret-0000 from the toolbox", { status: 500 }));
    await assert.rejects(as("a-1", shell, { command: "sleep 9999" }), (e) => {
      assert.equal(e.message, "The command did not finish on the machine (HTTP 500). It may still be running.");
      assert.equal(e.cause, undefined);
      return true;
    });
    assert.deepEqual(f.steps, ["start m-1", "record shell"]);
    assert.deepEqual({ ...f.entries[0], t: 0 }, { agent: "a-1", kind: "shell", t: 0, sandbox: "m-1", command: "sleep 9999", exit_code: undefined, output: "" });
    // No answer at all (the connection broke) has no status.
    fake.onExec = (body) => {
      if (body.command !== "true") throw new Error("socket text sk-secret-0000");
    };
    await assert.rejects(as("a-1", shell, { command: "id" }), (e) => {
      assert.equal(e.message, "The command did not finish on the machine (HTTP no answer). It may still be running.");
      return true;
    });
    assert.equal(f.entries.length, 2);
  });
});

test("a huge answer of a roam exec: this computer keeps only its last 4 MB", async () => {
  await withFake(async ({ ws, fake }) => {
    const MAX = 4 * 1024 * 1024;
    const out = Array.from({ length: 300_000 }, (_, i) => `line ${i} "quoted" \\ é\n`).join("") + "THE END";
    assert.ok(Buffer.byteLength(JSON.stringify(out)) > MAX + 500_000);
    // The body comes in small parts, like a real HTTP answer.
    const stream = (text) => {
      const bytes = Buffer.from(text);
      let at = 0;
      return new Response(new ReadableStream({
        pull(c) {
          if (at >= bytes.length) return c.close();
          c.enqueue(bytes.subarray(at, (at += 65_536)));
        },
      }), { status: 200 });
    };
    const m = await roamMachine(ws, "a-1");
    for (const [body, code] of [
      [`{"exitCode":7,"result":${JSON.stringify(out)}}`, 7],
      [`{"result":${JSON.stringify(out)},"exitCode":7}`, 7],
      [`{"code":7,"result":${JSON.stringify(out)}}`, 7],
      [`{"result":${JSON.stringify(out)},"code":7}`, 7],
      [`{"exitCode":7,"result":${JSON.stringify(out)},"code":0}`, 7],
      [`{"code":0,"result":${JSON.stringify(out)},"exitCode":7}`, 7],
    ]) {
      fake.onExec = () => stream(body);
      const r = await m.exec("yes", 5);
      assert.equal(r.exitCode, code);
      assert.ok(Buffer.byteLength(r.result) <= MAX);
      assert.ok(r.result.length > 2_000_000);
      assert.ok(r.result.endsWith('"quoted" \\ é\nTHE END'));
      // It is the tail of the output. Only its first characters may be damaged by the cut.
      assert.ok(out.endsWith(r.result.slice(8)));
    }
    fake.onExec = () => stream(`{"exitCode":"invalid","result":${JSON.stringify(out)},"code":0}`);
    await assert.rejects(m.exec("yes", 5), { code: "daytona_response_invalid" });
    // A small answer is read whole, as before.
    fake.onExec = () => stream(JSON.stringify({ exitCode: 0, result: "small \n \"x\"" }));
    assert.deepEqual(await m.exec("id", 5), { exitCode: 0, result: 'small \n "x"' });
    fake.onExec = () => stream("﻿" + JSON.stringify({ exitCode: 0, result: "BOM é" }));
    assert.deepEqual(await m.exec("id", 5), { exitCode: 0, result: "BOM é" });
  });
});

for (const failure of ["upload", "startup JSON"]) {
  test(`shell hides ${failure} failure and retries startup without a user command`, async () => {
    await withFake(async ({ ws, fake }) => {
      const { f, shell } = realShell(ws);
      let starts = 0;
      let fail = true;
      const fetch = globalThis.fetch;
      globalThis.fetch = (url, init) => fail && failure === "upload" && String(url).includes("/files/upload")
        ? Promise.resolve(new Response("MACHINE_SECRET_UPLOAD", { status: 500 })) : fetch(url, init);
      fake.onExec = ({ command }) => fail && failure === "startup JSON" && command === "start-log"
        ? new Response("MACHINE_SECRET_PARSE") : null;
      f.egress.start = async (m) => {
        starts++;
        await m.upload("/tmp/log-script", Buffer.from("log script fixture"));
        await m.exec("start-log", 5);
      };
      await assert.rejects(as("a-1", shell, { command: "user-command" }), (e) => {
        assert.equal(e.message, "The request log did not start. No log, no shell.");
        assert.equal(e.cause, undefined);
        return true;
      });
      assert.equal(starts, 1);
      assert.deepEqual(f.entries, []);
      assert.ok(fake.execs.every((e) => e.command === "true" || e.command === "start-log"));
      fail = false;
      assert.equal(textOf(await as("a-1", shell, { command: "user-command" })), "session session:a-1:1\nexit 0\nscrubbed output");
      assert.equal(starts, 2);
      assert.equal(f.entries.length, 1);
      assert.equal(fake.execs.at(-2).command, "start-log");
      assert.equal(fake.execs.at(-1).command, `${ENV}user-command`);
      await as("a-1", shell, { command: "user-command" });
      assert.equal(starts, 2);
    });
  });
}

for (const fragmented of [false, true]) {
  test(`roam reader bounds its retained buffers: ${fragmented ? "fragmented prefix and many chunks" : "one 64 MiB chunk"}`, async (t) => {
    await withFake(async ({ ws, fake }) => {
      const MAX = 4 * 1024 * 1024;
      const m = await roamMachine(ws, "a-1");
      const bytes = Buffer.from(`{"exitCode":7,"result":"${"x".repeat(fragmented ? MAX + 1234 : 64 * 1024 * 1024)}END"}`);
      const allocations = [];
      const destinations = new Set();
      // Observe allocations by this reader, excluding the fixture and HTTP machinery.
      for (const name of ["alloc", "allocUnsafe", "allocUnsafeSlow", "from", "concat"]) {
        const original = Buffer[name];
        t.mock.method(Buffer, name, function (...args) {
          const result = Reflect.apply(original, this, args);
          if (new Error().stack.includes("at cappedExec")) allocations.push(result);
          return result;
        });
      }
      const set = Buffer.prototype.set;
      t.mock.method(Buffer.prototype, "set", function (source, offset) {
        if (allocations.includes(this)) {
          assert.ok(source.byteLength <= MAX);
          assert.notEqual(this.buffer, bytes.buffer);
          destinations.add(this);
        }
        return Reflect.apply(set, this, [source, offset]);
      });
      fake.onExec = () => ({ ok: true, body: (async function* () {
        let at = 0;
        while (at < bytes.length) {
          const end = Math.min(bytes.length, at + (fragmented ? (at < 64 ? 1 : 257) : bytes.length));
          const chunk = bytes.subarray(at, end);
          yield chunk;
          // Reusing incoming storage must not alter the retained prefix or tail.
          chunk.fill(0);
          at = end;
        }
      })() });
      try {
        const r = await m.exec("large-output", 5);
        assert.equal(r.exitCode, 7);
        assert.equal(r.result, "x".repeat(MAX - 5) + "END");
        assert.deepEqual(allocations.map((b) => b.length), [MAX, 64]);
        assert.deepEqual(allocations.map((b) => b.buffer.byteLength), [MAX, 64]);
        assert.equal(destinations.size, 2);
      } finally {
        t.mock.restoreAll();
      }
    });
  });
}

test("roam reader resets the write position for an oversized final chunk", async () => {
  await withFake(async ({ ws, fake }) => {
    const MAX = 4 * 1024 * 1024;
    const m = await roamMachine(ws, "a-1");
    const output = "0123456789abcdefghijklmnopqrstuvwxyz".repeat(120_000) + "END";
    const bytes = Buffer.from(JSON.stringify({ exitCode: 7, result: output }));
    assert.ok(bytes.length - 19 > MAX);
    fake.onExec = () => ({ ok: true, body: (async function* () {
      yield bytes.subarray(0, 19);
      yield bytes.subarray(19);
    })() });
    // The ASCII tail contains output followed by the two closing JSON bytes.
    assert.deepEqual(await m.exec("large-output", 5), { exitCode: 7, result: output.slice(-(MAX - 2)) });
  });
});

test("shell treats a capped answer with no recoverable exit code as a failed command", async () => {
  await withFake(async ({ ws, fake }) => {
    const { f, shell } = realShell(ws);
    fake.onExec = ({ command }) => command === "true" ? null
      : new Response(JSON.stringify({ result: "x".repeat(5 * 1024 * 1024) }));
    await assert.rejects(as("a-1", shell, { command: "id" }), (e) => {
      assert.equal(e.message, "The command did not finish on the machine (HTTP no answer). It may still be running.");
      assert.equal(e.cause, undefined);
      return true;
    });
    assert.deepEqual({ ...f.entries[0], t: 0 }, { agent: "a-1", kind: "shell", t: 0, sandbox: "m-1", command: "id", exit_code: undefined, output: "" });
    assert.deepEqual(f.steps, ["start m-1", "record shell"]);
  });
});
