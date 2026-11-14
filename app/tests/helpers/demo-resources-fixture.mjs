import "../../../spike/test/helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile as execute } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";
import { armDemoDeadline, stopDemoWorker } from "../../server/demo-lifecycle.mjs";
import { checkDemoResourceRuntime, createDemoResources, currentDemoResources, demoResourcesComplete, reopenDemoResources, settleDemoResources, spawnDemoWorker, withDemoResources } from "../../../spike/lib/demo-resources.mjs";
// Public execution is local; do not load the unrelated remote SDK graph.
const remote = "data:text/javascript," + encodeURIComponent("export const SOLC_VERSION='0.8.38';export const daytonaOn=()=>false;export const closeRun=async()=>{};export const remoteDocker=()=>{throw Error('Remote execution forbidden')};");
const remoteHook = registerHooks({ resolve(spec, ctx, next) { return spec === "./daytona.mjs" && ctx.parentURL?.endsWith("/spike/lib/sandbox.mjs") ? { url: remote, shortCircuit: true } : next(spec, ctx); } });
const { cleanupWorkspace, forgeTest, forgeTestJson } = await import("../../../spike/lib/sandbox.mjs");
remoteHook.deregister();
const execFile = promisify(execute);
const fake = fileURLToPath(new URL("./demo-fake-docker.mjs", import.meta.url));
const workerFile = fileURLToPath(new URL("./demo-forge-worker.mjs", import.meta.url));
const resourceURL = new URL("../../../spike/lib/demo-resources.mjs", import.meta.url).href;
const backendFile = fileURLToPath(new URL("./demo-backend-fixture.mjs", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
globalThis.fetch = () => { throw Error("Network forbidden"); };
async function waitFor(fn, message) {
  const until = Date.now() + 5000;
  while (Date.now() < until) { const value = fn(); if (value) return value; await sleep(10); }
  assert.fail(message);
}
function journal(ctx, update) {
  const db = new DatabaseSync(ctx.file);
  try { const state = JSON.parse(db.prepare("SELECT data FROM demo WHERE id=1").get().data); if (update) { update(state); db.prepare("UPDATE demo SET data=? WHERE id=1").run(JSON.stringify(state)); } return state; }
  finally { db.close(); }
}
function alive(pid) { try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(/\) /).at(-1)[0] !== "Z"; } catch { return false; } }
async function fixture(t, flags = {}) {
  const dir = mkdtempSync(join(process.env.DEMO_TEST_ROOT, "case-")), dockerDir = join(dir, "docker"), bin = join(dir, "bin"), ws = join(dir, "workspace");
  mkdirSync(dockerDir); mkdirSync(bin); mkdirSync(ws);
  writeFileSync(join(bin, "docker"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@"\n`, { mode: 0o700 });
  const old = { PATH: process.env.PATH, DEMO_TEST_DOCKER: process.env.DEMO_TEST_DOCKER };
  process.env.PATH = `${bin}:${old.PATH}`; process.env.DEMO_TEST_DOCKER = dockerDir;
  const control = (value) => writeFileSync(join(dockerDir, "control.json"), JSON.stringify(value)); control(flags);
  const daemon = spawn(process.execPath, [fake, "daemon"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let errors = ""; daemon.stderr.on("data", (chunk) => { errors += chunk; });
  await waitFor(() => existsSync(join(dockerDir, "ready")), "fake daemon did not start: " + errors);
  const contexts = [], restores = [], workers = [];
  const ctx = createDemoResources(join(dir, "run-test.demo-resources.sqlite")); contexts.push(ctx);
  t.after(async () => {
    for (const restore of restores) restore(); control({}); await sleep(50);
    for (const value of contexts) { try { await settleDemoResources(value); } catch {} }
    for (const worker of workers) if (worker.exitCode == null && worker.signalCode == null) worker.kill("SIGKILL");
    const exit = once(daemon, "exit"); daemon.kill("SIGTERM"); await exit;
    for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  });
  const containers = () => { try { return JSON.parse(readFileSync(join(dockerDir, "containers.json"), "utf8")); } catch { return []; } };
  const start = (method = "forge") => {
    const result = join(dir, `result-${method}.json`), child = spawnDemoWorker(ctx, workerFile, [method, ws, result], { cwd: dir, env: { TOUCHSTONE_EXEC: "local" } }); workers.push(child);
    let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; }); child.stdout.resume();
    return { child, result, stderr: () => stderr };
  };
  return { dir, ws, ctx, contexts, restores, dockerDir, control, containers, start };
}

test("runtime prerequisite is real Linux pidfd support", () => { checkDemoResourceRuntime(); });

test("owner Forge keeps docker-run behavior while demo Forge refuses a missing context", async (t) => {
  const f = await fixture(t);
  assert.equal((await forgeTest(f.ws, { timeoutMs: 1500 })).passed, true);
  assert.equal(Object.keys(journal(f.ctx).resources).length, 0);
  const before = process.env.TOUCHSTONE_DEMO; process.env.TOUCHSTONE_DEMO = "1";
  try { await assert.rejects(forgeTest(f.ws, { timeoutMs: 1500 })); }
  finally { if (before === undefined) delete process.env.TOUCHSTONE_DEMO; else process.env.TOUCHSTONE_DEMO = before; }
  const calls = readFileSync(join(f.dockerDir, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 1); assert.equal(calls[0].args[0], "run");
  const foreign = join(f.dir, "unregistered"); mkdirSync(foreign); writeFileSync(join(foreign, "keep"), "foreign workspace");
  await assert.rejects(withDemoResources(f.ctx, () => cleanupWorkspace(foreign)));
  assert.equal(readFileSync(join(foreign, "keep"), "utf8"), "foreign workspace");
});

test("a fork during TERM and a normal-exit orphan are discovered and joined through pidfds", async (t) => {
  const f = await fixture(t), childMarker = join(f.dir, "child-pid"), lateMarker = join(f.dir, "late-pid"), script = join(f.dir, "forker.mjs");
  const leaf = (file) => `import {writeFileSync} from 'node:fs';process.on('SIGTERM',()=>{});writeFileSync(${JSON.stringify(file)},String(process.pid));setInterval(()=>{},1000);`;
  writeFileSync(script, `import {spawn} from 'node:child_process';const spawnLeaf=(code)=>spawn(process.execPath,['--input-type=module','-e',code],{stdio:'ignore'});spawnLeaf(${JSON.stringify(leaf(childMarker))});process.on('SIGTERM',()=>{spawnLeaf(${JSON.stringify(leaf(lateMarker))});setTimeout(()=>process.exit(143),30);});setInterval(()=>{},1000);`);
  const worker = spawnDemoWorker(f.ctx, script, [], {}); worker.stdout.resume(); worker.stderr.resume();
  await waitFor(() => existsSync(childMarker), "initial OS descendant was not created");
  await stopDemoWorker({ demoResources: f.ctx, child: worker }, 100);
  assert.equal(alive(Number(readFileSync(childMarker, "utf8"))), false);
  assert.equal(alive(Number(readFileSync(lateMarker, "utf8"))), false);
  const ctx = createDemoResources(join(f.dir, "run-normal-exit.demo-resources.sqlite")); f.contexts.push(ctx);
  const orphanMarker = join(f.dir, "orphan-pid");
  writeFileSync(script, `import {spawn} from 'node:child_process';import {existsSync} from 'node:fs';spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(leaf(orphanMarker))}],{stdio:'ignore'});while(!existsSync(${JSON.stringify(orphanMarker)}))await new Promise(r=>setTimeout(r,5));process.exit(0);`);
  const normal = spawnDemoWorker(ctx, script, [], {}); normal.stdout.resume(); normal.stderr.resume();
  assert.equal((await once(normal, "exit"))[0], 0);
  assert.equal(alive(Number(readFileSync(orphanMarker, "utf8"))), true);
  await settleDemoResources(ctx, { cancel: false });
  assert.equal(alive(Number(readFileSync(orphanMarker, "utf8"))), false);
  reopenDemoResources(ctx);
});

test("parent pipe loss ends the actual engine stop setup and restart cleanup joins Forge work", async (t) => {
  const f = await fixture(t), worker = f.start("pipe");
  const container = await waitFor(() => f.containers().find((c) => c.State.Running), "pipe worker did not start: " + worker.stderr());
  const exited = once(worker.child, "exit"); worker.child.stdin.end();
  assert.equal((await exited)[0], 1);
  await settleDemoResources(f.ctx);
  assert.equal(alive(container.pid), false); assert.equal(demoResourcesComplete(f.ctx), true);
});

test("Stop joins actual Forge producer descendants but does not confuse CLI exit with container removal", async (t) => {
  const f = await fixture(t, { failRemove: true }), worker = f.start();
  const container = await waitFor(() => f.containers().find((c) => c.State.Running), "actual Forge CLI/container did not start: " + worker.stderr());
  const state = journal(f.ctx); assert.equal(state.resources[Object.keys(state.resources)[0]].containerId, container.Id);
  const cliPid = JSON.parse(readFileSync(join(f.dockerDir, "calls.jsonl"), "utf8").trim().split("\n").findLast((line) => JSON.parse(line).args[0] === "start")).pid;
  const exited = once(worker.child, "exit");
  const stopping = stopDemoWorker({ child: worker.child, demoResources: f.ctx }, 30); stopping.catch(() => {});
  assert.equal((await exited)[0], 143, worker.stderr());
  await assert.rejects(stopping); assert.equal(alive(cliPid), false); assert.equal(alive(container.pid), true);
  assert.equal(demoResourcesComplete(f.ctx), false); assert.equal(existsSync(f.ws), true);
  f.control({}); await settleDemoResources(f.ctx);
  assert.equal(alive(container.pid), false); assert.equal(f.containers().length, 0); assert.equal(demoResourcesComplete(f.ctx), true); assert.equal(existsSync(f.ws), false);
});

test("absolute deadline stops actual JSON Forge work and retains capacity until verified cleanup", async (t) => {
  const f = await fixture(t), worker = f.start("json");
  const container = await waitFor(() => f.containers().find((c) => c.State.Running), "JSON Forge did not start: " + worker.stderr());
  const run = { ownerHash: "a".repeat(64), demoResources: f.ctx, child: worker.child, id: "deadline", deadlineAt: Date.now() + 20 };
  let stopping; armDemoDeadline(run, () => { stopping = stopDemoWorker(run, 10); });
  await waitFor(() => stopping, "deadline was not requested"); await stopping;
  assert.equal(alive(container.pid), false); assert.equal(demoResourcesComplete(f.ctx), true); assert.equal(f.containers().length, 0);
});

test("normal worker exit drains without cancelling parent proof; JSON proof, warming, and concurrent writes share the namespace", async (t) => {
  const f = await fixture(t, { finish: true }), worker = f.start();
  assert.equal((await once(worker.child, "exit"))[0], 0, worker.stderr());
  assert.equal(JSON.parse(readFileSync(worker.result, "utf8")).passed, true);
  await settleDemoResources(f.ctx, { cancel: false }); assert.equal(existsSync(f.ws), true); reopenDemoResources(f.ctx);
  const original = process.env.TOUCHSTONE_DEMO_RESOURCE_FILE;
  const results = await withDemoResources(f.ctx, () => Promise.all([forgeTest(f.ws, { timeoutMs: 1500 }), forgeTestJson(f.ws, { timeoutMs: 1500 })]));
  assert.equal(results[0].passed, true); assert.match(results[1].raw, /PASS/); assert.equal(process.env.TOUCHSTONE_DEMO_RESOURCE_FILE, original); assert.equal(currentDemoResources(), null);
  const state = journal(f.ctx); assert.equal(Object.keys(state.resources).length, 3); assert.equal(Object.keys(state.groups).length, 4);
  assert(Object.values(state.resources).every((r) => r.phase === "complete"));
  await settleDemoResources(f.ctx); assert.equal(demoResourcesComplete(f.ctx), true);
  const warmContext = createDemoResources(join(f.dir, "run-warm.demo-resources.sqlite")); f.contexts.push(warmContext);
  const warm = spawnDemoWorker(warmContext, workerFile, ["warm", f.ws, join(f.dir, "warm-result.json")], { env: { TOUCHSTONE_EXEC: "local" } }); warm.stderr.resume(); warm.stdout.resume();
  assert.equal((await once(warm, "exit"))[0], 0);
  assert.equal(JSON.parse(readFileSync(join(f.dir, "warm-result.json"), "utf8")).ok, true);
  await settleDemoResources(warmContext); assert.equal(demoResourcesComplete(warmContext), true);
});

test("forced worker death and parent restart recover producer-created journals without starting new work", async (t) => {
  const f = await fixture(t), checkpoint = join(f.dir, "restart.json"), result = join(f.dir, "restart-result.json");
  const code = `import {createDemoResources,spawnDemoWorker} from ${JSON.stringify(resourceURL)}; import {writeFileSync,readFileSync} from 'node:fs'; import {once} from 'node:events';
const ctx=createDemoResources(${JSON.stringify(join(f.dir, "run-restart.demo-resources.sqlite"))});const child=spawnDemoWorker(ctx,${JSON.stringify(workerFile)},['forge',${JSON.stringify(f.ws)},${JSON.stringify(result)}],{env:{TOUCHSTONE_EXEC:'local'}});child.stderr.resume();child.stdout.resume();
while(true){try{if(JSON.parse(readFileSync(${JSON.stringify(join(f.dockerDir, "containers.json"))},'utf8')).some(c=>c.State.Running))break;}catch{}await new Promise(r=>setTimeout(r,10));}writeFileSync(${JSON.stringify(checkpoint)},JSON.stringify(ctx));const exit=once(child,'exit');child.kill('SIGKILL');await exit;process.exit(0);`;
  await execFile(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "--eval", code], { env: process.env, timeout: 5000 });
  const ctx = JSON.parse(readFileSync(checkpoint, "utf8")); f.contexts.push(ctx); const container = f.containers()[0]; assert.equal(alive(container.pid), true);
  const recover = `import {settleDemoResources,demoResourcesComplete} from ${JSON.stringify(resourceURL)}; await settleDemoResources(${JSON.stringify(ctx)}); if(!demoResourcesComplete(${JSON.stringify(ctx)}))process.exit(2);`;
  await execFile(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "--eval", recover], { env: process.env, timeout: 15000 });
  assert.equal(alive(container.pid), false); assert.equal(f.containers().length, 0); assert.equal(demoResourcesComplete(ctx), true);
});

test("recorded replay keeps its real temporary directory when managed cleanup is unresolved", async (t) => {
  const f = await fixture(t, { finish: true, failRemove: true }), workDir = join(f.dir, "replay-work"); mkdirSync(workDir);
  // Only the unrelated mnemonic dependency is stubbed; the replay runner,
  // directory lifecycle, sandbox, subprocesses, and daemon protocol are real.
  const stub = "data:text/javascript," + encodeURIComponent("export const Mnemonic={isValidMnemonic:()=>false};export const wordlists={en:{getWordIndex:()=>-1}};");
  const hooks = registerHooks({ resolve(spec, ctx, next) { return spec === "ethers" ? { url: stub, shortCircuit: true } : next(spec, ctx); } });
  let verifyForgeReplay;
  try { ({ verifyForgeReplay } = await import("../../../spike/lib/replay-bundle.mjs")); } finally { hooks.deregister(); }
  const replay = { contract: "Proof", solc: "0.8.38", files: [
    { path: "foundry.toml", text: '[profile.default]\nsrc="src"\ntest="test"\n' },
    { path: "test/AgentPoc.t.sol", text: "pragma solidity 0.8.38; contract Proof { function testProof() public {} }" },
  ] };
  const result = withDemoResources(f.ctx, () => verifyForgeReplay({ replay, proof: { kind: "forge", pass: true } }, { workDir }));
  result.catch(() => {});
  await assert.rejects(result);
  const directory = Object.keys(journal(f.ctx).directories).find((path) => path.startsWith(workDir + "/check-"));
  assert(directory); assert.equal(existsSync(directory), true); assert.equal(demoResourcesComplete(f.ctx), false);
  f.control({}); await settleDemoResources(f.ctx); assert.equal(existsSync(directory), false); assert.equal(demoResourcesComplete(f.ctx), true);
});

test("an interrupted create remains unresolved despite absence; later committed exact ownership can be recovered", async (t) => {
  const f = await fixture(t, { pauseCreate: true }), worker = f.start();
  await waitFor(() => existsSync(join(f.dockerDir, "create-waiting")), "create intent never reached daemon: " + worker.stderr());
  const state = journal(f.ctx), resource = Object.values(state.resources)[0]; assert.equal(resource.phase, "intent"); assert.equal(resource.containerId, null);
  await assert.rejects(stopDemoWorker({ child: worker.child, demoResources: f.ctx }, 10));
  assert.equal(f.containers().length, 0); assert.equal(demoResourcesComplete(f.ctx), false); assert.equal(existsSync(f.ws), true);
  f.control({}); await waitFor(() => f.containers().length === 1, "late daemon create did not commit");
  await settleDemoResources(f.ctx); assert.equal(f.containers().length, 0); assert.equal(existsSync(f.ws), false); assert.equal(demoResourcesComplete(f.ctx), true);
});

test("malformed and reused identities never signal an unrelated process; successful rm without absence remains unresolved", async (t) => {
  const f = await fixture(t, { keepAfterRm: true }), worker = f.start();
  const container = await waitFor(() => f.containers().find((c) => c.State.Running), "producer did not start: " + worker.stderr());
  const saved = journal(f.ctx); const foreign = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore", env: { PATH: process.env.PATH } });
  t.after(() => foreign.kill("SIGKILL"));
  const fields = readFileSync(`/proc/${foreign.pid}/stat`, "utf8").split(/\) /).at(-1).split(" ");
  journal(f.ctx, (state) => { state.groups.worker.identity = { pid: foreign.pid, uid: process.getuid(), start: fields[19], boot: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() }; });
  f.restores.push(() => journal(f.ctx, (state) => Object.assign(state, saved)));
  await assert.rejects(settleDemoResources(f.ctx)); assert.equal(alive(foreign.pid), true); assert.equal(alive(container.pid), true);
  journal(f.ctx, (state) => Object.assign(state, saved));
  journal(f.ctx, (state) => { state.groups.worker.identity.start = "1"; });
  await assert.rejects(settleDemoResources(f.ctx)); assert.equal(alive(worker.child.pid), true); assert.equal(alive(foreign.pid), true);
  journal(f.ctx, (state) => Object.assign(state, saved));
  await assert.rejects(stopDemoWorker({ child: worker.child, demoResources: f.ctx }, 10));
  assert.equal(alive(container.pid), true); assert.equal(demoResourcesComplete(f.ctx), false);
  f.control({}); await settleDemoResources(f.ctx); assert.equal(alive(container.pid), false); assert.equal(alive(foreign.pid), true);
  f.restores.length = 0;
});

test("actual API checkpoint, cleanup failure busy gate, and fresh-process cleanup recovery roundtrip", async (t) => {
  const f = await fixture(t, { failRemove: true }), state = join(f.dir, "backend"); mkdirSync(state);
  await execFile(process.execPath, ["--experimental-test-module-mocks", "--disable-warning=ExperimentalWarning", backendFile, "resources", state], { env: process.env, timeout: 15000 });
  assert(f.containers().some((c) => c.State.Running)); f.control({});
  await execFile(process.execPath, ["--experimental-test-module-mocks", "--disable-warning=ExperimentalWarning", backendFile, "resources-recover", state], { env: process.env, timeout: 15000 });
  assert.equal(f.containers().length, 0);
});
