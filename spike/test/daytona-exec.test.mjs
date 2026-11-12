// Tests for the Daytona execution backend (lib/daytona.mjs).
//
// The pure parts run everywhere. The fallback test needs local Docker. The live
// test makes real Daytona machines, so it runs only when asked:
//   TOUCHSTONE_EXEC_LIVE=1 DAYTONA_API_KEY=... node --test spike/test/daytona-exec.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeRun, delta, execConfig, planRemote, readPending, runRoot, scan, shq, warmScript } from "../lib/daytona.mjs";

const hasDocker = (() => {
  try { execFileSync("docker", ["image", "inspect", "debian:bookworm-slim"], { stdio: "ignore" }); return true; } catch { return false; }
})();

test("execConfig: local by default, env beats Settings, key from either", () => {
  assert.equal(execConfig({}, {}).backend, "local");
  assert.equal(execConfig({}, { execution: { backend: "daytona" } }).backend, "daytona");
  assert.equal(execConfig({ TOUCHSTONE_EXEC: "local" }, { execution: { backend: "daytona" } }).backend, "local");
  assert.equal(execConfig({ TOUCHSTONE_EXEC: "daytona" }, {}).backend, "daytona");
  assert.equal(execConfig({ TOUCHSTONE_EXEC: "bogus" }, {}).backend, "local");
  const env = execConfig({ DAYTONA_API_KEY: "k-env" }, {});
  assert.equal(env.apiKey, "k-env");
  assert.equal(env.keySource, "env");
  const saved = execConfig({ DAYTONA_API_KEY: "k-env" }, { execution: { apiKey: "k-set" } });
  assert.equal(saved.apiKey, "k-set");
  assert.equal(saved.keySource, "settings");
  assert.equal(execConfig({}, {}).keySource, null);
  assert.equal(execConfig({}, {}).target, "us-west-3");
  assert.equal(execConfig({ DAYTONA_TARGET: "eu" }, {}).target, "eu");
});

test("planRemote rewrites the workspace mount and keeps named volumes", () => {
  const ws = "/tmp/redteam-run-abc";
  const args = ["run", "--rm", "--network", "none", "--cap-drop", "ALL", "--user", "1000:1000",
    "-v", "foundry-svm:/home/foundry/.svm", "-v", `${ws}:/work`, "-w", "/work",
    "-e", "A=b c", "img:1", "forge", "test", "-v", "x"];
  const p = planRemote(args, ws, "/ts/w/1");
  assert.equal(p.local, null);
  assert.equal(p.image, "img:1");
  assert.deepEqual(p.args, ["--rm", "--network", "none", "--cap-drop", "ALL", "--user", "1000:1000",
    "-v", "foundry-svm:/home/foundry/.svm", "-v", "/ts/w/1:/work", "-w", "/work",
    "-e", "A=b c", "img:1", "forge", "test", "-v", "x"]);
});

test("planRemote keeps host networks and foreign mounts local", () => {
  assert.match(planRemote(["run", "--network", "host", "img"], null, null).local, /network host/);
  assert.match(planRemote(["run", "--network", "touchstone-lab", "img"], null, null).local, /network/);
  // Until the reach gate covers the remote path, only --network none goes remote.
  assert.match(planRemote(["run", "--network", "bridge", "img"], null, null).local, /network bridge/);
  assert.match(planRemote(["run", "--network=bridge", "img"], null, null).local, /network bridge/);
  assert.match(planRemote(["run", "--net", "default", "img"], null, null).local, /network default/);
  assert.match(planRemote(["run", "img"], null, null).local, /network default/);
  assert.equal(planRemote(["run", "--network", "none", "img"], null, null).local, null);
  assert.equal(planRemote(["run", "--network=none", "img"], null, null).local, null);
  assert.match(planRemote(["run", "-v", "/etc:/x", "img"], "/tmp/ws", "/r").local, /host path/);
  assert.match(planRemote(["build", "."], null, null).local, /not a docker run/);
});

