// A run in flight across the upgrade, resumed at boot (runs.mjs resumeRun ->
// spawnAgent), loses the BRIEF.md Touchstone used to write before its worker
// starts. A BRIEF.md that is a directory is left alone and does not stop the run.
//
//   node --experimental-test-module-mocks --test spike/test/scope-brief-boot.test.mjs
//
// spawn is mocked: no engine, no model, nothing spent.
import "./helpers/isolated-env.mjs";
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import * as realChild from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const spawns = [];
function spawn(cmd, args, opts = {}) {
  const [, , mode, db, ws] = args;
  const brief = lstatSync(path.join(ws, "BRIEF.md"), { throwIfNoEntry: false });
  spawns.push({ mode, ws, env: opts.env ?? {}, brief: brief ? (brief.isDirectory() ? "dir" : "file") : null });
  writeFileSync(db, "");
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = Object.assign(new EventEmitter(), { writable: true, write() {} });
  child.kill = () => {};
  setImmediate(() => {
    child.stdout.write(`EVENT ${JSON.stringify({ t: Date.now(), ev: "settled", status: "done", summary: { final: { text: "Done." } }, findings: [] })}\n`);
    setTimeout(() => child.emit("exit", 0, null), 20);
  });
  return child;
}
mock.module("node:child_process", { exports: { ...realChild, default: { ...realChild, spawn }, spawn } });

const dir = mkdtempSync(path.join(tmpdir(), "scope-brief-boot-"));
process.env.TOUCHSTONE_RESULTS_DIR = dir;
process.env.TOUCHSTONE_SCOPES_FILE = path.join(dir, "scopes.json");
process.env.TOUCHSTONE_GRANTS_FILE = path.join(dir, "grants.json");
process.env.SPEND_LEDGER = path.join(dir, "spend.json"); // never the real ledger
const workspaces = [];
after(() => {
  for (const ws of workspaces) rmSync(ws, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

const target = { id: "scope-svc-0000aaaa", kind: "scope", title: "svc", pack: "review", members: [{ kind: "repo", url: "https://github.com/acme/svc" }], links: ["https://github.com/acme/svc"], brief: "Start with the handlers." };
// A run saved in the agent phase, as a server that stopped mid-run leaves it.
// The workspace is a real run folder name under the temp folder.
function saved(name, brief) {
  const id = `${name}-2611122323-1`;
  const ws = mkdtempSync(path.join(tmpdir(), "redteam-run-"));
  workspaces.push(ws);
  writeFileSync(path.join(ws, ".touchstone.json"), JSON.stringify({ kind: "scope", pack: "review", modules: [], links: target.links }));
  if (brief === "file") writeFileSync(path.join(ws, "BRIEF.md"), "# svc\nOld Touchstone brief.\n");
  if (brief === "dir") mkdirSync(path.join(ws, "BRIEF.md"));
  const events = [
    { t: 1, ev: "scope", scope: { id: target.id, title: target.title, kind: "scope", pack: "review" } },
    { t: 2, ev: "brief", text: target.brief },
    { t: 3, ev: "budget", usd: 1 },
    { t: 4, ev: "mode", mode: "solo" },
    { t: 5, ev: "provider", provider: "boundless", model: "fake" },
    { t: 6, ev: "status", status: "running" },
  ];
  writeFileSync(path.join(dir, `run-${id}.stream.jsonl`), events.map((e) => JSON.stringify(e) + "\n").join(""));
  writeFileSync(path.join(dir, `run-${id}.state.json`), JSON.stringify({ ws, target, phase: "agent", mode: "solo", modules: [], budget: 1, provider: "boundless", model: "fake" }));
  return { id, ws };
}
const withFile = saved("brief-file", "file");
const withDir = saved("brief-dir", "dir");

const { getRun } = await import("../../app/server/runs.mjs");
async function settled(id) {
  for (let i = 0; i < 300; i++) {
    const r = getRun(id);
    if (r && ["recorded", "no-finding", "error"].includes(r.status) && r.events.some((e) => e.ev === "closed")) return r;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error(`run ${id} did not settle: ${getRun(id)?.status}`);
}

test("a run resumed at boot loses the old BRIEF.md before its worker starts, and keeps its brief", async () => {
  const r = await settled(withFile.id);
  const call = spawns.find((s) => s.ws === withFile.ws);
  assert.ok(call, "the worker started");
  assert.equal(call.mode, "run");
  assert.equal(call.brief, null, "no BRIEF.md when the worker started");
  assert.equal(call.env.SCOPE_BRIEF, "Start with the handlers.");
  // The fake engine fetches nothing, so the run ends as "the scope was not read".
  assert.equal(r.errorInfo?.reason, "source-not-covered");
});

test("a BRIEF.md that is a directory is left alone, and the resumed run still ends", async () => {
  const r = await settled(withDir.id);
  const call = spawns.find((s) => s.ws === withDir.ws);
  assert.ok(call, "the worker started");
  assert.equal(call.brief, "dir", "the directory is not Touchstone's file, so it stays");
  assert.equal(r.errorInfo?.reason, "source-not-covered", "it ended the normal way, not on a throw");
  assert.ok(!r.replying);
});
