// Strix is best-effort: a Strix failure degrades to "unavailable" with a reason
// and never throws into the run. Docker is mocked; the file system is real.
import "./helpers/isolated-env.mjs";
import { STRIX_SANDBOX_IMAGE } from "../lib/images.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The two lines a real live run on example.com printed when Strix's own agent
// crashed (run-…-2611122323-4.stream.jsonl, web-strix-line events).
const REAL_CRASH = [
  "2026-11-12 23:27:50.482 ERROR example-com_3681 - strix.core.execution: agent run failed for 7693ddc3; marking stopped",
  'File "/usr/local/lib/python3.12/site-packages/agents/result.py", line 931, in stream_events',
];

// The findings.sarif that same crashed run wrote: coverage rows only, and
// executionSuccessful: false ("The scan ended with status 'interrupted' ...").
const CRASHED_SARIF = readFileSync(new URL("./fixtures/strix-crashed-example-com.sarif", import.meta.url), "utf8");

const SARIF = JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "Strix" } }, results: [
  { ruleId: "CWE-79", level: "warning", message: { text: "XSS in /search" } },
] }] });

// What the next scan's container does. Set per test.
let scenario = async () => ({ code: 0, stdout: "", stderr: "" });
const calls = [];
const workOf = (args) => args.find((a) => a.endsWith(":/work"))?.split(":")[0];

mock.module("../lib/wrap.mjs", { namedExports: {
  runDocker: async (args, opts = {}) => {
    calls.push(args);
    // The cleanup container: it runs as Strix's user, so it may delete.
    if (args.includes("--entrypoint")) {
      const dir = workOf(args);
      const own = (d) => {
        chmodSync(d, 0o755);
        for (const f of readdirSync(d, { withFileTypes: true })) if (f.isDirectory()) own(join(d, f.name));
      };
      own(dir);
      for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true, force: true });
      return { code: 0, stdout: "", stderr: "" };
    }
    return scenario(args, opts);
  },
} });
mock.module("../lib/reach-confine.mjs", { namedExports: { dockerReady: async () => ({ ok: true }) } });
mock.module("../lib/proof-http.mjs", { namedExports: { requireImage: async () => {} } });

const base = mkdtempSync(join(tmpdir(), "strix-test-"));
process.env.STRIX_TMPDIR = base;
const { runStrix, sarifIncomplete } = await import("../lib/strix.mjs");
const provider = { baseUrl: "http://127.0.0.1:1", key: "k", model: "m" };

test("a crashed Strix agent with no findings is unavailable, not a clean scan", async () => {
  scenario = async (_args, { stream }) => {
    stream("stdout", REAL_CRASH.join("\n") + "\n");
    return { code: 0, stdout: "", stderr: "" };
  };
  const events = [];
  const r = await runStrix({ baseUrl: "https://example.com", provider, emit: (e) => events.push(e) });
  assert.ok(calls.some((args) => args.includes(`STRIX_IMAGE=${STRIX_SANDBOX_IMAGE}`)));
  assert.equal(r.status, "unavailable");
  assert.match(r.reason, /agent run failed/);
  assert.equal(r.coverage.status, "unavailable");
  assert.equal(r.leads.length, 0);
  assert.equal(events.at(-1).ev, "web-strix-done");
  assert.match(events.at(-1).reason, /agent run failed/);
});

test("a work dir the host cannot delete keeps the leads and is removed from a container", async () => {
  let work;
  scenario = async (args) => {
    work = workOf(args);
    const run = join(work, "strix_runs", "example-com_1");
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, "findings.sarif"), SARIF);
    // Strix's container owns these: the host user cannot unlink them (EACCES).
    chmodSync(run, 0o555);
    return { code: 0, stdout: "", stderr: "" };
  };
  const r = await runStrix({ baseUrl: "https://example.com", provider });
  assert.equal(r.status, "ran", r.reason);
  assert.equal(r.leads.length, 1);
  assert.equal(r.leads[0].check, "CWE-79");
  assert.ok(calls.some((a) => a.includes("--entrypoint")), "cleanup ran in a container");
  assert.equal(existsSync(work), false);
});

test("the real crashed run: crash log and an incomplete SARIF make strix unavailable", async () => {
  let work;
  scenario = async (args, { stream }) => {
    work = workOf(args);
    stream("stdout", REAL_CRASH.join("\n") + "\n");
    const run = join(work, "strix_runs", "example-com_3681");
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, "findings.sarif"), CRASHED_SARIF);
    chmodSync(run, 0o555); // root-owned on the real host
    return { code: 0, stdout: "", stderr: "" };
  };
  const r = await runStrix({ baseUrl: "https://example.com", provider });
  assert.equal(r.status, "unavailable");
  assert.match(r.reason, /did not finish and reported nothing: .*agent run failed/);
  assert.equal(r.leads.length, 0);
  assert.equal(existsSync(work), false);
});

test("Strix's own SARIF verdict: interrupted is incomplete, a plain document is not", () => {
  assert.match(sarifIncomplete(CRASHED_SARIF), /interrupted/);
  assert.equal(sarifIncomplete(SARIF), null);
  assert.equal(sarifIncomplete("not json"), null);
});

test("an unusable temp dir falls back to another one", async () => {
  process.env.STRIX_TMPDIR = join(base, "missing", "nested");
  try {
    let work;
    scenario = async (args) => { work = workOf(args); return { code: 0, stdout: "", stderr: "" }; };
    const r = await runStrix({ baseUrl: "https://example.com", provider });
    assert.ok(work && !work.startsWith(join(base, "missing")));
    assert.notEqual(r.status, undefined);
  } finally {
    process.env.STRIX_TMPDIR = base;
  }
});

test("a throw inside the scan degrades to unavailable and never reaches the run", async () => {
  scenario = async () => { throw new Error("docker went away"); };
  const r = await runStrix({ baseUrl: "https://example.com", provider, emit: () => { throw new Error("view broke"); } });
  assert.equal(r.status, "unavailable");
  assert.match(r.reason, /docker went away/);
  rmSync(base, { recursive: true, force: true });
});