// E: the parser fails safe. A flag it does not know may take a value, so the
// image and the network after it cannot be trusted. Such a call stays local.
test("E: planRemote sends unknown flags and --flag=value forms to local Docker", () => {
  const ws = "/tmp/redteam-run-e";
  const t = (...a) => planRemote(["run", ...a], ws, "/r").local;
  assert.match(t("--network", "none", "--tmpfs", "/tmp", "img"), /--tmpfs/);
  // The reviewer's case: --tmpfs swallows nothing, and a later --network host
  // would win in docker. It must not go remote.
  assert.match(t("--network", "none", "--tmpfs", "/tmp", "--network", "host", "img"), /--tmpfs|network/);
  assert.match(t("--network", "none", "--network", "host", "img"), /twice/);
  assert.match(t("--network", "none", `--volume=${ws}:/work`, "img"), /--volume/);
  assert.match(t("--network", "none", "--volume=/etc:/x", "img"), /--volume/);
  assert.match(t("--network", "none", "--mount", "type=bind,src=/etc,dst=/x", "img"), /--mount/);
  assert.match(t("--network", "none", "--privileged", "img"), /--privileged/);
  assert.match(t("--network", "none", "-eA=b", "img"), /-eA/);
  assert.match(t("--network", "none", "--user=0", "img"), /--user/);
  // What runTool and the packs send still goes remote.
  assert.equal(t("--rm", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "512", "--memory", "2g", "--user", "1:1", "-v", `${ws}:/work`, "-w", "/work",
    "--entrypoint", "sh", "-e", "A=b", "img", "-c", "--tmpfs x"), null);
});

