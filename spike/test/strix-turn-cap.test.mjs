// A per-agent turn cap is a STOP, not a crash: Strix prints "agent run failed
// ... marking stopped" and then the MaxTurnsExceeded traceback 40+ lines later,
// which used to fall out of the 40-line tail and read as a crash. A dead Caido
// proxy is a coverage gap, not a crash either.
import "./helpers/isolated-env.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SARIF = JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "Strix" } }, results: [] }] });
let scenario = async () => ({ code: 1, stdout: "", stderr: "" });

mock.module("../lib/wrap.mjs", { namedExports: {
  runDocker: async (args, opts = {}) => {
    if (args.includes("--entrypoint")) {
      const dir = args.find((a) => a.endsWith(":/work"))?.split(":")[0];
      chmodSync(dir, 0o755);
      for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true, force: true });
      return { code: 0, stdout: "", stderr: "" };
    }
    return scenario(args, opts);
  },
} });
mock.module("../lib/reach-confine.mjs", { namedExports: { dockerReady: async () => ({ ok: true }) } });
mock.module("../lib/proof-http.mjs", { namedExports: { requireImage: async () => {} } });

const base = mkdtempSync(join(tmpdir(), "strix-cap-"));
process.env.STRIX_TMPDIR = base;
const { runStrix, STRIX_DEFAULTS } = await import("../lib/strix.mjs");
const provider = { baseUrl: "http://127.0.0.1:1", key: "k", model: "m" };

test("the default turn cap leaves room for a live target's first agent", () => {
  assert.ok(STRIX_DEFAULTS.turns >= 40, `expected a generous per-agent cap, got ${STRIX_DEFAULTS.turns}`);
});

test("a turn-cap stop is timed-out with its own reason, not a crash", async () => {
  scenario = async (_args, { stream }) => {
    stream("stdout", [
      "2026-11-14 18:17:59.934 ERROR app-x_5401 - strix.core.execution: agent run failed for 15; marking stopped",
      'File "/usr/local/lib/python3.12/site-packages/agents/result.py", line 931, in stream_events',
      "agents.exceptions.MaxTurnsExceeded: Max turns (15) exceeded",
    ].join("\n") + "\n");
    return { code: 1, stdout: "", stderr: "" };
  };
  const r = await runStrix({ baseUrl: "https://example.com", provider, turns: 15 });
  assert.equal(r.status, "timed-out");
  assert.match(r.reason, /15-turn-per-agent cap/);
  assert.doesNotMatch(r.reason, /did not finish/);
});

test("a dead Caido proxy is reported as a gap and does not fail the scan", async () => {
  scenario = async (args, { stream }) => {
    stream("stdout", "WARNING x - strix.tools.proxy.tools: Caido bootstrap failed; proxy tools unavailable\n");
    const run = join(args.find((a) => a.endsWith(":/work")).split(":")[0], "strix_runs", "example-com_1");
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, "findings.sarif"), SARIF);
    return { code: 0, stdout: "", stderr: "" };
  };
  const r = await runStrix({ baseUrl: "https://example.com", provider });
  assert.equal(r.status, "ran");
  assert.match(r.reason, /Caido proxy did not start/);
  rmSync(base, { recursive: true, force: true });
});
