// The attack-class sweep and the scan-gap report.
//
//   node --experimental-test-module-mocks --test spike/test/attack-classes.test.mjs
//
// Three behaviours are pinned here, each one a failure the poll of the DefiLlama
// corpus found in the old code:
//   1. A finding must name a class from the sweep, and the class is recorded.
//   2. A scan that read no file is a gap, not a clean pass — in the brief the
//      agent reads and in the tools row the operator sees.
//   3. Contracts runs our own crypto source checks, so an ungated privileged
//      function reaches the model even when Slither and Aderyn find nothing.
//
// The scans are mocked: no Docker, no model, no spend.
import "./helpers/isolated-env.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTouchstone } from "../lib/sandbox.mjs";

// A static scan that read nothing, and one that read everything.
const deadScan = { tool: "Slither", engines: ["Slither"], mode: "per-file", files: 2, analysed: 0, failed: 2, findings: [] };
const cleanScan = { tool: "Slither", engines: ["Slither"], mode: "unit", files: 2, analysed: 2, failed: 0, findings: [] };
// No fuzz template fit the target: applicable:false, zero findings.
const noFuzz = { tool: "Echidna + Medusa", engines: [], template: null, applicable: false, findings: [] };
let nextScan = deadScan;
mock.module("../lib/static.mjs", {
  exports: {
    staticScan: async () => nextScan,
    // The real renderer formats the merged board; rendering the check names here
    // keeps the assertion about prepass's wiring, not about the format.
    staticBrief: (scan) => (scan.findings ?? []).map((d) => `${d.check} at ${d.where}`).join("\n"),
    staticGap: (scan) => (scan.mode !== "none" && (!scan.analysed || scan.failed)
      ? `Static analysis did not run on this target: Slither read ${scan.analysed} of ${scan.files} file(s). That is a gap, not a clean result.`
      : ""),
  },
});
mock.module("../lib/fuzz.mjs", {
  exports: {
    fuzzScan: async () => noFuzz,
    fuzzBrief: () => "",
    fuzzGap: () => "Property fuzzing did not run on this target: no invariant template fit.",
  },
});

const { classChecklist, classIds, normalizeClass, ATTACK_CLASSES } = await import("../lib/attack-classes.mjs");
const { runPrepass } = await import("../lib/prepass.mjs");
const { prepassView } = await import("../lib/prepass-view.mjs");
const { default: contracts } = await import("../packs/contracts/pack.mjs");

test("the sweep covers the classes the corpus says take money", () => {
  const ids = classIds().split(", ");
  // The four biggest uncovered classes from the 2025+ EVM DeFi set.
  for (const id of ["oracle", "first-depositor", "share-accounting", "access-control", "signature"]) {
    assert.ok(ids.includes(id), `${id} is in the sweep`);
  }
  // `other` exists so an honest miss can still be recorded, and it is last.
  assert.equal(ids[ids.length - 1], "other");
  // Every row carries a question, not just a label.
  for (const c of ATTACK_CLASSES) assert.ok(c.prompt.length > 40, `${c.id} has a prompt`);
  // The prompt is one line per class, so the model can answer by id.
  assert.match(classChecklist(), /`share-accounting` \(Share and debt accounting\)/);
});

test("a class is accepted by id or by label, and anything else is refused", () => {
  assert.equal(normalizeClass("share-accounting"), "share-accounting");
  assert.equal(normalizeClass("Share and debt accounting"), "share-accounting");
  assert.equal(normalizeClass("Share_accounting"), "share-accounting");
  assert.equal(normalizeClass("reentrancy"), "reentrancy");
  assert.equal(normalizeClass("not-a-class"), null);
  assert.equal(normalizeClass(""), null);
  assert.equal(normalizeClass(undefined), null);
});