// A: the solc version comes from .touchstone.json, which a target or a
// container can write. It must never run as shell on the machine.
test("A: warmScript refuses anything but x.y.z and quotes the version", () => {
  const d = mkdtempSync(join(tmpdir(), "dtn-warm-"));
  const marker = join(d, "pwn");
  try {
    for (const bad of [`0.8.20'; touch ${marker}; echo '`, "0.8.20; touch x", "^0.8.20", "0.8", "$(id)", "", null]) {
      assert.throws(() => warmScript(bad), /not a solc version/, String(bad));
    }
    // A good version runs with a stub docker. It reaches docker as one word.
    const bin = join(d, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "docker"), `#!/bin/sh\nfor a; do printf '%s\\n' "$a"; done >>${shq(join(d, "argv"))}\n`, { mode: 0o755 });
    execFileSync("sh", ["-c", warmScript("0.8.20")], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    const argv = readFileSync(join(d, "argv"), "utf8").split("\n");
    assert.ok(argv.includes("forge build --use 0.8.20"), argv.join("|"));
    assert.ok(!existsSync(marker));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("shq quotes for sh", () => {
  assert.equal(shq("a b"), "'a b'");
  assert.equal(shq("it's"), "'it'\\''s'");
  const out = execFileSync("sh", ["-c", `printf %s ${shq("x'y $HOME \"z\"\n")}`]).toString();
  assert.equal(out, "x'y $HOME \"z\"\n");
});

test("scan and delta find new, changed, and removed entries", () => {
  const d = mkdtempSync(join(tmpdir(), "dtn-scan-"));
  try {
    mkdirSync(join(d, "a", "empty"), { recursive: true });
    writeFileSync(join(d, "a", "f.txt"), "1");
    writeFileSync(join(d, "g.txt"), "2");
    const s1 = scan(d);
    assert.deepEqual([...s1.keys()].sort(), ["a", "a/empty", "a/f.txt", "g.txt"]);
    assert.equal(s1.get("a/empty"), "dir");
    assert.deepEqual(delta(new Map(), s1).send.sort(), ["a", "a/empty", "a/f.txt", "g.txt"]);
    writeFileSync(join(d, "a", "f.txt"), "22");
    utimesSync(join(d, "a", "f.txt"), new Date(), new Date(Date.now() + 5000));
    rmSync(join(d, "g.txt"));
    writeFileSync(join(d, "h.txt"), "3");
    const { send, gone } = delta(s1, scan(d));
    assert.deepEqual(send.sort(), ["a/f.txt", "h.txt"]);
    assert.deepEqual(gone, ["g.txt"]);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// Outside the tmp base (a real operator repo), the nearest .touchstone.json
// names the run. Here d plays a repo path: the tmp base is another dir.
test("runRoot finds the run workspace above a path", () => {
  const d = mkdtempSync(join(tmpdir(), "dtn-root-"));
  const base = mkdtempSync(join(tmpdir(), "dtn-base-"));
  try {
    mkdirSync(join(d, "sub", "deep"), { recursive: true });
    assert.equal(runRoot(join(d, "sub"), base), null);
    writeFileSync(join(d, ".touchstone.json"), "{}");
    assert.equal(runRoot(join(d, "sub", "deep"), base), d);
    assert.equal(runRoot(d, base), d);
    assert.equal(runRoot(null), null);
  } finally {
    rmSync(d, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
});

test("runRoot treats a makeWorkspace dir as a run root without .touchstone.json", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dtn-tmp-"));
  try {
    const ws = join(tmp, "redteam-run-abc");
    mkdirSync(join(ws, "src"), { recursive: true });
    mkdirSync(join(tmp, "solc-warm-x"));
    assert.equal(runRoot(join(ws, "src"), tmp), ws);
    assert.equal(runRoot(ws, tmp), ws);
    assert.equal(runRoot(join(tmp, "solc-warm-x"), tmp), null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("runTool falls back to local Docker when the Daytona API fails", { skip: !hasDocker && "no docker" }, async () => {
  const ws = mkdtempSync(join(tmpdir(), "redteam-run-")); // a run workspace
  const saved = { exec: process.env.TOUCHSTONE_EXEC, key: process.env.DAYTONA_API_KEY, fetch: globalThis.fetch, log: console.log };
  const events = [];
  let calls = 0;
  try {
    process.env.TOUCHSTONE_EXEC = "daytona";
    process.env.DAYTONA_API_KEY = "test-key-not-real";
    globalThis.fetch = async () => { calls++; throw new Error("network down"); };
    console.log = (l) => { if (String(l).startsWith("EVENT ")) events.push(JSON.parse(String(l).slice(6))); };
    writeFileSync(join(ws, "in.txt"), "hello");
    const { runTool } = await import("../lib/wrap.mjs");
    const r = await runTool({ image: "debian:bookworm-slim", ws, cmd: ["sh", "-c", "cat in.txt; echo made > out.txt"] });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "hello");
    assert.equal(readFileSync(join(ws, "out.txt"), "utf8"), "made\n");
    assert.ok(calls > 0);
    assert.equal(events.find((e) => e.ev === "exec-fallback")?.backend, "local");
    // A second call skips Daytona for a while instead of retrying it.
    const before = calls;
    const r2 = await runTool({ image: "debian:bookworm-slim", ws, cmd: ["true"] });
    assert.equal(r2.code, 0);
    assert.equal(calls, before);
  } finally {
    globalThis.fetch = saved.fetch;
    console.log = saved.log;
    if (saved.exec === undefined) delete process.env.TOUCHSTONE_EXEC; else process.env.TOUCHSTONE_EXEC = saved.exec;
    if (saved.key === undefined) delete process.env.DAYTONA_API_KEY; else process.env.DAYTONA_API_KEY = saved.key;
    rmSync(ws, { recursive: true, force: true });
    rmSync(`${ws}.daytona.json`, { force: true });
  }
});

test("closeRun keeps machines Daytona will not delete yet, and retries them later", async () => {
  const d = mkdtempSync(join(tmpdir(), "dtn-close-"));
  const ws = join(d, "ws");
  mkdirSync(ws);
  const keys = ["TOUCHSTONE_EXEC", "DAYTONA_API_KEY", "DAYTONA_PENDING", "DAYTONA_RETRY_MS"];
  const saved = { env: Object.fromEntries(keys.map((k) => [k, process.env[k]])), fetch: globalThis.fetch, log: console.log };
  const deletes = [];
  let status = 409;
  try {
    process.env.TOUCHSTONE_EXEC = "daytona";
    process.env.DAYTONA_API_KEY = "test-key-not-real";
    process.env.DAYTONA_PENDING = join(d, "pending.json");
    process.env.DAYTONA_RETRY_MS = "1";
    console.log = () => {};
    globalThis.fetch = async (url, init) => {
      deletes.push(`${init.method} ${String(url).split("/").pop()}`);
      return new Response(status === 200 ? "" : "busy", { status });
    };
    writeFileSync(`${ws}.daytona.json`, JSON.stringify({ root: { id: "m-1" }, "a-1": { id: "m-2" } }));
    // Daytona says "state change in progress" every time: nothing is gone yet.
    assert.deepEqual(await closeRun(ws), []);
    assert.deepEqual(readPending().sort(), ["m-1", "m-2"]);
    assert.ok(!existsSync(`${ws}.daytona.json`));
    // A later run closes. Now the deletes work, and the old ids go too.
    status = 200;
    deletes.length = 0;
    assert.deepEqual(await closeRun(join(d, "other")), []);
    assert.deepEqual(deletes.sort(), ["DELETE m-1", "DELETE m-2"]);
    assert.deepEqual(readPending(), []);
  } finally {
    globalThis.fetch = saved.fetch;
    console.log = saved.log;
    for (const [k, v] of Object.entries(saved.env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(d, { recursive: true, force: true });
  }
});

// A fake Daytona API. Each machine runs the call script by its mode:
// "ok" answers, "fail" returns HTTP 500. warmCode is the solc warm exit code.
function fakeDaytona({ modes = [], warmCode = 0 } = {}) {
  const log = [];
  const state = new Map();
  let n = 0;
  const tarDir = mkdtempSync(join(tmpdir(), "dtn-fake-"));
  mkdirSync(join(tarDir, "meta"));
  writeFileSync(join(tarDir, "meta", "code"), "0\n");
  writeFileSync(join(tarDir, "meta", "out"), "hi");
  const resTar = execFileSync("tar", ["-cf", "-", "-C", tarDir, "."]);
  rmSync(tarDir, { recursive: true, force: true });
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
  const fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    const id = (u.match(/\/(m-\d+)/) || [])[1];
    if (u.includes("/snapshots/")) return json({ state: "active" });
    if (method === "POST" && u.endsWith("/api/sandbox")) {
      const mid = `m-${++n}`;
      state.set(mid, "started");
      log.push(`create ${mid}`);
      return json({ id: mid, toolboxProxyUrl: "https://tb.test" });
    }
    if (method === "DELETE") { log.push(`delete ${id}`); state.delete(id); return new Response("", { status: 200 }); }
    if (method === "GET" && /\/api\/sandbox\/m-/.test(u)) return state.has(id) ? json({ state: state.get(id) }) : new Response("gone", { status: 404 });
    if (u.includes("/files/upload")) return new Response("", { status: 200 });
    if (u.includes("/files/download")) return new Response(resTar, { status: 200 });
    if (u.includes("/process/execute")) {
      const cmd = JSON.parse(init.body).command;
      if (cmd.includes("dockerd")) return json({ exitCode: 0, result: "" });
      if (cmd.includes("base64 -d")) {
        log.push(`run ${id}`);
        const mode = modes[Number(id.slice(2)) - 1] ?? "ok";
        return mode === "fail" ? new Response("toolbox down", { status: 500 }) : json({ exitCode: 0, result: "" });
      }
      if (cmd.includes("foundry-svm")) { log.push(`warm ${id}`); return json({ exitCode: warmCode, result: "solc download failed" }); }
      if (cmd.startsWith("rm -rf /ts/w/")) log.push(`rmws ${id}`);
      return json({ exitCode: 0, result: "" });
    }
    return new Response("unexpected", { status: 500 });
  };
  return { fetch, log, state };
}

// Run fn against a fresh copy of daytona.mjs and the fake API.
// A run workspace is a makeWorkspace dir (`<tmp>/redteam-run-*`), as in a
// real run. newRun makes another one; all are removed at the end.
async function withFake(opts, fn) {
  const d = mkdtempSync(join(tmpdir(), "dtn-m1-"));
  const runs = [];
  const newRun = () => {
    const r = mkdtempSync(join(tmpdir(), "redteam-run-"));
    writeFileSync(join(r, ".touchstone.json"), "{}");
    runs.push(r);
    return r;
  };
  const ws = newRun();
  const keys = ["TOUCHSTONE_EXEC", "DAYTONA_API_KEY", "DAYTONA_PENDING", "DAYTONA_RETRY_MS", "DAYTONA_STALE_MS"];
  const saved = { env: Object.fromEntries(keys.map((k) => [k, process.env[k]])), fetch: globalThis.fetch, log: console.log };
  const fake = fakeDaytona(opts);
  const events = [];
  try {
    process.env.TOUCHSTONE_EXEC = "daytona";
    process.env.DAYTONA_API_KEY = "test-key-not-real";
    process.env.DAYTONA_PENDING = join(d, "pending.json");
    process.env.DAYTONA_RETRY_MS = "1";
    globalThis.fetch = fake.fetch;
    console.log = (l) => { if (String(l).startsWith("EVENT ")) events.push(JSON.parse(String(l).slice(6))); };
    const mod = await import(`../lib/daytona.mjs?fake=${Math.random()}`);
    await fn({ mod, ws, newRun, fake, events, sidecar: () => JSON.parse(readFileSync(`${ws}.daytona.json`, "utf8")) });
    await mod.closeRun(ws);
    await new Promise((r) => setTimeout(r, 20)); // let background deletes finish
  } finally {
    globalThis.fetch = saved.fetch;
    console.log = saved.log;
    for (const [k, v] of Object.entries(saved.env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(d, { recursive: true, force: true });
    for (const r of runs) {
      rmSync(r, { recursive: true, force: true });
      rmSync(`${r}.daytona.json`, { force: true });
    }
  }
}

const ARGS = (ws) => ["run", "--rm", "--network", "none", "-v", `${ws}:/work`, "-w", "/work", "img:1", "true"];

test("M1: a failed machine is deleted and the call retries once on a new one", async () => {
  await withFake({ modes: ["fail", "ok"] }, async ({ mod, ws, fake, events, sidecar }) => {
    const r = await mod.remoteDocker(ARGS(ws), { ws });
    assert.equal(r?.stdout, "hi");
    assert.equal(events.find((e) => e.ev === "exec-retry")?.sandbox, "m-1");
    assert.ok(!events.some((e) => e.ev === "exec-fallback"));
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(fake.log.includes("delete m-1"));
    assert.deepEqual(Object.values(sidecar()).map((x) => x.id), ["m-2"]);
    // No global penalty: the next call goes straight to m-2.
    const r2 = await mod.remoteDocker(ARGS(ws), { ws });
    assert.equal(r2?.stdout, "hi");
    assert.equal(fake.log.filter((l) => l.startsWith("create")).length, 2);
    assert.equal(fake.log.at(-1), "run m-2");
  });
});

test("M1: two failures in a row put Daytona on hold", async () => {
  await withFake({ modes: ["fail", "fail"] }, async ({ mod, ws, fake, events }) => {
    assert.equal(await mod.remoteDocker(ARGS(ws), { ws }), null);
    assert.equal(events.filter((e) => e.ev === "exec-retry").length, 1);
    assert.equal(events.at(-1).ev, "exec-fallback");
    const before = fake.log.length;
    assert.equal(await mod.remoteDocker(ARGS(ws), { ws }), null);
    assert.match(events.at(-1).reason, /failed recently/);
    assert.equal(fake.log.length, before);
  });
});

test("M1: a machine idle past the stale time that has stopped is replaced", async () => {
  await withFake({}, async ({ mod, ws, fake, sidecar }) => {
    assert.equal((await mod.remoteDocker(ARGS(ws), { ws }))?.stdout, "hi");
    fake.state.set("m-1", "stopped");
    process.env.DAYTONA_STALE_MS = "1";
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await mod.remoteDocker(ARGS(ws), { ws }))?.stdout, "hi");
    assert.equal(fake.log.at(-1), "run m-2");
    assert.deepEqual(Object.values(sidecar()).map((x) => x.id), ["m-2"]);
  });
});

test("M2: a failed solc warm sends the call to local Docker and keeps the machine", async () => {
  await withFake({ warmCode: 1 }, async ({ mod, ws, fake, events }) => {
    assert.equal(await mod.remoteDocker(ARGS(ws), { ws, warm: ["0.8.20"] }), null);
    assert.equal(events.find((e) => e.ev === "exec-warm-failed")?.solc, "0.8.20");
    assert.equal(events.at(-1).ev, "exec-fallback");
    // The same version is not tried again on that machine.
    assert.equal(await mod.remoteDocker(ARGS(ws), { ws, warm: ["0.8.20"] }), null);
    assert.equal(fake.log.filter((l) => l.startsWith("warm")).length, 1);
    // No global penalty, and the machine stays: a call with no warm runs there.
    assert.equal((await mod.remoteDocker(ARGS(ws), { ws }))?.stdout, "hi");
    assert.ok(!fake.log.some((l) => l.startsWith("delete")));
    assert.equal(fake.log.filter((l) => l.startsWith("create")).length, 1);
  });
});

test("A: a bad solc version in warm is never sent to the machine", async () => {
  await withFake({}, async ({ mod, ws, fake, events }) => {
    const bad = "0.8.20'; touch /tmp/t6rev-pwn; echo '";
    assert.equal((await mod.remoteDocker(ARGS(ws), { ws, warm: [bad] }))?.stdout, "hi");
    assert.ok(!fake.log.some((l) => l.startsWith("warm")));
    assert.match(events.find((e) => e.ev === "exec-warm-failed")?.detail ?? "", /x\.y\.z/);
  });
});

// C: a fuzz scratch dir sits in tmp, outside any run. Before, it reused the
// last machine its agent used, from any run. Now the caller names the run.
test("C: scratch calls from two runs use each run's own machine and drop their remote copy", async () => {
  await withFake({}, async ({ mod, ws, newRun, fake, events, sidecar }) => {
    const wsB = newRun();
    const s1 = mkdtempSync(join(tmpdir(), "redteam-fuzz-"));
    const s2 = mkdtempSync(join(tmpdir(), "redteam-fuzz-"));
    try {
      assert.equal((await mod.remoteDocker(ARGS(s1), { ws: s1, root: ws }))?.stdout, "hi");
      assert.equal((await mod.remoteDocker(ARGS(s2), { ws: s2, root: wsB }))?.stdout, "hi");
      const used = events.filter((e) => e.ev === "exec").map((e) => e.sandbox);
      assert.equal(used.length, 2);
      assert.notEqual(used[0], used[1]);
      // Each machine is in its run's sidecar, so closeRun deletes it.
      assert.equal(sidecar().root.id, used[0]);
      assert.equal(JSON.parse(readFileSync(`${wsB}.daytona.json`, "utf8")).root.id, used[1]);
      // The scratch copies are deleted after each call.
      assert.deepEqual(fake.log.filter((l) => l.startsWith("rmws")), [`rmws ${used[0]}`, `rmws ${used[1]}`]);
      // The run workspace itself keeps its copy for the next delta.
      assert.equal((await mod.remoteDocker(ARGS(ws), { ws }))?.stdout, "hi");
      assert.equal(fake.log.filter((l) => l.startsWith("rmws")).length, 2);
      assert.equal(fake.log.at(-1), `run ${used[0]}`);
      await mod.closeRun(wsB);
    } finally {
      rmSync(s1, { recursive: true, force: true });
      rmSync(s2, { recursive: true, force: true });
    }
  });
});

// C2: the supply-chain, infra-cloud and domains packs scan an evidence
// snapshot in a tmp scratch dir that belongs to no run. Before, all of them
// shared one "orphan" machine that no run's closeRun deleted. Now such a call
// runs on local Docker, and no machine is made.
const NO_RUN_SCRATCH = ["touchstone-scan-", "infra-scan-", "touchstone-evidence-"];

test("C2: a pack scan scratch dir with no run runs locally and makes no machine", async () => {
  await withFake({}, async ({ mod, fake, events }) => {
    const { withAgent } = await import("../lib/event.mjs");
    for (const prefix of NO_RUN_SCRATCH) {
      const s = mkdtempSync(join(tmpdir(), prefix));
      try {
        assert.equal(await mod.remoteDocker(ARGS(s), { ws: s }), null, prefix);
        assert.equal(events.at(-1).ev, "exec-fallback");
        assert.match(events.at(-1).reason, /no run/);
        // A swarm child's scan is no different.
        assert.equal(await withAgent("a-child", () => mod.remoteDocker(ARGS(s), { ws: s })), null);
        // No ws at all is no run either.
        assert.equal(await mod.remoteDocker(["run", "--rm", "--network", "none", "img:1", "true"], {}), null);
      } finally {
        rmSync(s, { recursive: true, force: true });
      }
    }
    assert.ok(!fake.log.some((l) => l.startsWith("create")), "no machine was made");
    assert.ok(!fake.log.some((l) => l.startsWith("run ")), "nothing ran on Daytona");
  });
});

test("C2: a run-scoped call still gets its run's own machine, deleted with the run", async () => {
  await withFake({}, async ({ mod, ws, newRun, fake, events, sidecar }) => {
    const wsB = newRun();
    assert.equal((await mod.remoteDocker(ARGS(ws), { ws }))?.stdout, "hi");
    assert.equal((await mod.remoteDocker(ARGS(wsB), { ws: wsB }))?.stdout, "hi");
    // A scratch dir of run B, named by root, uses run B's machine.
    const s = mkdtempSync(join(tmpdir(), "touchstone-scan-"));
    try {
      assert.equal((await mod.remoteDocker(ARGS(s), { ws: s, root: wsB }))?.stdout, "hi");
    } finally {
      rmSync(s, { recursive: true, force: true });
    }
    const used = events.filter((e) => e.ev === "exec").map((e) => e.sandbox);
    assert.equal(used.length, 3);
    assert.notEqual(used[0], used[1]);
    assert.equal(used[2], used[1]);
    assert.equal(sidecar().root.id, used[0]);
    const b = JSON.parse(readFileSync(`${wsB}.daytona.json`, "utf8")).root.id;
    assert.equal(b, used[1]);
    // Each run's closeRun deletes its own machine, and only that one.
    assert.deepEqual(await mod.closeRun(wsB), [b]);
    assert.ok(fake.log.includes(`delete ${b}`));
    assert.ok(!fake.log.includes(`delete ${used[0]}`));
    assert.deepEqual(await mod.closeRun(ws), [used[0]]);
    assert.ok(fake.log.includes(`delete ${used[0]}`));
  });
});

// A target repo can commit .touchstone.json, and the supply-chain scan copies
// the repo into a tmp scratch dir. A stray .touchstone.json can also sit in
// tmp itself. Neither may make the scratch dir a run: inside tmp only a
// redteam-run-* dir counts, and runRoot never walks past the tmp base.
test("C2: a planted .touchstone.json cannot make a tmp scan dir a run", async () => {
  // Above: a fake tmp base with its own .touchstone.json.
  const base = mkdtempSync(join(tmpdir(), "dtn-base-"));
  const fakeScan = join(base, "touchstone-scan-abc");
  mkdirSync(join(fakeScan, "sub"), { recursive: true });
  writeFileSync(join(base, ".touchstone.json"), "{}");
  writeFileSync(join(fakeScan, ".touchstone.json"), "{}");
  try {
    assert.equal(runRoot(fakeScan, base), null);
    assert.equal(runRoot(join(fakeScan, "sub"), base), null);
    assert.equal(runRoot(base, base), null);
    for (const p of ["infra-scan-x", "touchstone-evidence-x", "redteam-fuzz-x"]) {
      mkdirSync(join(base, p));
      writeFileSync(join(base, p, ".touchstone.json"), "{}");
      assert.equal(runRoot(join(base, p), base), null, p);
    }
    // A real run in the same tmp base still resolves.
    const run = join(base, "redteam-run-xyz");
    mkdirSync(join(run, "sub"), { recursive: true });
    assert.equal(runRoot(join(run, "sub"), base), run);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  // In the real tmp: the scan of such a repo runs on local Docker.
  await withFake({}, async ({ mod, fake, events }) => {
    const s = mkdtempSync(join(tmpdir(), "touchstone-scan-"));
    try {
      writeFileSync(join(s, ".touchstone.json"), JSON.stringify({ kind: "lab", pack: "supply-chain" }));
      assert.equal(runRoot(s), null);
      assert.equal(await mod.remoteDocker(ARGS(s), { ws: s }), null);
      assert.equal(events.at(-1).ev, "exec-fallback");
      assert.match(events.at(-1).reason, /no run/);
      assert.ok(!events.some((e) => e.ev === "exec" && e.backend === "daytona"), "ran on Daytona");
      assert.ok(!fake.log.some((l) => l.startsWith("create")), "a machine was made");
      assert.ok(!existsSync(`${s}.daytona.json`), "a sidecar was written");
    } finally {
      rmSync(s, { recursive: true, force: true });
      rmSync(`${s}.daytona.json`, { force: true });
    }
  });
});

// The same, end to end through runTool: a supply-chain-style scratch scan
// never reaches the Daytona API, and runs on local Docker.
test("C2: runTool on a no-run scratch dir never calls Daytona", { skip: !hasDocker && "no docker" }, async () => {
  const s = mkdtempSync(join(tmpdir(), "touchstone-scan-"));
  const saved = { exec: process.env.TOUCHSTONE_EXEC, key: process.env.DAYTONA_API_KEY, fetch: globalThis.fetch, log: console.log };
  const events = [];
  let calls = 0;
  try {
    process.env.TOUCHSTONE_EXEC = "daytona";
    process.env.DAYTONA_API_KEY = "test-key-not-real";
    globalThis.fetch = async () => { calls++; throw new Error("must not be called"); };
    console.log = (l) => { if (String(l).startsWith("EVENT ")) events.push(JSON.parse(String(l).slice(6))); };
    writeFileSync(join(s, "in.txt"), "scan me");
    const { runTool } = await import("../lib/wrap.mjs");
    const r = await runTool({ image: "debian:bookworm-slim", ws: s, cmd: ["cat", "in.txt"] });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "scan me");
    assert.equal(calls, 0);
    assert.match(events.find((e) => e.ev === "exec-fallback")?.reason ?? "", /no run/);
  } finally {
    globalThis.fetch = saved.fetch;
    console.log = saved.log;
    if (saved.exec === undefined) delete process.env.TOUCHSTONE_EXEC; else process.env.TOUCHSTONE_EXEC = saved.exec;
    if (saved.key === undefined) delete process.env.DAYTONA_API_KEY; else process.env.DAYTONA_API_KEY = saved.key;
    rmSync(s, { recursive: true, force: true });
  }
});

// F: a process that dies during closeRun must not lose a machine id.
test("F: closeRun writes the pending file before deleting and drops the sidecar after", async () => {
  const d = mkdtempSync(join(tmpdir(), "dtn-f-"));
  const ws = join(d, "ws");
  mkdirSync(ws);
  const keys = ["TOUCHSTONE_EXEC", "DAYTONA_API_KEY", "DAYTONA_PENDING", "DAYTONA_RETRY_MS"];
  const saved = { env: Object.fromEntries(keys.map((k) => [k, process.env[k]])), fetch: globalThis.fetch, log: console.log };
  const seen = [];
  try {
    process.env.TOUCHSTONE_EXEC = "daytona";
    process.env.DAYTONA_API_KEY = "test-key-not-real";
    process.env.DAYTONA_PENDING = join(d, "pending.json");
    process.env.DAYTONA_RETRY_MS = "1";
    console.log = () => {};
    globalThis.fetch = async () => {
      seen.push({ pending: readPending(), sidecar: existsSync(`${ws}.daytona.json`) });
      return new Response("", { status: 200 });
    };
    writeFileSync(`${ws}.daytona.json`, JSON.stringify({ root: { id: "m-7" } }));
    assert.deepEqual(await closeRun(ws), ["m-7"]);
    assert.deepEqual(seen[0], { pending: ["m-7"], sidecar: true });
    assert.ok(!existsSync(`${ws}.daytona.json`));
    assert.deepEqual(readPending(), []);
  } finally {
    globalThis.fetch = saved.fetch;
    console.log = saved.log;
    for (const [k, v] of Object.entries(saved.env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(d, { recursive: true, force: true });
  }
});

// Live: the same tool call on both backends gives the same result, files come
// back, and a swarm child gets its own machine. Makes and deletes two machines.
const live = process.env.TOUCHSTONE_EXEC_LIVE === "1" && process.env.DAYTONA_API_KEY;
test("live: Daytona matches local Docker, children get their own machine", { skip: !live && "set TOUCHSTONE_EXEC_LIVE=1", timeout: 900_000 }, async () => {
  const { runTool } = await import("../lib/wrap.mjs");
  const { cleanupWorkspace } = await import("../lib/sandbox.mjs");
  const { withAgent } = await import("../lib/event.mjs");
  const ws = mkdtempSync(join(tmpdir(), "redteam-run-"));
  writeFileSync(join(ws, ".touchstone.json"), JSON.stringify({ kind: "lab", solc: "0.8.38" }));
  writeFileSync(join(ws, "in.txt"), "hello\n");
  const spec = { image: "debian:bookworm-slim", ws, cmd: ["sh", "-c", "cat in.txt; echo e >&2; getent hosts example.com || echo nonet; echo x > back.txt; exit 3"] };
  const saved = process.env.TOUCHSTONE_EXEC;
  const events = [];
  const log = console.log;
  console.log = (l) => { if (String(l).startsWith("EVENT ")) events.push(JSON.parse(String(l).slice(6))); else log(l); };
  try {
    process.env.TOUCHSTONE_EXEC = "local";
    const local = await runTool(spec);
    rmSync(join(ws, "back.txt"));
    process.env.TOUCHSTONE_EXEC = "daytona";
    const remote = await runTool(spec);
    assert.deepEqual(remote, local);
    assert.equal(readFileSync(join(ws, "back.txt"), "utf8"), "x\n");
    const child = await withAgent("a-live-child", () => runTool({ image: "debian:bookworm-slim", ws, cmd: ["cat", "in.txt"] }));
    assert.equal(child.stdout, "hello\n");
    const runs = events.filter((e) => e.ev === "exec");
    assert.equal(runs.length, 2, JSON.stringify(events));
    assert.notEqual(runs[0].sandbox, runs[1].sandbox);
    assert.equal(runs[1].agent, "a-live-child");
    assert.ok(existsSync(`${ws}.daytona.json`));
  } finally {
    console.log = log;
    if (saved === undefined) delete process.env.TOUCHSTONE_EXEC; else process.env.TOUCHSTONE_EXEC = saved;
    // Wait for the machines to go, then drop the files.
    // Each machine is deleted now, or kept in the pending file when Daytona
    // still says it is starting.
    const ids = Object.values(JSON.parse(readFileSync(`${ws}.daytona.json`, "utf8"))).map((x) => x.id);
    const gone = await closeRun(ws);
    const pending = readPending();
    assert.equal(ids.length, 2);
    for (const id of ids) assert.ok(gone.includes(id) || pending.includes(id), id);
    if (gone.length < 2) log(`  Daytona kept ${2 - gone.length} machine(s) in the pending file`);
    cleanupWorkspace(ws);
  }
});

// The proof gate reads forge's build artifacts (out/) from the local workspace.
// So the Daytona replay must bring them back, or every finding fails closed.
test("live: the lab oracle gets the same proof verdict on Daytona", { skip: !live && "set TOUCHSTONE_EXEC_LIVE=1", timeout: 900_000 }, async () => {
  const { makeWorkspace, cleanupWorkspace } = await import("../lib/sandbox.mjs");
  const { proofDelta } = await import("../lib/proof.mjs");
  const lab = new URL("../../lab/vault-reentrancy/", import.meta.url).pathname;
  const source = readFileSync(join(lab, "oracle/VaultExploit.t.sol"), "utf8");
  const saved = process.env.TOUCHSTONE_EXEC;
  const verdict = async (backend) => {
    process.env.TOUCHSTONE_EXEC = backend;
    const ws = makeWorkspace(lab);
    try {
      const p = await proofDelta(ws, { source, contract: "VaultExploitTest" });
      return { status: p?.status, gas: p?.gasUsed, harm: p?.harm, transfers: p?.transfers };
    } finally {
      if (existsSync(`${ws}.daytona.json`)) await closeRun(ws);
      cleanupWorkspace(ws);
    }
  };
  try {
    const local = await verdict("local");
    assert.equal(local.harm.ok, true);
    assert.deepEqual(await verdict("daytona"), local);
  } finally {
    if (saved === undefined) delete process.env.TOUCHSTONE_EXEC; else process.env.TOUCHSTONE_EXEC = saved;
  }
});
