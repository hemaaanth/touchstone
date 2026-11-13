// Finalization always writes run-<id>.json. The fixture is the real stream of a
// live web run on example.com: Strix's agent crashed, the server stopped during
// the run, and only the stream file was left. Loading it must write a record
// that reads as an error with its reason, with no finding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ID = "deepseek-v4.1-flash-1017-abliterated-2611122323-4";
const dir = mkdtempSync(join(tmpdir(), "run-finalize-"));
copyFileSync(new URL("./fixtures/run-strix-crash-interrupted.stream.jsonl", import.meta.url), join(dir, `run-${ID}.stream.jsonl`));
process.env.TOUCHSTONE_RESULTS_DIR = dir;
const { getRun } = await import("../../app/server/runs.mjs");

test("a run the server lost mid-way gets an error record at the next load", () => {
  const file = join(dir, `run-${ID}.json`);
  assert.ok(existsSync(file), "run-<id>.json was written");
  const { result } = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(result.outcome, "error");
  assert.match(result.error, /server restarted during this run/);
  assert.deepEqual(result.findings, []);
  assert.equal(result.finding, null);
  assert.equal(result.recorded, false);
  assert.equal(result.decision, null);
  assert.equal(result.target?.entry, "example.com");
  assert.equal(result.pack, "web");
});

test("the stream stays the true record and is not changed", () => {
  const stream = readFileSync(join(dir, `run-${ID}.stream.jsonl`), "utf8");
  assert.equal(stream, readFileSync(new URL("./fixtures/run-strix-crash-interrupted.stream.jsonl", import.meta.url), "utf8"));
  assert.equal(getRun(ID).status, "error");
  rmSync(dir, { recursive: true, force: true });
});
