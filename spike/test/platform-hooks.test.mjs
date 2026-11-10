import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTouchstone } from "../lib/sandbox.mjs";

const lead = { check: "reentrancy", impact: "High", where: "Vault.withdraw", lines: [22], engines: ["Slither"], corroborated: false };
const scan = { tool: "ensemble", engines: ["Slither", "Aderyn"], mode: "project", files: 1, analysed: 1, failed: [], findings: [lead] };
const fuzz = { tool: "ensemble", engines: ["Echidna", "Medusa"], template: null, applicable: false, findings: [] };
mock.module("../lib/static.mjs", { exports: { staticScan: async () => scan, staticBrief: () => "static leads" } });
mock.module("../lib/fuzz.mjs", { exports: { fuzzScan: async () => fuzz, fuzzBrief: () => "fuzz leads" } });
const { default: contracts } = await import("../packs/contracts/pack.mjs");
const { runPrepass } = await import("../lib/prepass.mjs");
const { proveFindings } = await import("../lib/record.mjs");
const withoutTime = ({ t, ...ev }) => ev;

test("Contracts hooks preserve prepass events, leads, and existing record fields", async () => {
  const ws = mkdtempSync(join(tmpdir(), "pack-hooks-"));
  try {
    for (const modules of [undefined, [], [{ id: "static", on: true }], [{ id: "fuzz", on: true }], [{ id: "static", on: true }, { id: "fuzz", on: true }]]) {
      writeTouchstone(ws, { modules });
      const legacyEvents = [], events = [];
      const legacy = await runPrepass(ws, {
        runStatic: modules == null || modules.some((m) => m.id === "static" && m.on),
        runFuzz: modules == null || modules.some((m) => m.id === "fuzz" && m.on),
        onStatic: (ev) => legacyEvents.push(ev), onFuzz: (ev) => legacyEvents.push(ev),
      });
      const prep = await contracts.prepass(ws, { emit: (ev) => events.push(ev) });
      assert.deepEqual(prep.env, legacy.runEnv);
      assert.deepEqual(events.map(withoutTime), legacyEvents.map(withoutTime));
      const record = {};
      if (legacy.scan) record.static = { tool: scan.tool, engines: scan.engines, mode: scan.mode, files: scan.files, analysed: scan.analysed, suspects: 1, top: legacy.scanEvent.top };
      if (legacy.fuzz) record.fuzz = { tool: fuzz.tool, engines: fuzz.engines, template: fuzz.template, applicable: false, suspects: 0, top: legacy.fuzzEvent.top };
      assert.deepEqual(prep.record, record);
    }
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("Contracts proof keeps severity order and does not prove an unrun test", async () => {
  const found = [{ n: 1, title: "low", severity: "low", poc: "Unrun" }, { n: 2, title: "high", severity: "high", poc: "Passed" }];
  const events = [{ ev: "run_poc-done", contract: "Passed", passed: true }];
  const findings = await contracts.prove("unused", found, events);
  assert.deepEqual(findings, await proveFindings("unused", found, events));
  assert.deepEqual(findings.map((f) => [f.title, f.pocProved, f.proof]), [["high", true, null], ["low", false, null]]);
});