test("a finding with no class is refused before any replay runs, and the reason lists the ids", async () => {
  const ws = mkdtempSync(join(tmpdir(), "class-gate-"));
  try {
    mkdirSync(join(ws, "src"), { recursive: true });
    writeFileSync(join(ws, "src", "Vault.sol"), "contract Vault {}\n");
    const state = { poc: 0, passed: new Map([["DrainTest", "contract DrainTest {}"]]), found: [] };
    const submit = contracts.tools(ws, state).find((t) => t.name === "submit_finding");
    const r = await submit.execute({ title: "t", severity: "high", poc_contract: "DrainTest", explanation: "x" });
    assert.equal(r.isError, true);
    assert.match(r.output[0].text, /`class` is missing or not one of the sweep's ids/);
    assert.match(r.output[0].text, /share-accounting/);
    assert.equal(state.found.length, 0, "nothing is recorded");
    assert.equal(state.passed.size, 1, "the passed test is untouched");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("a scan that read no file is a gap in the brief and in the tools row", async () => {
  const ws = mkdtempSync(join(tmpdir(), "class-gap-"));
  try {
    writeTouchstone(ws, {});
    mkdirSync(join(ws, "src"), { recursive: true });
    writeFileSync(join(ws, "src", "Vault.sol"), "contract Vault {}\n");
    nextScan = deadScan;
    const events = [];
    const prep = await contracts.prepass(ws, { emit: (e) => events.push(e) });
    assert.match(prep.env.STATIC_GAP, /did not run on this target: Slither read 0 of 2/);
    assert.match(prep.env.FUZZ_GAP, /no invariant template fit/);
    assert.equal(prep.env.STATIC_BRIEF, "", "there are no leads to show");
    // The agent's first message names the gap, so silence never reads as clean.
    const kick = contracts.kickoff(ws, prep.env);
    assert.match(kick, /did not run on this target/);
    assert.match(kick, /no invariant template fit/);
    // The prepass event and the operator's tools row carry it too.
    const scanEvent = events.find((e) => e.ev === "static-scan");
    assert.match(scanEvent.gap, /did not run on this target/);
    const view = prepassView(prep.record);
    assert.equal(view.tools[0].status, "unavailable");
    assert.match(view.tools[0].reason, /did not run on this target/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("a scan that read every file reports no gap", async () => {
  const ws = mkdtempSync(join(tmpdir(), "class-ok-"));
  try {
    writeTouchstone(ws, {});
    mkdirSync(join(ws, "src"), { recursive: true });
    writeFileSync(join(ws, "src", "Vault.sol"), "contract Vault {}\n");
    nextScan = cleanScan;
    const prep = await contracts.prepass(ws, { emit: () => {} });
    assert.equal(prep.env.STATIC_GAP, "");
    const view = prepassView(prep.record);
    assert.equal(view.tools[0].status, "ran");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("Contracts runs our own crypto source checks, so an ungated privileged function reaches the model", async () => {
  const ws = mkdtempSync(join(tmpdir(), "class-ours-"));
  try {
    writeTouchstone(ws, {});
    mkdirSync(join(ws, "src"), { recursive: true });
    // Slither and Aderyn (mocked as clean) do not model this rule at all.
    writeFileSync(join(ws, "src", "Vault.sol"), `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Vault {
    address public owner;
    constructor() { owner = msg.sender; }
    function transferOwnership(address n) external { owner = n; }
}
`);
    nextScan = cleanScan;
    const prep = await contracts.prepass(ws, { emit: () => {} });
    const ours = JSON.parse(prep.env.STATIC_JSON).filter((d) => d.engines.includes("Touchstone"));
    assert.ok(ours.length > 0, "our checks contributed a suspect");
    assert.ok(ours.some((d) => d.check === "unprotected-control-function"),
      `expected unprotected-control-function, got ${ours.map((d) => d.check).join(", ")}`);
    assert.match(prep.env.STATIC_BRIEF, /unprotected-control-function/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("Foundry's repo-root lib is never scanned by our checks", async () => {
  const ws = mkdtempSync(join(tmpdir(), "class-vendor-"));
  try {
    writeTouchstone(ws, {});
    mkdirSync(join(ws, "src"), { recursive: true });
    writeFileSync(join(ws, "src", "Ok.sol"), "contract Ok {}\n");
    // Foundry's dependency folder. For Contracts, `vendor/` is the OPPOSITE: it is
    // where a brief's fetched scope lands, so it must be scanned. Only a root
    // `lib/` is a dependency, and the walk never enters it.
    mkdirSync(join(ws, "lib", "forge-std"), { recursive: true });
    writeFileSync(join(ws, "lib", "forge-std", "Dep.sol"), "contract Dep { address public owner; function transferOwnership(address n) external { owner = n; } }\n");
    nextScan = cleanScan;
    const prep = await contracts.prepass(ws, { emit: () => {} });
    const checks = JSON.parse(prep.env.STATIC_JSON).filter((d) => d.engines.includes("Touchstone"));
    assert.equal(checks.length, 0, "a dependency's rule belongs to the dependency");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("runPrepass returns the gaps it reported, so a caller need not re-derive them", async () => {
  const ws = mkdtempSync(join(tmpdir(), "class-ret-"));
  try {
    mkdirSync(join(ws, "src"), { recursive: true });
    writeFileSync(join(ws, "src", "Vault.sol"), "contract Vault {}\n");
    nextScan = deadScan;
    const prep = await runPrepass(ws, {});
    assert.match(prep.staticGap, /did not run/);
    assert.match(prep.fuzzGap, /no invariant template fit/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("a first-party src/lib folder IS scanned: only Foundry's repo-root lib is vendored", async () => {
  const ws = mkdtempSync(join(tmpdir(), "class-srclib-"));
  try {
    writeTouchstone(ws, {});
    mkdirSync(join(ws, "src", "lib"), { recursive: true });
    writeFileSync(join(ws, "src", "lib", "Math.sol"), "contract Math { address public owner; function setOwner(address n) external { owner = n; } }\n");
    nextScan = cleanScan;
    const prep = await contracts.prepass(ws, { emit: () => {} });
    const checks = JSON.parse(prep.env.STATIC_JSON).filter((d) => d.engines.includes("Touchstone"));
    assert.ok(checks.length > 0, "a first-party src/lib file is the operator's code");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// A tool's declared parameters are a contract with the model, and pi-durable drops
// any argument a tool does not declare. On 2026-11-14 a real run found all three
// planted bugs and had every submission refused, because `poc_contract` had been
// dropped from this schema while `class` was added: the model sent it, the runner
// discarded it, and the gate saw an empty name. Every unit test passed, because they
// call execute() directly and never go through the schema.
//
// So this test reads the SCHEMA, not the behaviour.
test("submit_finding declares every argument the model must supply", async () => {
  const ws = mkdtempSync(join(tmpdir(), "schema-"));
  try {
    mkdirSync(join(ws, "src"), { recursive: true });
    writeFileSync(join(ws, "src", "V.sol"), "contract V {}\n");
    const tools = contracts.tools(ws, { poc: 0, passed: new Map(), found: [] });
    for (const name of ["submit_finding", "run_poc"]) {
      const t = tools.find((x) => x.name === name);
      assert.ok(t, `${name} exists`);
      const props = Object.keys(t.parameters?.properties ?? {});
      const wanted = name === "submit_finding"
        ? ["title", "severity", "poc_contract", "class", "explanation"]
        : ["test_source", "contract_name"];
      for (const p of wanted) assert.ok(props.includes(p), `${name} must declare \`${p}\` (declared: ${props.join(", ")})`);
    }
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// The class must survive the proof gate. A real run proved 5 findings and the record
// carried `class: undefined` on every one, because proveFindings rebuilt each finding
// field by field and left the class out. The sweep is only worth having if the operator
// can see which classes were covered, so this pins the field through the rebuild.
test("the proof gate carries a finding's class into the record", async () => {
  const { proveFindings } = await import("../lib/record.mjs");
  const ws = mkdtempSync(join(tmpdir(), "cls-"));
  try {
    mkdirSync(join(ws, "src"), { recursive: true });
    writeFileSync(join(ws, "src", "V.sol"), "contract V {}\n");
    // No replay passes here: what is being checked is the shape of the record, so the
    // test asserts on a finding that did not prove. `class` must be there either way.
    const found = await proveFindings(ws, [
      { n: 1, title: "t", severity: "high", class: "reentrancy", poc: "NeverRan", explanation: "x", source: "contract X {}" },
    ], [], () => {});
    assert.equal(found.length, 1);
    assert.equal(found[0].class, "reentrancy", "the class survives the rebuild");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});


test("merging source checks preserves analyzer names and checks", async () => {
  const { mergeStatic } = await import("../lib/ensemble.mjs");
  const base = { file: "src/Vault.sol", where: "Vault.withdraw", lines: [20], impact: "High" };
  const existing = mergeStatic([
    { ...base, engine: "Slither", check: "reentrancy-eth" },
    { ...base, engine: "Aderyn", check: "reentrancy" },
  ]);
  const merged = mergeStatic([...existing, { ...base, engine: "Touchstone", check: "unprotected-control-function" }]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].engines, ["Slither", "Aderyn", "Touchstone"]);
  assert.deepEqual(merged[0].checks, ["reentrancy-eth", "reentrancy", "unprotected-control-function"]);
  assert.equal(merged[0].corroborated, true);
  assert.deepEqual(mergeStatic(existing), existing);
});
