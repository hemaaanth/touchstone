// A Strix scan on a model with no published price is charged at FALLBACK_PRICE,
// the same prices its cap check uses. Without that, the real runStrix prices
// the usage at $0, the ledger never moves, and every next scan passes the cap.
// This goes through the real runStrix and live prepass. Docker is mocked: the
// fake container writes Strix's run.json usage record. The ledger is a temp file.
import { test, mock, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "strix-unpriced-"));
const LEDGER = join(dir, "spend.json");
process.env.SPEND_LEDGER = LEDGER;
process.env.SPEND_CAP_USD = "2";
process.env.STRIX_TMPDIR = dir;
delete process.env.STRIX_BUDGET_USD;
delete process.env.STRIX;

// The active provider's first model. Set per test; no price by default.
let model = { id: "unknown-gateway-model" };
const FAKE = { id: "fake", label: "Fake", baseUrl: "http://127.0.0.1:9", keyEnv: null, get models() { return { m: model }; } };
const realProviders = await import("../lib/providers.mjs");
mock.module("../lib/providers.mjs", { namedExports: {
  ...realProviders,
  readConfig: () => ({}),
  activeProvider: () => FAKE,
  providerKey: () => "test-key",
} });
mock.module("../lib/proof-http.mjs", { namedExports: { requireImage: async () => {} } });
mock.module("../lib/reach-confine.mjs", { namedExports: { dockerReady: async () => ({ ok: true }) } });
mock.module("../lib/sandbox.mjs", { namedExports: { readTouchstone: () => ({ baseUrl: "http://site.test" }) } });
mock.module("../lib/live.mjs", { namedExports: { SCAN_NETWORK: "scan-net", bindLive: () => {} } });
mock.module("../packs/web/scan.mjs", { namedExports: {
  scanWeb: async () => ({ coverage: [], leads: [] }),
  docQueryUrls: () => [],
  mergeLeads: (leads) => leads,
} });
// The fake Strix container: it writes a run dir with one usage record, the
// size of one full worst turn (1M tokens in, 65536 out).
let scans = 0;
const scanArgs = [];
mock.module("../lib/wrap.mjs", { namedExports: {
  runDocker: async (args) => {
    if (!args.includes("--target")) return { code: 0, stdout: "", stderr: "" };
    scans++;
    scanArgs.push(args);
    const work = args.find((a) => a.endsWith(":/work")).split(":")[0];
    const run = join(work, "strix_runs", "site-test_1");
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, "findings.sarif"), JSON.stringify({ version: "2.1.0", runs: [{ results: [] }] }));
    writeFileSync(join(run, "run.json"), JSON.stringify({ llm_usage: { input_tokens: 1_000_000, output_tokens: 65_536 } }));
    return { code: 0, stdout: "", stderr: "" };
  },
} });

const { livePrepass } = await import("../packs/web/live.mjs");

const total = () => JSON.parse(readFileSync(LEDGER, "utf8")).totalUsd;
const strixOf = (r) => r.record.coverage.find((c) => c.engine === "strix");
const prepass = () => livePrepass(dir, { reach: { confine: { netClient: "n", gateUrl: "http://gate" }, hosts: [] } });
const envOf = (args, name) => args.find((a) => a.startsWith(`${name}=`))?.split("=")[1];
const near = (a, b) => Math.abs(a - b) < 1e-9;

beforeEach(() => {
  scans = 0;
  scanArgs.length = 0;
  model = { id: "unknown-gateway-model" };
  writeFileSync(LEDGER, JSON.stringify({ totalUsd: 0, calls: 0, byModel: {} }));
});
after(() => rmSync(dir, { recursive: true, force: true }));

test("strix unpriced: the first scan charges the ledger at the fallback price, the second is refused", async () => {
  // Worst case $0.50 + $1 + $0.32768 = $1.82768 fits the $2 cap, so it runs.
  const first = await prepass();
  assert.equal(strixOf(first).status, "ran", strixOf(first).reason ?? "");
  // 1M in at $1/1M plus 65536 out at $5/1M.
  assert.ok(near(total(), 1.32768), `ledger ${total()}`);
  assert.equal(envOf(scanArgs[0], "STRIX_LLM_INPUT_COST_PER_MTOK"), "1");
  assert.equal(envOf(scanArgs[0], "STRIX_LLM_OUTPUT_COST_PER_MTOK"), "5");
  // $1.32768 + $1.82768 is over the $2 cap: no second scan starts.
  const second = await prepass();
  assert.equal(scans, 1);
  assert.equal(strixOf(second).status, "unavailable");
  assert.match(strixOf(second).reason, /Total spend cap reached/);
  assert.ok(near(total(), 1.32768));
});

test("strix unpriced: one missing price gets the fallback for that one; a price of 0 stays 0", async () => {
  model = { id: "half-priced", input: 0 };
  await prepass();
  assert.equal(envOf(scanArgs[0], "STRIX_LLM_INPUT_COST_PER_MTOK"), "0");
  assert.equal(envOf(scanArgs[0], "STRIX_LLM_OUTPUT_COST_PER_MTOK"), "5");
  // Input at $0, output 65536 at the fallback $5/1M.
  assert.ok(near(total(), 0.32768), `ledger ${total()}`);
});
