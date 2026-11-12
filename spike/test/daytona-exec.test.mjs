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

import { closeRun, delta, execConfig, planRemote, readPending, runRoot, scan, shq } from "../lib/daytona.mjs";

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
  assert.equal(planRemote(["run", "--network", "bridge", "img"], null, null).local, null);
  assert.match(planRemote(["run", "-v", "/etc:/x", "img"], "/tmp/ws", "/r").local, /host path/);
  assert.match(planRemote(["build", "."], null, null).local, /not a docker run/);
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

test("runRoot finds the run workspace above a path", () => {
  const d = mkdtempSync(join(tmpdir(), "dtn-root-"));
  try {
    mkdirSync(join(d, "sub", "deep"), { recursive: true });
    assert.equal(runRoot(join(d, "sub")), null);
    writeFileSync(join(d, ".touchstone.json"), "{}");
    assert.equal(runRoot(join(d, "sub", "deep")), d);
    assert.equal(runRoot(null), null);
  } finally {
    rmSync(d, { recursive: true, force: true });
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
  const ws = mkdtempSync(join(tmpdir(), "dtn-fb-"));
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
