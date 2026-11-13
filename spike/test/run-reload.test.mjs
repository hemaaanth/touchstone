// A Vite reload re-evaluates runs.mjs in the same process. The new module must
// adopt a live run: list it, keep its events, and stop it. No model calls.
import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

const dir = mkdtempSync(join(tmpdir(), "run-reload-"));
process.env.TOUCHSTONE_RESULTS_DIR = dir;
const workers = [];
const realChild = await import("node:child_process");
mock.module("node:child_process", { exports: { ...realChild, spawn: () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
  workers.push(child);
  return child;
} } });
after(() => rmSync(dir, { recursive: true, force: true }));

const wait = async (ok) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
};

test("a reloaded runs module adopts a live run and can stop it", async () => {
  const id = "reload-test-2611122323-1";
  const ws = join(dir, "ws");
  mkdirSync(ws);
  writeFileSync(join(ws, ".touchstone.json"), JSON.stringify({ kind: "lab", pack: "web" }));
  const target = { id: "lab-web", title: "Web lab", kind: "lab", pack: "web" };
  const events = [
    { ev: "scope", t: 1, scope: target },
    { ev: "mode", t: 2, mode: "solo" },
    { ev: "status", t: 3, status: "running" },
  ];
  writeFileSync(join(dir, `run-${id}.stream.jsonl`), events.map((e) => JSON.stringify(e) + "\n").join(""));
  writeFileSync(join(dir, `run-${id}.state.json`), JSON.stringify({ ws, target, phase: "agent" }));

  const first = await import("../../app/server/runs.mjs");
  await wait(() => workers.length === 1);
  assert.equal(workers.length, 1);

  const second = await import(`../../app/server/runs.mjs?reload-${Date.now()}`);
  assert.ok(second.listRuns().some((r) => r.id === id && r.status === "running"));
  const seen = [];
  second.subscribe(id, (e) => seen.push(e), second.getRun(id).events.length);
  workers[0].stdout.write(`EVENT ${JSON.stringify({ ev: "tool", name: "after-reload" })}\n`);
  await wait(() => seen.some((e) => e.name === "after-reload"));
  assert.ok(seen.some((e) => e.name === "after-reload"));
  assert.ok(second.getRun(id).events.some((e) => e.name === "after-reload"));

  assert.deepEqual(second.stopRun(id), { ok: true });
  await wait(() => second.getRun(id).status === "no-finding");
  assert.equal(second.getRun(id).status, "no-finding");
  assert.equal(second.getRun(id).events.filter((e) => e.ev === "stopped").length, 1);
  assert.equal(workers.length, 1);
  assert.equal(first.getRun(id).status, "no-finding");
});
