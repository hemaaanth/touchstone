// One writer at a time across processes: the store lock (grant-store.mjs
// withStoreLock). The server and the CLI can both write a store.
//
//   node --test spike/test/store-lock.test.mjs
import { TEST_STORE_DIR } from "./helpers/isolated-env.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const { addGrant, readGrants } = await import("../lib/grant-store.mjs");
const { addScope, readScopes } = await import("../lib/scopes-store.mjs");
const GRANTS = process.env.TOUCHSTONE_GRANTS_FILE;
const LOCK = `${GRANTS}.lock`;
const STORE = new URL("../lib/grant-store.mjs", import.meta.url).href;
const children = [];
after(() => {
  for (const c of children) if (c.exitCode === null) c.kill();
});

// A process that stays alive until killed: its pid is a live lock owner.
function aliveProcess() {
  const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  children.push(c);
  return c;
}
// A pid that no process has any more.
async function deadPid() {
  const c = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((res) => c.on("exit", res));
  return c.pid;
}
// Another process that adds `n` grants and prints the time it finished.
function writer(n, tag) {
  const code = `
    const { addGrant } = await import(${JSON.stringify(STORE)});
    for (let i = 0; i < ${n}; i++) addGrant({ hosts: ["${tag}-" + i + ".example.com"], kind: "authorized", approvedBy: "test" });
    console.log(Date.now());`;
  const c = spawn(process.execPath, ["--input-type=module", "-e", code], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(c);
  let out = "", err = "";
  c.stdout.on("data", (d) => (out += d));
  c.stderr.on("data", (d) => (err += d));
  return new Promise((res) => c.on("exit", (code) => res({ code, done: Number(out.trim()), err })));
}
const reset = () => {
  rmSync(GRANTS, { force: true });
  rmSync(LOCK, { force: true });
  delete process.env.TOUCHSTONE_STORE_LOCK_WAIT_MS;
};

test("a live lock held by another process: the write waits, then refuses with a sentence, and writes nothing", async () => {
  reset();
  addGrant({ hosts: ["before.example.com"], kind: "authorized", approvedBy: "test" });
  const before = readFileSync(GRANTS, "utf8");
  const owner = aliveProcess();
  writeFileSync(LOCK, JSON.stringify({ pid: owner.pid, at: Date.now() }));
  process.env.TOUCHSTONE_STORE_LOCK_WAIT_MS = "150";
  const t0 = Date.now();
  assert.throws(() => addGrant({ hosts: ["blocked.example.com"], kind: "authorized", approvedBy: "test" }), new RegExp(`^Error: Refused: the grant store is busy\\. Another Touchstone process \\(pid ${owner.pid}\\) is writing it\\. Nothing was changed\\. Try again in a moment\\.$`));
  assert.ok(Date.now() - t0 >= 140, "it waited first");
  assert.equal(readFileSync(GRANTS, "utf8"), before);
  assert.ok(existsSync(LOCK), "another process's live lock is not removed");
  owner.kill();
  reset();
});

test("a stale lock (its process is gone) is removed and the write goes on", async () => {
  reset();
  writeFileSync(LOCK, JSON.stringify({ pid: await deadPid(), at: Date.now() }));
  addGrant({ hosts: ["after-stale.example.com"], kind: "authorized", approvedBy: "test" });
  assert.deepEqual(readGrants().map((g) => g.hosts[0]), ["after-stale.example.com"]);
  assert.ok(!existsSync(LOCK), "the lock is released after the write");
});

test("a writer in another process waits for a live lock and goes on once it is released", async () => {
  reset();
  process.env.TOUCHSTONE_STORE_LOCK_WAIT_MS = "5000";
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() })); // this test process is alive
  const pending = writer(1, "waiting");
  await new Promise((res) => setTimeout(res, 400));
  assert.equal(existsSync(GRANTS), false, "nothing was written while the lock was held");
  const released = Date.now();
  rmSync(LOCK);
  const r = await pending;
  assert.equal(r.code, 0, r.err);
  assert.ok(r.done >= released, "it wrote only after the release");
  assert.deepEqual(readGrants().map((g) => g.hosts[0]), ["waiting-0.example.com"]);
  reset();
});

test("four processes writing the same store at once lose no update", async () => {
  reset();
  process.env.TOUCHSTONE_STORE_LOCK_WAIT_MS = "20000";
  const results = await Promise.all(["a", "b", "c", "d"].map((tag) => writer(25, tag)));
  for (const r of results) assert.equal(r.code, 0, r.err);
  const hosts = readGrants().map((g) => g.hosts[0]);
  assert.equal(hosts.length, 100, "every one of the 100 grants is there");
  assert.equal(new Set(hosts).size, 100);
  assert.ok(!existsSync(LOCK));
  reset();
});

test("the scope store takes its own lock the same way", async () => {
  const lock = `${process.env.TOUCHSTONE_SCOPES_FILE}.lock`;
  const owner = aliveProcess();
  writeFileSync(lock, JSON.stringify({ pid: owner.pid, at: Date.now() }));
  process.env.TOUCHSTONE_STORE_LOCK_WAIT_MS = "100";
  const before = readScopes().length;
  assert.throws(() => addScope({ title: "x", members: [{ kind: "repo", url: "https://github.com/acme/x" }] }), /^Error: Refused: the scope store is busy\./);
  assert.equal(readScopes().length, before);
  rmSync(lock, { force: true });
  owner.kill();
  delete process.env.TOUCHSTONE_STORE_LOCK_WAIT_MS;
  assert.equal(addScope({ title: "x", members: [{ kind: "repo", url: "https://github.com/acme/x" }] }).title, "x");
  assert.ok(path.dirname(lock).startsWith(TEST_STORE_DIR), "the test never touches spike/data");
});
