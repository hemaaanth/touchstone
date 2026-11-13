// Halmos runs in Docker. The real-run tests need the image
// (spike/packs/contracts/images/build.sh halmos) and skip when it is not built.
// The lab is lab/vault-shares: its withdraw rounds the shares it burns down.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { halmosBrief, halmosScan, parseHalmos, symbolicSuites } from "../packs/contracts/halmos.mjs";
import { suiteTrust } from "../packs/contracts/suite-trust.mjs";
import { makeWorkspace, cleanupWorkspace } from "../lib/sandbox.mjs";
import { prepassView } from "../lib/prepass-view.mjs";
import contracts from "../packs/contracts/pack.mjs";

const LAB = new URL("../../lab/vault-shares", import.meta.url).pathname;
const SUITE = "test/halmos/ShareVaultSymbolic.t.sol";
const has = (img) => { try { execFileSync("docker", ["image", "inspect", img], { stdio: "ignore" }); return true; } catch { return false; } };
const hasHalmos = has("touchstone/halmos:0.3.3");
const hasStatic = has("touchstone/slither:0.11.6") && has("touchstone/aderyn:0.6.8");

// Every file under dir, with size, so a write anywhere shows up.
function tree(dir) {
  const out = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); const s = statSync(p); if (s.isDirectory()) walk(p); else out.push(`${relative(dir, p)}:${s.size}`); } };
  walk(dir);
  return out.sort();
}

// A real report shape, as Halmos 0.3.3 writes it.
const REPORT = {
  exitcode: 1,
  test_results: {
    [`${SUITE}:ShareVaultSymbolicTest`]: [
      { name: "check_depositMintsAtMostValue(uint256)", exitcode: 0, num_models: 0, models: [], num_paths: [6, 1, 0], time: [4.9, 0.07, 4.8], num_bounded_loops: 0 },
      { name: "check_withdrawBurnsAtLeastValue(uint256)", exitcode: 1, num_models: 1, models: [{ model: { p_assets_uint256_7de3bdd_00: { full_name: "p_assets_uint256_7de3bdd_00", variable_name: "assets", solidity_type: "uint256", smt_type: "BitVec 256", size_bits: 256, value: 1099511627776 } }, is_valid: true }], num_paths: [8, 1, 0], time: [0.7, 0.1, 0.6], num_bounded_loops: 0 },
    ],
  },
};

test("Halmos finds the withdraw rounding bug on the lab through runTool and leaves the workspace clean", { skip: !hasHalmos && "image not built" }, async () => {
  const ws = makeWorkspace(LAB);
  try {
    assert.deepEqual(symbolicSuites(ws), [SUITE]);
    const before = tree(ws);
    const scan = await halmosScan(ws);
    assert.equal(scan.available, true, scan.reason);
    assert.equal(scan.applicable, true);
    assert.deepEqual(scan.gaps, []);
    assert.equal(scan.leads.length, 1);
    const lead = scan.leads[0];
    assert.equal(lead.engine, "Halmos");
    assert.equal(lead.property, "check_withdrawBurnsAtLeastValue(uint256)");
    assert.equal(lead.where, "ShareVaultSymbolicTest.check_withdrawBurnsAtLeastValue");
    assert.equal(lead.validated, true);
    assert.equal(lead.supportsProof, false);
    // The counterexample is a real bug: withdrawing that many assets burns zero
    // shares. setUp leaves 1010e6 shares over 1515e18 assets.
    const assets = BigInt(String(lead.args.assets).split(" ")[0]);
    assert.ok(assets > 0n);
    assert.equal((assets * 1010_000_000n) / 1515_000_000_000_000_000_000n, 0n);
    // The pass is reported, but never as "holds": the suite is not trusted.
    const pass = scan.results.find((r) => r.name === "check_depositMintsAtMostValue(uint256)");
    assert.equal(pass.status, "pass");
    assert.equal(pass.verdict, "unverified");
    assert.equal(scan.trust[SUITE].trusted, false);
    assert.deepEqual(tree(ws), before);
  } finally { await cleanupWorkspace(ws); }
});

test("the contracts prepass now surfaces a withdraw lead that static and fuzz miss on this lab", { skip: (!hasHalmos || !hasStatic) && "images not built" }, async () => {
  const ws = makeWorkspace(LAB);
  try {
    const events = [];
    const { env, record } = await contracts.prepass(ws, { emit: (e) => events.push(e) });
    // Before this wrap: static flags other functions, fuzz has no template.
    assert.ok(!record.static.top.some((l) => /withdraw|redeem/.test(l.where ?? "")), JSON.stringify(record.static.top));
    assert.equal(record.fuzz.applicable, false);
    assert.equal(record.fuzz.suspects, 0);
    // Now: Halmos gives the withdraw counterexample as a lead.
    assert.equal(record.symbolic.suspects, 1);
    assert.equal(record.symbolic.trusted, false);
    assert.equal(record.symbolic.top[0].where, "ShareVaultSymbolicTest.check_withdrawBurnsAtLeastValue");
    assert.ok(events.some((e) => e.ev === "symbolic-scan" && e.suspects === 1));
    assert.match(env.SYMBOLIC_BRIEF, /COUNTEREXAMPLE ShareVaultSymbolicTest\.check_withdrawBurnsAtLeastValue: assets = \d+/);
    assert.match(env.SYMBOLIC_BRIEF, /does NOT show the code is safe/);
    // The agent's first message carries it, and the run view lists Halmos.
    assert.match(contracts.kickoff(ws, env), /SYMBOLIC TESTING \(Halmos\)/);
    const view = prepassView(record);
    const halmos = view.tools.find((t) => t.name === "Halmos");
    assert.deepEqual([halmos.status, halmos.leads], ["ran", 1]);
    assert.ok(view.leads.some((l) => l.check === "symbolic-counterexample"));
  } finally { await cleanupWorkspace(ws); }
});

