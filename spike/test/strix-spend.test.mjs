// Strix makes its own model calls, so the web pre-pass checks the total spend
// cap before a scan and puts the scan's cost on the shared ledger after it.
// In the app the pre-pass runs in the long-lived server process, so it must not
// use that process's run budget: three $4.30 scans under a $5 run budget must
// all run while the total cap allows them. Offline: the scanners, Docker and
// the provider are fakes; the ledger is a temp file.
import { test, mock, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "strix-spend-"));
const LEDGER = join(dir, "spend.json");
// As in the app server: one process, a $5 run budget, the default total cap.
process.env.SPEND_LEDGER = LEDGER;
process.env.RUN_BUDGET_USD = "5";
delete process.env.SPEND_CAP_USD;
delete process.env.STRIX_BUDGET_USD;

const FAKE = { id: "fake", label: "Fake", baseUrl: "http://127.0.0.1:9", keyEnv: null, models: { m: { id: "fake-model", input: 1, output: 5 } } };
const realProviders = await import("../lib/providers.mjs");
mock.module("../lib/providers.mjs", { namedExports: {
  ...realProviders,
  readConfig: () => ({}),
  activeProvider: () => FAKE,
  providerKey: () => "test-key",
} });
mock.module("../lib/proof-http.mjs", { namedExports: { requireImage: async () => {} } });
mock.module("../lib/sandbox.mjs", { namedExports: { readTouchstone: () => ({ baseUrl: "http://site.test" }) } });
mock.module("../lib/live.mjs", { namedExports: { SCAN_NETWORK: "scan-net", bindLive: () => {} } });
mock.module("../packs/web/scan.mjs", { namedExports: {
  scanWeb: async () => ({ coverage: [], leads: [] }),
  docQueryUrls: () => [],
  mergeLeads: (leads) => leads,
} });
let scans = 0;
mock.module("../lib/strix.mjs", { namedExports: {
  DEFAULT_BUDGET_USD: 0.5,
  runStrix: async () => {
    scans++;
    return { status: "ok", leads: [], costUsd: 4.3, coverage: { engine: "strix", status: "ok", leads: 0, costUsd: 4.3 } };
  },
} });

const { livePrepass } = await import("../packs/web/live.mjs");
const { runSpend } = await import("../lib/inference.mjs");

const ledger = (totalUsd) => writeFileSync(LEDGER, JSON.stringify({ totalUsd, calls: 0, byModel: {} }));
const total = () => JSON.parse(readFileSync(LEDGER, "utf8")).totalUsd;
const strixOf = (r) => r.record.coverage.find((c) => c.engine === "strix");
const prepass = () => livePrepass(dir, { reach: { confine: { netClient: "n", gateUrl: "http://gate" }, hosts: [] } });

beforeEach(() => {
  scans = 0;
  ledger(0);
});
after(() => rmSync(dir, { recursive: true, force: true }));

test("strix: three $4.30 scans in one process all run and all go on the ledger", async () => {
  for (let i = 1; i <= 3; i++) {
    const r = await prepass();
    assert.equal(strixOf(r).status, "ok", `scan ${i}: ${strixOf(r).reason ?? ""}`);
  }
  assert.equal(scans, 3);
  assert.ok(Math.abs(total() - 12.9) < 1e-9, `ledger ${total()}`);
  const l = JSON.parse(readFileSync(LEDGER, "utf8"));
  assert.equal(l.calls, 3);
  assert.equal(l.byModel["fake/fake-model (strix)"].calls, 3);
  // Not this process's run spend: the server's run budget stays untouched.
  assert.equal(runSpend().usd, 0);
});

test("strix: no scan starts when its budget would pass the total cap", async () => {
  // $50.50 spent: a $0.50 scan would end at $51.00, over the $50.85 cap.
  ledger(50.5);
  const r = await prepass();
  assert.equal(scans, 0);
  assert.equal(strixOf(r).status, "unavailable");
  assert.match(strixOf(r).reason, /Total spend cap reached/);
  assert.equal(total(), 50.5);
  // $50.30 spent: the scan fits, so it runs.
  ledger(50.3);
  assert.equal(strixOf(await prepass()).status, "ok");
  assert.equal(scans, 1);
});
