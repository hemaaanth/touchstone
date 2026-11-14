import "./helpers/isolated-env.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let stalled;
const wrap = await import("../lib/wrap.mjs");
mock.module("../lib/wrap.mjs", { exports: { ...wrap, runDocker: async (args) => {
  const command = args.at(-1);
  assert.match(command, /echidna|medusa/);
  const engine = command.includes("echidna Harness.sol") ? "Echidna" : "Medusa";
  const timedOut = engine === stalled;
  return { code: timedOut ? 124 : 0, stderr: "", timedOut,
    stdout: timedOut ? "" : engine === "Echidna" ? "echidna_solvent: passing\n" : "Test summary:\n" };
} } });
const { writeTouchstone } = await import("../lib/sandbox.mjs");
const { default: contracts } = await import("../packs/contracts/pack.mjs");
const { prepassView } = await import("../lib/prepass-view.mjs");

for (const engine of ["Echidna", "Medusa"]) {
  test(`${engine} timeout before output survives the other fuzzer succeeding`, async () => {
    const ws = mkdtempSync(join(tmpdir(), "fuzz-coverage-"));
    try {
      mkdirSync(join(ws, "src"));
      writeFileSync(join(ws, "src", "YieldVault.sol"), readFileSync(new URL("../../lab/vault-accounting/src/YieldVault.sol", import.meta.url)));
      writeTouchstone(ws, { modules: [{ id: "fuzz", on: true }] });
      stalled = engine;
      const events = [];
      const prep = await contracts.prepass(ws, { emit: (event) => events.push(event) });
      assert.match(prep.env.FUZZ_GAP, /time limit/);
      assert.match(events.find((event) => event.ev === "fuzz-scan").gap, /time limit/);
      assert.match(prep.record.fuzz.gap, /time limit/);
      assert.match(contracts.kickoff(ws, prep.env), /time limit/);
      const tool = prepassView(prep.record).tools.find((tool) => /Echidna|Medusa/.test(tool.name));
      assert.match(tool.reason, /time limit/);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });
}