test("Halmos reports unavailable with a gap per suite, not clean, when the image is missing", async () => {
  process.env.HALMOS_IMAGE = "touchstone/halmos:does-not-exist";
  const ws = makeWorkspace(LAB);
  try {
    const mod = await import("../packs/contracts/halmos.mjs?missing");
    const scan = await mod.halmosScan(ws, { timeoutMs: 20_000 });
    assert.equal(scan.available, false);
    assert.match(scan.reason, /not built/);
    assert.deepEqual(scan.leads, []);
    assert.deepEqual(scan.gaps.map((g) => g.suite), [SUITE]);
    assert.match(halmosBrief(scan), /did not run: .*treat them as a gap, not as passing/);
  } finally { delete process.env.HALMOS_IMAGE; await cleanupWorkspace(ws); }
});

test("Halmos reports unavailable when the image runs but writes no report", { skip: !has("alpine:latest") && "alpine not local" }, async () => {
  // alpine has no halmos binary: the scan runs and produces no JSON.
  process.env.HALMOS_IMAGE = "alpine:latest";
  const ws = makeWorkspace(LAB);
  try {
    const mod = await import("../packs/contracts/halmos.mjs?noreport");
    const scan = await mod.halmosScan(ws, { timeoutMs: 20_000 });
    assert.equal(scan.available, false);
    assert.equal(scan.reason, "Halmos wrote no report");
    assert.deepEqual(scan.leads, []);
    assert.equal(scan.gaps.length, 1);
  } finally { delete process.env.HALMOS_IMAGE; await cleanupWorkspace(ws); }
});

test("Halmos reports unavailable on a timeout and leaves no container running", { skip: !hasHalmos && "image not built" }, async () => {
  const ws = makeWorkspace(LAB);
  try {
    // 6s: the in-container kill (1s) ends Halmos before the client limit.
    const scan = await halmosScan(ws, { timeoutMs: 6000 });
    assert.equal(scan.available, false);
    assert.match(scan.reason, /timed out/);
    assert.deepEqual(scan.leads, []);
    assert.equal(scan.gaps.length, 1);
    let left = "";
    for (let i = 0; i < 10; i++) {
      left = execFileSync("docker", ["ps", "-q", "--filter", "ancestor=touchstone/halmos:0.3.3", "--filter", `volume=${ws}`]).toString().trim();
      if (!left) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.equal(left, "");
  } finally { await cleanupWorkspace(ws); }
});

test("Halmos is not applicable and starts no container when the project has no check_ function", async () => {
  process.env.HALMOS_IMAGE = "touchstone/halmos:does-not-exist";
  const ws = makeWorkspace(new URL("../../lab/vault-reentrancy", import.meta.url).pathname);
  try {
    const mod = await import("../packs/contracts/halmos.mjs?noapply");
    const scan = await mod.halmosScan(ws);
    // A missing image would make it unavailable, so this proves no run happened.
    assert.equal(scan.available, true);
    assert.equal(scan.applicable, false);
    assert.equal(halmosBrief(scan), "");
  } finally { delete process.env.HALMOS_IMAGE; await cleanupWorkspace(ws); }
});

test("parseHalmos reads a counterexample and a pass from a real report", () => {
  const { results, gaps } = parseHalmos(JSON.stringify(REPORT));
  assert.deepEqual(gaps, []);
  assert.deepEqual(results.map((r) => [r.name, r.status]), [
    ["check_depositMintsAtMostValue(uint256)", "pass"],
    ["check_withdrawBurnsAtLeastValue(uint256)", "counterexample"],
  ]);
  assert.equal(results[1].args.assets, "1099511627776 (0x10000000000)");
  assert.equal(results[1].suite, SUITE);
});

test("parseHalmos turns a failed setUp, a solver timeout and an error into gaps", () => {
  const { results, gaps } = parseHalmos({
    exitcode: 1,
    test_results: {
      "test/A.t.sol:SetUpReverts": [],
      "test/B.t.sol:Slow": [
        { name: "check_slow(uint256)", exitcode: 2, models: [] },
        { name: "check_odd(uint256)", exitcode: 1, models: [] },
      ],
    },
  });
  assert.deepEqual(gaps.map((g) => [g.contract, g.name ?? null]), [["SetUpReverts", null], ["Slow", "check_slow(uint256)"], ["Slow", "check_odd(uint256)"]]);
  assert.deepEqual(results.map((r) => r.status), ["timeout", "error"]);
  assert.ok(!results.some((r) => r.status === "pass"));
});

test("parseHalmos throws on output that is not a Halmos report, and a report with no tests is a gap", () => {
  assert.throws(() => parseHalmos("Error: compilation failed"));
  assert.throws(() => parseHalmos({ exitcode: 1 }));
  assert.deepEqual(parseHalmos({ exitcode: 1, test_results: {} }).gaps.map((g) => g.reason), ["Halmos ran no check_ function"]);
});

test("the vacuity gate call site fails closed until the gate is merged", async () => {
  const t = await suiteTrust("/tmp", { tool: "Halmos", suite: SUITE });
  assert.equal(t.trusted, false);
  assert.equal(t.gate, "vacuity");
  assert.match(t.reason, /vacuity gate not merged.*lead only.*cannot support a proof/);
});
