// Halmos runs in Docker. The real-run tests need the image
// (spike/packs/contracts/images/build.sh halmos) and skip when it is not built.
// The lab is lab/vault-shares: its withdraw rounds the shares it burns down.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { halmosBrief, halmosRecord, halmosScan, parseHalmos, symbolicSuites } from "../packs/contracts/halmos.mjs";
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

test("Halmos reports unavailable on a timeout and leaves no container, running or created", { skip: !hasHalmos && "image not built" }, async () => {
  const ws = makeWorkspace(LAB);
  try {
    // 6s: the in-container kill (1s) ends Halmos before the client limit.
    const t0 = Date.now();
    const scan = await halmosScan(ws, { timeoutMs: 6000 });
    assert.ok(Date.now() - t0 < 6000 + 35_000, `took ${Date.now() - t0} ms`);
    assert.equal(scan.available, false);
    assert.match(scan.reason, /timed out|killed after at most 1s \(time limit or out of memory\)/);
    assert.deepEqual(scan.leads, []);
    assert.equal(scan.gaps.length, 1);
    let left = "";
    for (let i = 0; i < 10; i++) {
      left = execFileSync("docker", ["ps", "-a", "--format", "{{.ID}} {{.Status}}", "--filter", "ancestor=touchstone/halmos:0.3.3", "--filter", `volume=${ws}`]).toString().trim();
      if (!left) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.equal(left, "");
  } finally { await cleanupWorkspace(ws); }
});

// The docker client hits its limit before the in-container kill. runTool must
// report timedOut and leave no container, not even one in state "Created"
// (the shared fix 44ba808, 135a436, 93dd481 on main).
// At timeoutMs 1000 the scan's own in-container kill is 1 s, so the container
// ends by itself and the test cannot see runTool's rm -f. A wrapper raises
// only that kill to 60 s. The real runTool still runs, so only its rm -f can
// stop the container near the limit. Halmos ends the lab in about 5.5 s on
// its own, so the time bound is 4 s.
test("a client-side timeout reports timedOut, returns near the limit and leaves no container", { skip: !hasHalmos && "image not built" }, async () => {
  const wrap = await import("../lib/wrap.mjs");
  const real = { ...wrap };
  let lifted = 0;
  const lift = (s) => s.replace(/timeout -s KILL \d+ /g, () => { lifted++; return "timeout -s KILL 60 "; });
  mock.module("../lib/wrap.mjs", { exports: { ...real, runTool: (o) => real.runTool({ ...o, cmd: o.cmd.map(lift) }) } });
  const ws = makeWorkspace(LAB);
  try {
    const { halmosScan } = await import("../packs/contracts/halmos.mjs?clienttimeout");
    const t0 = Date.now();
    const scan = await halmosScan(ws, { timeoutMs: 1000 });
    assert.equal(lifted, 1, "the in-container kill was not raised");
    assert.ok(Date.now() - t0 < 4_000, `took ${Date.now() - t0} ms`);
    assert.equal(scan.available, false);
    assert.equal(scan.timedOut, true);
    assert.equal(scan.reason, "timed out after 1s");
    assert.deepEqual(scan.leads, []);
    // The daemon can create the container after the client is gone, so wait
    // before the first look.
    await new Promise((r) => setTimeout(r, 5000));
    let left = "";
    for (let i = 0; i < 10; i++) {
      left = execFileSync("docker", ["ps", "-a", "--format", "{{.ID}} {{.Status}}", "--filter", "ancestor=touchstone/halmos:0.3.3", "--filter", `volume=${ws}`]).toString().trim();
      if (!left) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.equal(left, "");
  } finally {
    // Remove only what this test left on its own workspace.
    mock.reset();
    const mine = execFileSync("docker", ["ps", "-aq", "--filter", "ancestor=touchstone/halmos:0.3.3", "--filter", `volume=${ws}`]).toString().trim().split("\n").filter(Boolean);
    if (mine.length) execFileSync("docker", ["rm", "-f", ...mine], { stdio: "ignore" });
    await cleanupWorkspace(ws);
  }
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

test("parseHalmos throws on output that is not a Halmos report, and on a report with no tests", () => {
  assert.throws(() => parseHalmos("Error: compilation failed"));
  assert.throws(() => parseHalmos(""));
  assert.throws(() => parseHalmos({ exitcode: 1 }));
  assert.throws(() => parseHalmos({ exitcode: 0, test_results: null }));
  assert.throws(() => parseHalmos({ exitcode: 0, test_results: [] }));
  assert.throws(() => parseHalmos({ exitcode: 0, test_results: {} }), /no test results/);
});

// A fake docker on PATH. It records its argv, prints SHIM_OUT on stdout and
// exits with SHIM_CODE. runTool finds docker through PATH, so halmosScan runs
// unchanged against it.
async function withShim({ out = "", err = "", code = 0, edit = null }, fn) {
  const dir = mkdtempSync(join(tmpdir(), "halmos-shim-"));
  const path = process.env.PATH;
  writeFileSync(join(dir, "out"), out);
  writeFileSync(join(dir, "err"), err);
  writeFileSync(join(dir, "docker"), `#!/bin/sh\nprintf "%s\\n" "$@" > "${dir}/args"\ncat "${dir}/out"\ncat "${dir}/err" >&2\nexit ${code}\n`, { mode: 0o755 });
  const ws = makeWorkspace(LAB);
  if (edit) edit(ws);
  process.env.PATH = `${dir}:${path}`;
  try {
    const scan = await halmosScan(ws, { timeoutMs: 20_000 });
    return await fn(scan, readFileSync(join(dir, "args"), "utf8").trim().split("\n"));
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
    await cleanupWorkspace(ws);
  }
}

test("the Halmos argv is pinned: --pull=never, --network none, the exact image, only check_ functions", async () => {
  await withShim({ out: JSON.stringify(REPORT) }, (scan, args) => {
    assert.equal(scan.available, true);
    assert.deepEqual(args.slice(0, 3), ["run", "--rm", "--pull=never"]);
    assert.equal(args[args.indexOf("--network") + 1], "none");
    assert.equal(args.filter((a) => a === "--network").length, 1);
    const img = args.indexOf("touchstone/halmos:0.3.3");
    assert.ok(img > 0, args.join(" "));
    assert.deepEqual(args.slice(img + 1, img + 3), ["sh", "-c"]);
    assert.match(args[img + 3], /halmos --function check_ --json-output/);
  });
});

test("a valid report from a run that exited non-zero is unavailable, with no lead", async () => {
  for (const code of [1, 125]) {
    await withShim({ out: JSON.stringify(REPORT), code }, (scan) => {
      assert.equal(scan.available, false);
      assert.equal(scan.reason, `the Halmos container exited with code ${code}`);
      assert.deepEqual(scan.leads, []);
      assert.deepEqual(scan.gaps.map((g) => g.suite), [SUITE]);
      assert.equal(halmosRecord(scan).status, "unavailable");
    });
  }
});

test("a report for a suite this workspace does not have is dropped, and the listed suite becomes a gap", async () => {
  const foreign = { exitcode: 1, test_results: { "test/Other.t.sol:SomeOtherTarget": REPORT.test_results[`${SUITE}:ShareVaultSymbolicTest`] } };
  await withShim({ out: JSON.stringify(foreign) }, (scan) => {
    assert.deepEqual(scan.leads, []);
    assert.deepEqual(scan.results, []);
    assert.deepEqual(scan.dropped, ["test/Other.t.sol"]);
    assert.deepEqual(scan.gaps, [{ suite: SUITE, reason: "Halmos reported no result for this suite" }]);
    const rec = halmosRecord(scan);
    assert.equal(rec.status, "unavailable");
    assert.equal(rec.reason, "1 of 1 check unchecked (Halmos reported no result for this suite)");
    assert.deepEqual(prepassView({ static: { tool: "Slither", engines: [], suspects: 0, top: [] }, symbolic: rec }).tools.find((t) => t.name === "Halmos").status, "unavailable");
  });
});

test("a declared check_ function with no result is a gap, and the run view says so", async () => {
  const key = `${SUITE}:ShareVaultSymbolicTest`;
  // The report has only the first of the suite's two check_ functions.
  const one = { exitcode: 0, test_results: { [key]: [REPORT.test_results[key][0]] } };
  await withShim({ out: JSON.stringify(one) }, (scan) => {
    assert.equal(scan.available, true);
    assert.deepEqual(scan.leads, []);
    assert.deepEqual(scan.gaps, [{ suite: SUITE, name: "check_withdrawBurnsAtLeastValue", reason: "Halmos reported no result for this check_ function" }]);
    assert.equal(scan.reason, "1 of 2 checks unchecked (Halmos reported no result for this check_ function)");
    const view = prepassView({ static: { tool: "Slither", engines: [], suspects: 0, top: [] }, symbolic: halmosRecord(scan) }).tools.find((t) => t.name === "Halmos");
    assert.deepEqual(view, { name: "Halmos", status: "ran", reason: scan.reason, leads: 0 });
  });
});

// Halmos runs only ABI functions in the code. A check_ in a comment, or an
// internal or private helper named check_, is not a check it can report.
test("a commented-out or internal check_ function is not a gap, and a file with only those is not a suite", async () => {
  const extra = [
    "  // function check_oldLine(uint256 a) public {}",
    "  /* function check_oldBlock(uint256 a) public {} */",
    "  function check_helper(uint256 a) internal pure returns (bool) { return a > 0; }",
    "  function check_secret(uint256 a) private pure returns (bool) { return a > 0; }",
  ].join("\n");
  const edit = (ws) => {
    const f = join(ws, SUITE);
    const src = readFileSync(f, "utf8");
    const end = src.lastIndexOf("}");
    writeFileSync(f, `${src.slice(0, end)}${extra}\n${src.slice(end)}`);
    writeFileSync(join(ws, "test/halmos/Old.t.sol"), "// function check_gone(uint256 a) public {}\n/*\nfunction check_alsoGone() external {}\n*/\ncontract Old {}\n");
    assert.deepEqual(symbolicSuites(ws), [SUITE]);
  };
  await withShim({ out: JSON.stringify(REPORT), edit }, (scan) => {
    assert.equal(scan.available, true);
    assert.deepEqual(scan.suites, [SUITE]);
    assert.deepEqual(scan.gaps, []);
    assert.equal(scan.leads.length, 1);
    const view = prepassView({ static: { tool: "Slither", engines: [], suspects: 0, top: [] }, symbolic: halmosRecord(scan) }).tools.find((t) => t.name === "Halmos");
    assert.deepEqual(view, { name: "Halmos", status: "ran", reason: null, leads: 1 });
  });
});

test("an empty report is unavailable, not clean", async () => {
  await withShim({ out: JSON.stringify({ exitcode: 0, test_results: {} }) }, (scan) => {
    assert.equal(scan.available, false);
    assert.match(scan.reason, /could not be read \(the report has no test results\)/);
    assert.deepEqual(scan.leads, []);
  });
});

test("when every check is a gap the run view shows unavailable with a reason; a partial gap shows ran with a reason", async () => {
  const key = `${SUITE}:ShareVaultSymbolicTest`;
  const slow = { exitcode: 2, test_results: { [key]: [{ name: "check_depositMintsAtMostValue(uint256)", exitcode: 2, models: [] }, { name: "check_withdrawBurnsAtLeastValue(uint256)", exitcode: 2, models: [] }] } };
  await withShim({ out: JSON.stringify(slow) }, (scan) => {
    const rec = halmosRecord(scan);
    assert.equal(rec.status, "unavailable");
    assert.equal(rec.reason, "2 of 2 checks unchecked (solver timed out; the property is unchecked)");
    assert.deepEqual(prepassView({ static: { tool: "Slither", engines: [], suspects: 0, top: [] }, symbolic: rec }).tools.find((t) => t.name === "Halmos"), { name: "Halmos", status: "unavailable", reason: rec.reason, leads: 0 });
  });
  const partial = { exitcode: 2, test_results: { [key]: [REPORT.test_results[key][0], { name: "check_withdrawBurnsAtLeastValue(uint256)", exitcode: 2, models: [] }] } };
  await withShim({ out: JSON.stringify(partial) }, (scan) => {
    const view = prepassView({ static: { tool: "Slither", engines: [], suspects: 0, top: [] }, symbolic: halmosRecord(scan) }).tools.find((t) => t.name === "Halmos");
    assert.deepEqual(view, { name: "Halmos", status: "ran", reason: "1 of 2 checks unchecked (solver timed out; the property is unchecked)", leads: 0 });
  });
  // A setUp that reverts: Halmos reports an empty list for the suite.
  await withShim({ out: JSON.stringify({ exitcode: 1, test_results: { [key]: [] } }) }, (scan) => {
    const rec = halmosRecord(scan);
    assert.equal(rec.status, "unavailable");
    assert.match(rec.reason, /^1 of 1 check unchecked \(no check_ function ran/);
  });
});

test("the vacuity gate call site fails closed until the gate is merged", async () => {
  const t = await suiteTrust("/tmp", { tool: "Halmos", suite: SUITE });
  assert.equal(t.trusted, false);
  assert.equal(t.gate, "vacuity");
  assert.match(t.reason, /vacuity gate not merged.*lead only.*cannot support a proof/);
});
