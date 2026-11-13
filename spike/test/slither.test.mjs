// Slither through runTool() for the chain-watch and keys packs (lib/slither.mjs).
// The real-run tests need the image (tools/build-slither-image.sh) and skip when it
// is not built. The failure tests run without it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { SLITHER_DEFAULT_IMAGE, parseSlither, slitherLeads, slitherScan } from "../lib/slither.mjs";
import { aderynLeads, chainPrepass, sourceLeads } from "../packs/keys/common.mjs";
import chainWatch from "../packs/chain-watch/pack.mjs";
import keys from "../packs/keys/pack.mjs";
import { cleanupWorkspace, forgeTest, makeWorkspace, writePoc } from "../lib/sandbox.mjs";

const imageExists = (image) => {
  try { execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" }); return true; } catch { return false; }
};
const hasImage = imageExists(SLITHER_DEFAULT_IMAGE);
const hasAderyn = imageExists("touchstone/aderyn:0.6.8");
const CHAIN_LAB = new URL("../packs/chain-watch/lab", import.meta.url).pathname;

// Every path under the workspace with its size and mtime, to show the scan wrote nothing.
const tree = (root) => {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      out.push(`${relative(root, full)}:${st.isDirectory() ? "d" : `${st.size}:${st.mtimeMs}`}`);
      if (st.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out.sort();
};

const withImage = async (image, fn) => {
  const prev = process.env.SLITHER_IMAGE;
  process.env.SLITHER_IMAGE = image;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.SLITHER_IMAGE; else process.env.SLITHER_IMAGE = prev; }
};

// ---- parse: pure, no Docker

test("parseSlither turns detectors into leads, drops vendored files and Informational, sorts High first", () => {
  const det = (check, impact, confidence, file, el = {}) => ({ check, impact, confidence, description: `${check} here`,
    elements: [{ type: "variable", name: "x", source_mapping: { filename_relative: file, lines: [7, 8] }, type_specific_fields: { parent: { type: "contract", name: "C" } }, ...el }] });
  const report = { success: true, error: null, results: { detectors: [
    det("reentrancy-no-eth", "Medium", "Medium", "src/A.sol"),
    det("uninitialized-state", "High", "High", "src/A.sol"),
    det("naming-convention", "Informational", "High", "src/A.sol"),
    det("arbitrary-send-eth", "High", "Medium", "lib/forge-std/src/Vm.sol"),
    det("weak-prng", "High", "Medium", "src/vendor/x/B.sol"),
    det("locked-ether", "Medium", "High", "test/Foo.t.sol"),
  ] } };
  const r = parseSlither(JSON.stringify(report));
  assert.equal(r.available, true);
  assert.deepEqual(r.leads.map((l) => l.check), ["uninitialized-state", "reentrancy-no-eth"]);
  assert.equal(r.leads[0].where, "C.x");
  assert.deepEqual(r.leads[0].lines, [7, 8]);
  assert.equal(r.leads[0].engine, "Slither");
});

test("parseSlither fails closed: empty, garbage, success false and a bad detectors field are unavailable", () => {
  for (const [stdout, reason] of [
    ["", /no report/],
    ["not json {", /no report/],
    ["null", /unparsable/],
    [JSON.stringify({ success: false, error: "Error: Source file requires different compiler version\nmore", results: {} }), /Slither failed: Error: Source file requires different compiler version$/],
    [JSON.stringify({ success: true, results: { detectors: { a: 1 } } }), /unparsable/],
  ]) {
    const r = parseSlither(stdout);
    assert.equal(r.available, false, stdout);
    assert.match(r.reason, reason);
    assert.deepEqual(r.leads, []);
  }
});

// ---- failure cases through the real runTool

test("Slither reports unavailable, not clean, when the image is missing", async () => {
  const ws = makeWorkspace(CHAIN_LAB);
  try {
    const scan = await withImage("touchstone/slither:does-not-exist", () => slitherLeads(ws, { timeoutMs: 30_000 }));
    assert.equal(scan.available, false);
    assert.match(scan.reason, /image not built/);
    assert.deepEqual(scan.leads, []);
  } finally { cleanupWorkspace(ws); }
});

test("Slither reports unavailable when it times out", { skip: !hasImage && "image not built" }, async () => {
  const ws = makeWorkspace(CHAIN_LAB);
  try {
    const scan = await slitherScan(ws, { timeoutMs: 300 }); // a full scan takes over 1 s
    assert.equal(scan.available, false);
    assert.equal(scan.reason, "timed out");
    assert.deepEqual(scan.leads, []);
  } finally { cleanupWorkspace(ws); }
});

test("Slither reports unavailable when the source does not compile", { skip: !hasImage && "image not built", timeout: 300_000 }, async () => {
  const ws = makeWorkspace(CHAIN_LAB);
  try {
    writeFileSync(join(ws, "src", "Broken.sol"), "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\ncontract Broken { function f( }\n");
    const scan = await slitherScan(ws);
    assert.equal(scan.available, false, JSON.stringify(scan));
    assert.match(scan.reason, /^no report produced/);
    assert.deepEqual(scan.leads, []);
  } finally { cleanupWorkspace(ws); }
});

test("Slither reports unavailable when the pragma excludes the offline solc 0.8.38", { skip: !hasImage && "image not built", timeout: 300_000 }, async () => {
  const ws = makeWorkspace(CHAIN_LAB);
  try {
    writeFileSync(join(ws, "src", "Old.sol"), "// SPDX-License-Identifier: MIT\npragma solidity 0.7.6;\ncontract Old {}\n");
    const scan = await slitherScan(ws);
    assert.equal(scan.available, false, JSON.stringify(scan));
    assert.match(scan.reason, /compiler version/);
    assert.deepEqual(scan.leads, []);
  } finally { cleanupWorkspace(ws); }
});

// ---- the real run on the chain-watch lab

test("chain-watch lab: Slither flags the never-set `initialized` flag and leaves the workspace clean", { skip: !hasImage && "image not built", timeout: 300_000 }, async () => {
  const ws = makeWorkspace(CHAIN_LAB);
  try {
    const before = tree(ws);
    const scan = await slitherLeads(ws);
    assert.equal(scan.available, true, scan.reason);
    const lead = scan.leads.find((l) => l.check === "uninitialized-state");
    assert.ok(lead, JSON.stringify(scan.leads.map((l) => l.check)));
    assert.equal(lead.impact, "High");
    assert.equal(lead.file, "src/VaultImplementationV2.sol");
    assert.match(lead.where, /^VaultImplementationV2\.initialized \(src\/VaultImplementationV2\.sol:\d+\)$/);
    assert.ok(scan.leads.every((l) => !/^(lib|test|script)\//.test(l.file)), "no vendored or test leads");
    assert.deepEqual(tree(ws), before, "the scan must not write out/, cache/ or anything else into the workspace");
  } finally { cleanupWorkspace(ws); }
});

test("chain-watch lab: Slither finds the re-initialize bug that the source checks and Aderyn miss", { skip: (!hasImage || !hasAderyn) && "image not built", timeout: 300_000 }, async () => {
  const ws = makeWorkspace(CHAIN_LAB);
  try {
    const onVault = (l) => /VaultImplementationV2/.test(`${l.where} ${l.file ?? ""}`);
    assert.deepEqual(sourceLeads(ws).filter(onVault), [], "our source checks raise nothing on the vault");
    const aderyn = await aderynLeads(ws);
    assert.equal(aderyn.available, true, aderyn.reason);
    assert.deepEqual(aderyn.leads.filter(onVault), [], "Aderyn raises nothing on the vault");
    const slither = await slitherLeads(ws);
    assert.ok(slither.leads.some((l) => onVault(l) && l.check === "uninitialized-state"));
  } finally { cleanupWorkspace(ws); }
});

test("chain-watch prepass in source mode puts the Slither lead in the brief and the record", { skip: !hasImage && "image not built", timeout: 300_000 }, async () => {
  const ws = makeWorkspace(CHAIN_LAB);
  try {
    // Source mode: no ChainWatchLab.sol, so no Anvil world. The vault stays.
    execFileSync("rm", [join(ws, "src", "ChainWatchLab.sol")]);
    const events = [];
    const prep = await chainWatch.prepass(ws, { emit: (e) => events.push(e) });
    assert.match(prep.env.CHAIN_BRIEF, /uninitialized-state/);
    assert.match(prep.env.CHAIN_BRIEF, /VaultImplementationV2\.initialized/);
    assert.doesNotMatch(prep.env.CHAIN_BRIEF, /Slither did NOT run/);
    assert.equal(prep.record.slither, true);
    assert.ok(prep.record.top.some((l) => l.check === "uninitialized-state"));
    assert.equal(events.find((e) => e.ev === "chain-scan")?.slither, true);
  } finally { cleanupWorkspace(ws); }
});

const hasTools = imageExists("touchstone-chain-tools:wave1");

test("chain-watch prepass in lab mode (Anvil world) still shows the Slither lead in the 12-lead brief", { skip: (!hasImage || !hasTools) && "image not built", timeout: 600_000 }, async () => {
  const ws = makeWorkspace(CHAIN_LAB);
  try {
    const prep = await chainWatch.prepass(ws, { emit: () => {} });
    assert.equal(prep.record.source, false, "the lab world ran");
    assert.equal(prep.record.slither, true);
    assert.match(prep.env.CHAIN_BRIEF, /\[High\] uninitialized-state at VaultImplementationV2\.initialized .* seen only by Slither/);
    assert.match(prep.env.CHAIN_BRIEF, /No Upgraded event was emitted/, "the chain leads are still there");
  } finally { cleanupWorkspace(ws); }
});

test("chain prepass with a missing Slither image says so in the brief and the record", async () => {
  const ws = makeWorkspace(CHAIN_LAB);
  try {
    execFileSync("rm", [join(ws, "src", "ChainWatchLab.sol")]);
    const prep = await withImage("touchstone/slither:does-not-exist", () => chainPrepass(ws, { emit: () => {} }, { mode: "chain-watch", analyze: () => [], slither: true }));
    assert.match(prep.env.CHAIN_BRIEF, /NOTE: Slither did NOT run \(image not built/);
    assert.match(prep.env.CHAIN_BRIEF, /does NOT mean the code is clean/);
    assert.equal(prep.record.slither, false);
    assert.match(prep.record.slitherReason, /image not built/);
    assert.ok(!prep.record.top.some((l) => l.check === "uninitialized-state"));
  } finally { cleanupWorkspace(ws); }
});

test("chain prepass without the slither option does not run Slither or add fields", async () => {
  const ws = makeWorkspace(CHAIN_LAB);
  try {
    execFileSync("rm", [join(ws, "src", "ChainWatchLab.sol")]);
    const prep = await withImage("touchstone/slither:does-not-exist", () => chainPrepass(ws, { emit: () => {} }, { mode: "chain-watch", analyze: () => [] }));
    assert.doesNotMatch(prep.env.CHAIN_BRIEF, /Slither/);
    assert.equal("slither" in prep.record, false);
  } finally { cleanupWorkspace(ws); }
});

// ---- the lead is a real bug: the reference exploit proves funds harm

const hasFoundry = imageExists("ghcr.io/foundry-rs/foundry:latest");

test("chain-watch lab: the Slither lead proves with funds harm through the forge oracle", { skip: !hasFoundry && "foundry image not pulled", timeout: 600_000 }, async () => {
  const ws = makeWorkspace(CHAIN_LAB);
  try {
    const source = readFileSync(join(CHAIN_LAB, "oracle", "ReinitVaultTest.t.sol"), "utf8");
    writePoc(ws, source);
    const run = await forgeTest(ws, { matchContract: "ReinitVaultTest" });
    assert.ok(run.passed && !run.failed, run.output);
    const found = [{ n: 1, title: "Vault can be re-initialized", severity: "critical", poc: "ReinitVaultTest", explanation: "x", source }];
    const [proved] = await chainWatch.prove(ws, found, [{ ev: "run_poc-done", passed: true, contract: "ReinitVaultTest" }], () => {});
    assert.equal(proved.proof.status, "pass", JSON.stringify(proved.proof));
    assert.equal(proved.proof.harm.kind, "funds");
  } finally { cleanupWorkspace(ws); }
});

// ---- keys: the same adapter on the keys lab


const KEYS_LAB = new URL("../packs/keys/lab", import.meta.url).pathname;

test("keys lab: Slither flags the never-set `required` quorum and leaves the workspace clean", { skip: !hasImage && "image not built", timeout: 300_000 }, async () => {
  const ws = makeWorkspace(KEYS_LAB);
  try {
    const before = tree(ws);
    const scan = await slitherLeads(ws);
    assert.equal(scan.available, true, scan.reason);
    const lead = scan.leads.find((l) => l.check === "uninitialized-state");
    assert.ok(lead, JSON.stringify(scan.leads.map((l) => l.check)));
    assert.equal(lead.impact, "High");
    assert.match(lead.where, /^CosignVault\.required \(src\/CosignVault\.sol:\d+\)$/);
    assert.deepEqual(tree(ws), before, "the scan must not write into the workspace");
  } finally { cleanupWorkspace(ws); }
});

test("keys lab: Slither finds the zero quorum that the Safe checks, source checks and Aderyn miss", { skip: (!hasImage || !hasAderyn) && "image not built", timeout: 300_000 }, async () => {
  const ws = makeWorkspace(KEYS_LAB);
  try {
    // Aderyn does flag CosignVault.sol, but only `eth-send-unchecked-address` on the payout call.
    // Nothing but Slither names the root cause: `required` is never set.
    const onQuorum = (l) => l.check === "uninitialized-state" || /\brequired\b/.test(`${l.where} ${l.description ?? ""}`);
    assert.deepEqual(sourceLeads(ws).filter(onQuorum), []);
    const aderyn = await aderynLeads(ws);
    assert.equal(aderyn.available, true, aderyn.reason);
    assert.deepEqual(aderyn.leads.filter(onQuorum), []);
    const slither = await slitherLeads(ws);
    assert.ok(slither.leads.some((l) => onQuorum(l) && /CosignVault/.test(l.where)));
  } finally { cleanupWorkspace(ws); }
});

test("keys prepass in source mode puts the Slither lead in the brief and the record", { skip: !hasImage && "image not built", timeout: 300_000 }, async () => {
  const ws = makeWorkspace(KEYS_LAB);
  try {
    execFileSync("rm", [join(ws, "src", "KeysLab.sol")]);
    const prep = await keys.prepass(ws, { emit: () => {} });
    assert.equal(prep.record.source, true);
    assert.equal(prep.record.slither, true);
    assert.match(prep.env.CHAIN_BRIEF, /uninitialized-state at CosignVault\.required/);
  } finally { cleanupWorkspace(ws); }
});

test("keys prepass in lab mode (Anvil world) shows the Slither lead in the brief", { skip: (!hasImage || !hasTools) && "image not built", timeout: 600_000 }, async () => {
  const ws = makeWorkspace(KEYS_LAB);
  try {
    const prep = await keys.prepass(ws, { emit: () => {} });
    assert.equal(prep.record.source, false, "the lab world ran");
    assert.equal(prep.record.slither, true);
    assert.match(prep.env.CHAIN_BRIEF, /\[High\] uninitialized-state at CosignVault\.required .* seen only by Slither/);
  } finally { cleanupWorkspace(ws); }
});

test("keys lab: the Slither lead proves with funds harm through the forge oracle", { skip: !hasFoundry && "foundry image not pulled", timeout: 600_000 }, async () => {
  const ws = makeWorkspace(KEYS_LAB);
  try {
    const source = readFileSync(join(KEYS_LAB, "oracle", "CosignVaultTest.t.sol"), "utf8");
    writePoc(ws, source);
    const run = await forgeTest(ws, { matchContract: "CosignVaultTest" });
    assert.ok(run.passed && !run.failed, run.output);
    const found = [{ n: 1, title: "One owner pays out alone", severity: "critical", poc: "CosignVaultTest", explanation: "x", source }];
    const [proved] = await keys.prove(ws, found, [{ ev: "run_poc-done", passed: true, contract: "CosignVaultTest" }], () => {});
    assert.equal(proved.proof.status, "pass", JSON.stringify(proved.proof));
    assert.equal(proved.proof.harm.kind, "funds");
  } finally { cleanupWorkspace(ws); }
});
