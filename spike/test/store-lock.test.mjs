// One writer at a time across processes: the store lock (grant-store.mjs
// withStoreLock). The server and the CLI can both write a store.
//
//   node --test spike/test/store-lock.test.mjs
import { TEST_STORE_DIR } from "./helpers/isolated-env.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

const { addGrant, readGrants, withStoreLock, saveStore, loadGrants, lockTestHooks } = await import("../lib/grant-store.mjs");
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

test("a lock path that is a dangling link or a folder is refused with a sentence, and never followed", () => {
  reset();
  const nowhere = path.join(TEST_STORE_DIR, "nowhere", "target");
  symlinkSync(nowhere, LOCK);
  assert.throws(() => addGrant({ hosts: ["linked.example.com"], kind: "authorized", approvedBy: "test" }), new RegExp(`^Error: Refused: the grant store lock ${LOCK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is a link or a folder, not a lock file\\. Touchstone does not follow it\\. Nothing was changed\\. Remove it, then try again\\.$`));
  assert.ok(!existsSync(nowhere), "the link's target was never created");
  assert.ok(!existsSync(GRANTS));
  rmSync(LOCK);
  mkdirSync(LOCK);
  assert.throws(() => addGrant({ hosts: ["folder.example.com"], kind: "authorized", approvedBy: "test" }), /is a link or a folder, not a lock file/);
  rmSync(LOCK, { recursive: true });
  reset();
});

test("a live lock older than 30 s is cleared, and the write goes on", () => {
  reset();
  const owner = aliveProcess();
  writeFileSync(LOCK, JSON.stringify({ pid: owner.pid, at: Date.now() - 40_000 }));
  const old = new Date(Date.now() - 40_000);
  utimesSync(LOCK, old, old);
  process.env.TOUCHSTONE_STORE_LOCK_WAIT_MS = "200";
  addGrant({ hosts: ["after-old.example.com"], kind: "authorized", approvedBy: "test" });
  assert.deepEqual(readGrants().map((g) => g.hosts[0]), ["after-old.example.com"]);
  owner.kill();
  reset();
});

test("a slow writer whose lock was taken over refuses its write, and leaves the new lock alone", () => {
  reset();
  addGrant({ hosts: ["kept.example.com"], kind: "authorized", approvedBy: "test" });
  const before = readFileSync(GRANTS, "utf8");
  assert.throws(
    () =>
      withStoreLock(GRANTS, "grant store", () => {
        const all = loadGrants();
        // While this writer was stopped, another process judged its lock stale
        // and took it over.
        rmSync(LOCK);
        writeFileSync(LOCK, JSON.stringify({ pid: 1, at: Date.now() }));
        saveStore(GRANTS, [...all, { id: "lost" }]);
      }),
    /^Error: Refused: another process took over the store lock .+ during this write \(it was held longer than 30 s\)\. Nothing was changed\. Try again\.$/,
  );
  assert.equal(readFileSync(GRANTS, "utf8"), before, "nothing written");
  assert.equal(JSON.parse(readFileSync(LOCK, "utf8")).pid, 1, "the other process's lock is not removed");
  reset();
});

// Two processes judge the same stale lock at once: a test hook stops each one
// between judging and breaking, and both go on only when both are there (a
// file barrier, not a timer). Then each runs a slow read-modify-write. Only one
// may get the lock; the other waits, so neither update is lost.
const BARRIER = path.join(TEST_STORE_DIR, "barrier");
function racer(tag) {
  const code = `
    const g = await import(${JSON.stringify(STORE)});
    const { existsSync, writeFileSync } = await import("node:fs");
    const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    let first = true;
    g.lockTestHooks.afterStaleJudged = () => {
      if (!first) return;
      first = false;
      writeFileSync(${JSON.stringify(BARRIER)} + ".${tag}", "");
      const until = Date.now() + 10000;
      while (!(existsSync(${JSON.stringify(BARRIER)} + ".one") && existsSync(${JSON.stringify(BARRIER)} + ".two")) && Date.now() < until) pause(5);
    };
    g.withStoreLock(process.env.TOUCHSTONE_GRANTS_FILE, "grant store", () => {
      const all = g.loadGrants();
      pause(300); // a slow mutation: the other process must not be inside now
      g.saveStore(process.env.TOUCHSTONE_GRANTS_FILE, [...all, { id: "${tag}" }]);
    });`;
  const c = spawn(process.execPath, ["--input-type=module", "-e", code], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(c);
  let err = "";
  c.stderr.on("data", (d) => (err += d));
  return new Promise((res) => c.on("exit", (code) => res({ code, err })));
}

test("two processes that find the same stale lock: only one takes it over, and no update is lost", async () => {
  reset();
  writeFileSync(GRANTS, "[]");
  writeFileSync(LOCK, JSON.stringify({ pid: await deadPid(), at: Date.now() }));
  process.env.TOUCHSTONE_STORE_LOCK_WAIT_MS = "10000";
  const results = await Promise.all([racer("one"), racer("two")]);
  for (const r of results) assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(`${BARRIER}.one`) && existsSync(`${BARRIER}.two`), "both judged the same stale lock");
  rmSync(`${BARRIER}.one`, { force: true });
  rmSync(`${BARRIER}.two`, { force: true });
  assert.deepEqual(JSON.parse(readFileSync(GRANTS, "utf8")).map((g) => g.id).sort(), ["one", "two"]);
  assert.ok(!existsSync(LOCK));
  reset();
});

test("with no wait setting, a stuck live lock is refused within a short bound: one stuck lock cannot freeze the console", () => {
  reset();
  const owner = aliveProcess();
  writeFileSync(LOCK, JSON.stringify({ pid: owner.pid, at: Date.now(), token: "stuck" }));
  const t0 = Date.now();
  assert.throws(() => addGrant({ hosts: ["stuck.example.com"], kind: "authorized", approvedBy: "test" }), /^Error: Refused: the grant store is busy\./);
  const waited = Date.now() - t0;
  assert.ok(waited >= 250 && waited < 1500, `waited ${waited} ms: at least the bound, never seconds`);
  owner.kill();
  reset();
});

// The gap between judging a lock stale and breaking it: another process may
// have broken it already and made a fresh lock. The breaker must leave that
// fresh lock alone (it compares the whole lock, token included), or the fresh
// lock's owner would be refused at its save for a lock that was never stale.
test("a lock made in the gap after the stale lock was judged is never removed", async () => {
  reset();
  writeFileSync(LOCK, JSON.stringify({ pid: await deadPid(), at: Date.now(), token: "stale" }));
  const owner = aliveProcess();
  lockTestHooks.afterStaleJudged = () => {
    lockTestHooks.afterStaleJudged = null;
    // Another process broke the stale lock and made its own.
    rmSync(LOCK);
    writeFileSync(LOCK, JSON.stringify({ pid: owner.pid, at: Date.now(), token: "fresh" }));
  };
  process.env.TOUCHSTONE_STORE_LOCK_WAIT_MS = "150";
  try {
    assert.throws(() => addGrant({ hosts: ["gap.example.com"], kind: "authorized", approvedBy: "test" }), /^Error: Refused: the grant store is busy\./);
    assert.equal(JSON.parse(readFileSync(LOCK, "utf8")).token, "fresh", "the fresh lock is still there");
    assert.ok(!existsSync(`${LOCK}.break`), "no breaker file is left");
  } finally {
    lockTestHooks.afterStaleJudged = null;
    owner.kill();
    reset();
  }
});
