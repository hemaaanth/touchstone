// The CLI runner (agent-run.mjs) must not record a clean run when part of the
// scope was not read.
//
//   node --experimental-test-module-mocks --test spike/test/agent-run-coverage.test.mjs
//
// agent-run.mjs runs on import. spawn is mocked: the "worker" is a fake child
// that prints a refused source-fetch and a settled event with no finding, then
// exits. No model is called, nothing is spent, and the record goes to a temp folder.
import "./helpers/isolated-env.mjs";
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import * as realChild from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = "https://github.com/cosmos/cosmos-sdk";
const events = [
  { ev: "source-fetch", url: REPO, ok: false, error: "cosmos/cosmos-sdk would bring this scope to 3053 source files (the cap is 200) after filtering — refused" },
  { ev: "settled", status: "done", summary: { final: { text: "Nothing to report." } }, findings: [] },
];
function spawn() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  setImmediate(() => {
    for (const e of events) child.stdout.write(`EVENT ${JSON.stringify({ t: Date.now(), ...e })}\n`);
    setTimeout(() => child.emit("exit", 0, null), 20);
  });
  return child;
}
mock.module("node:child_process", { exports: { ...realChild, default: { ...realChild, spawn }, spawn } });

const dir = mkdtempSync(path.join(tmpdir(), "agent-run-coverage-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const target = path.join(dir, "target");
mkdirSync(path.join(target, "src"), { recursive: true });
writeFileSync(path.join(target, ".touchstone.json"), JSON.stringify({ pack: "review", links: [REPO] }));
process.env.TARGET = target;
process.env.AGENT_RESULTS_DIR = path.join(dir, "results");
process.env.SPEND_LEDGER = path.join(dir, "spend.json");
delete process.env.TARGET_ID;
process.argv = [process.argv[0], "agent-run.mjs"];

test("a CLI run whose repo fetch was refused records an error, not no-finding", async () => {
  await import("../agent-run.mjs");
  const file = readdirSync(process.env.AGENT_RESULTS_DIR).find((f) => f.endsWith(".json"));
  assert.ok(file, "the run record was written");
  const { result } = JSON.parse(readFileSync(path.join(process.env.AGENT_RESULTS_DIR, file), "utf8"));
  assert.equal(result.outcome, "error");
  assert.match(result.error ?? "", /1 of 1 scope member was not read/);
  assert.deepEqual(result.sourceCoverage?.members?.map((m) => [m.url, m.status]), [[REPO, "refused"]]);
});
