// Mythril on a deployed-bytecode-only Contracts target.
//
//   node --experimental-test-module-mocks --test spike/test/contracts-mythril.test.mjs
//
// The pure tests build Mythril reports and workspaces by hand: unit discovery,
// the jsonv2 parser, fail-closed behaviour, and the agent tool. They always run.
// The Docker tests run the real image against lab/vault-bytecode and skip when
// the image is not built. The forge test proves the oracle exploit through the
// harm gate and skips when the Foundry image is not built.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytecodeUnits } from "../packs/contracts/bytecode/units.mjs";
import { parseMythril, mythrilScan, MYTHRIL_IMAGE } from "../packs/contracts/bytecode/mythril.mjs";
import { bytecodePrepass, bytecodeFindingsTool } from "../packs/contracts/bytecode/index.mjs";
import { prepassView } from "../lib/prepass-view.mjs";
import { makeWorkspace, cleanupWorkspace } from "../lib/sandbox.mjs";
import { proveFindings } from "../lib/record.mjs";
import { isProven } from "../lib/proof-view.mjs";

const LAB = new URL("../../lab/vault-bytecode", import.meta.url).pathname;

const hasMythril = (() => {
  try { execFileSync("docker", ["image", "inspect", MYTHRIL_IMAGE], { stdio: "ignore" }); return true; } catch { return false; }
})();
const hasForge = (() => {
  try { execFileSync("docker", ["image", "inspect", "ghcr.io/foundry-rs/foundry:latest"], { stdio: "ignore" }); return true; } catch { return false; }
})();

const tmps = [];
const mkdir = () => { const d = mkdtempSync(join(tmpdir(), "myth-")); tmps.push(d); mkdirSync(join(d, "src")); return d; };
after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const UNIT = { name: "BytecodeVault", file: "src/BytecodeVault.runtime.hex", bytes: 1504 };

// A minimal good jsonv2 report: one loaded unit, one SWC-105 issue at a CALL.
const goodReport = (over = {}) => JSON.stringify([{
  sourceType: "raw-bytecode", sourceFormat: "evm-byzantium-bytecode", sourceList: ["<stdin>"],
  meta: { mythril_execution_info: { analysis_duration: 40e9 } },
  issues: [{
    swcID: "SWC-105", swcTitle: "Unprotected Ether Withdrawal", severity: "High",
    description: { head: "Any sender can withdraw Ether.", tail: "No access control on the call." },
    locations: [{ sourceMap: "369:1:0" }],
    extra: { testCases: [{ steps: [{ name: "withdraw(uint256)", input: "0x2e1a7d4d" }, { name: "sweep(address)", input: "0x01681a62" }] }] },
  }],
  ...over,
}]);

// ---- unit discovery ---------------------------------------------------------

test("bytecodeUnits accepts a sane hex file and reports bad ones as skipped", () => {
  const ws = mkdir();
  writeFileSync(join(ws, "src/Good.runtime.hex"), "0x6080604052\n");
  mkdirSync(join(ws, "src/nested"));
  writeFileSync(join(ws, "src/nested/Deep.runtime.hex"), "abcd");
  writeFileSync(join(ws, "src/Odd.runtime.hex"), "abc");          // odd length
  writeFileSync(join(ws, "src/NotHex.runtime.hex"), "zz zz");     // not hex
  writeFileSync(join(ws, "src/Ignored.sol"), "contract X {}");    // not a unit
  const { units, skipped } = bytecodeUnits(ws);
  assert.deepEqual(units.map((u) => u.name).sort(), ["Deep", "Good"]);
  assert.equal(units.find((u) => u.name === "Good").bytes, 5);
  assert.deepEqual(skipped.map((s) => s.reason).sort(), ["not plain hex", "not plain hex"]);
});

// ---- the parser -------------------------------------------------------------

test("parseMythril lifts an SWC issue into a lead with pc and call sequence", () => {
  const r = parseMythril(goodReport(), UNIT);
  assert.equal(r.ok, true);
  assert.equal(r.complete, true);
  assert.equal(r.leads.length, 1);
  const l = r.leads[0];
  assert.equal(l.engine, "Mythril");
  assert.equal(l.check, "SWC-105");
  assert.equal(l.impact, "High");
  assert.equal(l.pc, 369);
  assert.equal(l.where, "BytecodeVault.sweep(address)");
  assert.deepEqual(l.sequence, ["withdraw(uint256)", "sweep(address)"]);
  assert.match(l.description, /Any sender can withdraw/);
});

test("parseMythril names a step by its 4-byte selector when Mythril gave no name", () => {
  const rep = JSON.parse(goodReport());
  rep[0].issues[0].extra.testCases[0].steps = [{ name: "unknown", input: "0x01681a62deadbeef" }];
  const r = parseMythril(JSON.stringify(rep), UNIT);
  assert.deepEqual(r.leads[0].sequence, ["0x01681a62"]);
  assert.equal(r.leads[0].where, "BytecodeVault.0x01681a62");
});

test("parseMythril marks a run that hit the exploration cap as incomplete", () => {
  const r = parseMythril(goodReport({ meta: { mythril_execution_info: { analysis_duration: 90e9 } } }), UNIT);
  assert.equal(r.ok, true);
  assert.equal(r.complete, false);
});

test("parseMythril: a clean report is 'ran, no lead', never a verdict of safe", () => {
  const r = parseMythril(JSON.stringify([{ sourceType: "raw-bytecode", sourceFormat: "evm-byzantium-bytecode", sourceList: ["<stdin>"], issues: [], meta: {} }]), UNIT);
  assert.equal(r.ok, true);
  assert.deepEqual(r.leads, []);
});

test("parseMythril fails closed on a load error, unparsable output, and a wrong shape", () => {
  // Bad hex: Mythril still prints issues:[] and puts the error only in meta.logs.
  const loadError = JSON.stringify([{ sourceType: "", sourceFormat: "", sourceList: [], issues: [], meta: { logs: [{ level: "error", msg: "could not decode" }] } }]);
  assert.equal(parseMythril(loadError, UNIT).ok, false);
  assert.match(parseMythril(loadError, UNIT).reason, /logged an error/);
  assert.equal(parseMythril("not json", UNIT).ok, false);
  assert.equal(parseMythril("[]", UNIT).ok, false);
  assert.equal(parseMythril("{}", UNIT).ok, false);
  assert.equal(parseMythril(JSON.stringify([{ issues: "no", meta: {} }]), UNIT).ok, false);
  // No error log, but the code never loaded (sourceType is not raw-bytecode).
  assert.match(parseMythril(JSON.stringify([{ sourceType: "", issues: [], meta: {} }]), UNIT).reason, /did not load/);
});

// ---- mythrilScan fail-closed (no Docker: runTool is injected) ----------------

const fakeRun = (res) => async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, ...res });

test("mythrilScan reports unavailable (never clean) on timeout, missing image, error and junk", async () => {
  const units = [UNIT];
  const timeout = await mythrilScan("/tmp", units, { run: fakeRun({ timedOut: true }) });
  assert.equal(timeout.available, false);
  assert.match(timeout.reason, /timed out/);

  const noImage = await mythrilScan("/tmp", units, { run: fakeRun({ stderr: "Unable to find image 'touchstone/mythril:0.24.8' locally" }) });
  assert.equal(noImage.available, false);
  assert.match(noImage.reason, /not built/);

  const junk = await mythrilScan("/tmp", units, { run: fakeRun({ stdout: "boom" }) });
  assert.equal(junk.available, false);

  const loadError = await mythrilScan("/tmp", units, { run: fakeRun({ stdout: JSON.stringify([{ sourceType: "", issues: [], meta: { logs: [{ level: "error" }] } }]) }) });
  assert.equal(loadError.available, false);
  assert.deepEqual(loadError.leads, []);
});

test("mythrilScan reports available with leads when every unit loads", async () => {
  // A report with an issue must come with exit 1 (Mythril's "issues found").
  const scan = await mythrilScan("/tmp", [UNIT], { run: fakeRun({ code: 1, stdout: goodReport() }) });
  assert.equal(scan.available, true);
  assert.equal(scan.reason, null);
  assert.equal(scan.leads.length, 1);
  assert.equal(scan.units[0].status, "ran");
});

// ---- Major 2: a report is bound to this exact bytecode ----------------------

const LAB_HASH = "0x4da44e5d60d8053c9c3a768197624de1489e8cac05e03431d441451f7c5cfd72";

test("parseMythril rejects a report whose sourceList[0] is not this unit's code hash", () => {
  const mine = goodReport({ sourceList: [LAB_HASH] });
  assert.equal(parseMythril(mine, UNIT, { codeHash: LAB_HASH }).ok, true);
  // A clean report for a different contract, handed in as this unit, is rejected.
  const other = JSON.stringify([{ sourceType: "raw-bytecode", sourceList: ["0x" + "11".repeat(32)], issues: [], meta: {} }]);
  const r = parseMythril(other, UNIT, { codeHash: LAB_HASH });
  assert.equal(r.ok, false);
  assert.match(r.reason, /other code/);
});

test("mythrilScan drops a report for other code (hash mismatch) as unavailable", async () => {
  const ws = mkdir();
  writeFileSync(join(ws, "src/BytecodeVault.runtime.hex"), readFileSync(join(LAB, "src/BytecodeVault.runtime.hex")));
  const foreign = JSON.stringify([{ sourceType: "raw-bytecode", sourceList: ["0x" + "22".repeat(32)], issues: [], meta: {} }]);
  const scan = await mythrilScan(ws, [UNIT], { run: fakeRun({ code: 0, stdout: foreign }) });
  assert.equal(scan.available, false);
  assert.match(scan.reason, /other code/);
  assert.deepEqual(scan.leads, []);
});

// ---- Major 3: only documented (exit code, issue count) pairs are trusted -----

test("mythrilScan trusts only exit 0 with no issue and exit 1 with an issue", async () => {
  const ws = mkdir();
  writeFileSync(join(ws, "src/BytecodeVault.runtime.hex"), readFileSync(join(LAB, "src/BytecodeVault.runtime.hex")));
  const clean = JSON.stringify([{ sourceType: "raw-bytecode", sourceList: [LAB_HASH], issues: [], meta: {} }]);
  const dirty = goodReport({ sourceList: [LAB_HASH] });

  assert.equal((await mythrilScan(ws, [UNIT], { run: fakeRun({ code: 0, stdout: clean }) })).available, true);
  assert.equal((await mythrilScan(ws, [UNIT], { run: fakeRun({ code: 1, stdout: dirty }) })).available, true);

  // A killed run (137) that still printed a clean-looking report is not trusted.
  const killed = await mythrilScan(ws, [UNIT], { run: fakeRun({ code: 137, stdout: clean }) });
  assert.equal(killed.available, false);
  assert.match(killed.reason, /unexpected exit 137/);
  // Exit 0 but the report carries issues, or exit 1 but none: both are rejected.
  assert.equal((await mythrilScan(ws, [UNIT], { run: fakeRun({ code: 0, stdout: dirty }) })).available, false);
  assert.equal((await mythrilScan(ws, [UNIT], { run: fakeRun({ code: 1, stdout: clean }) })).available, false);
});

// ---- Minor 1: the Mythril argv is pinned, and never bridges the network ------

test("mythrilScan runs the pinned image offline and passes no network flag", async () => {
  let seen = null;
  const run = async (opts) => { seen = opts; return { code: 1, stdout: goodReport({ sourceList: [LAB_HASH] }), stderr: "", timedOut: false }; };
  const ws = mkdir();
  writeFileSync(join(ws, "src/BytecodeVault.runtime.hex"), readFileSync(join(LAB, "src/BytecodeVault.runtime.hex")));
  await mythrilScan(ws, [UNIT], { run });
  assert.equal(seen.image, MYTHRIL_IMAGE);
  assert.ok(!("network" in seen), "runTool defaults to --network none; the call must not override it (no bridge)");
  assert.deepEqual(seen.cmd.slice(0, 2), ["analyze", "-f"]);
  assert.ok(seen.cmd.includes("--bin-runtime") && seen.cmd.includes("jsonv2"));
});

// ---- Minor 2: a downstream re-report of the same drain is folded away --------

test("parseMythril keeps the first SWC-105 and drops its downstream re-report", () => {
  const rep = JSON.parse(goodReport());
  // First lead: sweep at pc 369, sequence [sweep]. Re-report: withdraw at pc 658,
  // sequence [sweep, withdraw] — the same drain seen at a later CALL.
  rep[0].issues = [
    { swcID: "SWC-105", severity: "High", description: { head: "a", tail: "" }, locations: [{ sourceMap: "369:1:0" }], extra: { testCases: [{ steps: [{ name: "sweep(address)", input: "0x01681a62" }] }] } },
    { swcID: "SWC-105", severity: "High", description: { head: "b", tail: "" }, locations: [{ sourceMap: "658:1:0" }], extra: { testCases: [{ steps: [{ name: "sweep(address)", input: "0x01681a62" }, { name: "withdraw(uint256)", input: "0x2e1a7d4d" }] }] } },
  ];
  const r = parseMythril(JSON.stringify(rep), UNIT);
  assert.equal(r.leads.length, 1);
  assert.equal(r.leads[0].where, "BytecodeVault.sweep(address)");
  assert.equal(r.leads[0].pc, 369);
});

// ---- the prepass and the agent tool -----------------------------------------

test("bytecodePrepass builds the env, record and run-view for a bytecode lab", async () => {
  const ws = mkdir();
  writeFileSync(join(ws, "src/BytecodeVault.runtime.hex"), readFileSync(join(LAB, "src/BytecodeVault.runtime.hex")));
  const scan = async () => ({ tool: "Mythril", available: true, reason: null, units: [{ name: "BytecodeVault", file: "src/BytecodeVault.runtime.hex", status: "ran", complete: true, leads: [parseMythril(goodReport(), UNIT).leads[0]] }], leads: [parseMythril(goodReport(), UNIT).leads[0]] });
  const { env, record } = await bytecodePrepass(ws, { scan });
  assert.match(env.BYTECODE_BRIEF, /sweep\(address\)/);
  assert.match(env.BYTECODE_BRIEF, /source is not available/);
  assert.equal(record.mythril.status, "ran");
  assert.equal(record.mythril.suspects, 1);
  // The run view folds the mythril key into a tool and a worst-first lead.
  const view = prepassView(record);
  assert.ok(view.tools.some((t) => t.name === "Mythril" && t.status === "ran"));
  assert.equal(view.leads[0].check, "SWC-105");
});

test("bytecodePrepass surfaces an unavailable tool as a gap, not a clean pass", async () => {
  const ws = mkdir();
  writeFileSync(join(ws, "src/BytecodeVault.runtime.hex"), "6080");
  const scan = async () => ({ tool: "Mythril", available: false, reason: "BytecodeVault: image not built", units: [{ name: "BytecodeVault", file: "src/BytecodeVault.runtime.hex", status: "unavailable", reason: "image not built", leads: [] }], leads: [] });
  const { env, record } = await bytecodePrepass(ws, { scan });
  assert.equal(record.mythril.status, "unavailable");
  assert.match(env.BYTECODE_BRIEF, /unavailable/);
  assert.match(env.BYTECODE_BRIEF, /gap, not a clean result/);
  assert.equal(prepassView(record).tools.find((t) => t.name === "Mythril").status, "unavailable");
});

test("bytecodePrepass does nothing when the target has no bytecode unit", async () => {
  const ws = mkdir();
  const out = await bytecodePrepass(ws, { scan: async () => { throw new Error("should not run"); } });
  assert.deepEqual(out, { env: {}, record: {} });
});

test("bytecode_findings renders the leads to the agent, and a gap when unavailable", async () => {
  const tool = bytecodeFindingsTool();
  process.env.BYTECODE_JSON = JSON.stringify({ units: [{ file: "src/BytecodeVault.runtime.hex", bytes: 1504 }], tools: [{ tool: "Mythril", status: "ran", suspects: 1 }], leads: [parseMythril(goodReport(), UNIT).leads[0]] });
  try {
    const ran = await tool.execute({});
    assert.match(ran.output[0].text, /sweep\(address\)/);
    assert.match(ran.output[0].text, /pc 369/);
    process.env.BYTECODE_JSON = JSON.stringify({ units: [], tools: [{ tool: "Mythril", status: "unavailable", reason: "image not built" }], leads: [] });
    const gap = await tool.execute({});
    assert.match(gap.output[0].text, /gap, not a clean result/);
  } finally { delete process.env.BYTECODE_JSON; }
});

// ---- real Docker run --------------------------------------------------------

test("Mythril finds the unprotected withdrawal on the bytecode lab and leaves the workspace clean", { skip: !hasMythril && "mythril image not built", timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB);
  try {
    const before = readdirSync(ws).sort();
    const { units } = bytecodeUnits(ws);
    assert.equal(units.length, 1);
    const scan = await mythrilScan(ws, units);
    assert.equal(scan.available, true, scan.reason ?? "");
    const sweep = scan.leads.find((l) => l.where === "BytecodeVault.sweep(address)");
    assert.ok(sweep, "Mythril should flag sweep(address)");
    assert.equal(sweep.check, "SWC-105");
    assert.equal(sweep.impact, "High");
    assert.ok(Number.isInteger(sweep.pc));
    // The downstream withdraw re-report of the same drain is folded away.
    assert.ok(!scan.leads.some((l) => l.where === "BytecodeVault.withdraw(uint256)"), "the withdraw re-report should be dropped");
    assert.deepEqual(readdirSync(ws).sort(), before);
  } finally { await cleanupWorkspace(ws); }
});

test("a runTool timeout gives unavailable with a reason, never a clean scan", async () => {
  // A timeout must fail closed: timedOut:true -> available:false, reason "timed
  // out", no leads. This is the part the tool code owns.
  //
  // Whether the timeout actually STOPS the container (SIGTERM reaches PID 1, no
  // container is left, the call returns near timeoutMs) is a shared runDocker()
  // fault in spike/lib/wrap.mjs, fixed by shared commit 6526bbe (named container
  // + `docker rm -f` on timeout). It is not fixed on this branch and must not be
  // wrapped per-tool, so the "container is gone / returns on time" check belongs
  // with that commit, not here. See the report.
  const scan = await mythrilScan("/tmp", [UNIT], { run: fakeRun({ timedOut: true, code: 137 }) });
  assert.equal(scan.available, false);
  assert.match(scan.reason, /timed out/);
  assert.deepEqual(scan.leads, []);
  assert.equal(scan.units[0].status, "unavailable");
});

test("Mythril reports unavailable, not clean, when the image is missing", async () => {
  process.env.MYTHRIL_IMAGE = "touchstone/mythril:does-not-exist";
  try {
    const mod = await import("../packs/contracts/bytecode/mythril.mjs?missing");
    const scan = await mod.mythrilScan("/tmp", [UNIT], { timeoutMs: 30_000 });
    assert.equal(scan.available, false);
    assert.deepEqual(scan.leads, []);
  } finally { delete process.env.MYTHRIL_IMAGE; }
});

// ---- the lift: Mythril names a function no readable source holds -------------

test("Mythril lifts a fault from bytecode the agent has no source for", { skip: !hasMythril && "mythril image not built", timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB);
  try {
    // Everything the agent can read: the only .sol is the stub, which installs
    // the runtime code and names no vault function.
    const sources = readdirSync(join(ws, "src")).filter((f) => f.endsWith(".sol"));
    assert.deepEqual(sources, ["BytecodeVault.sol"]);
    const stub = readFileSync(join(ws, "src/BytecodeVault.sol"), "utf8");
    assert.ok(!/function\s+sweep|function\s+withdraw/.test(stub), "the readable source names no vault function");
    // Yet Mythril recovers sweep(address) as a High fault from the bytecode.
    const { units } = bytecodeUnits(ws);
    const scan = await mythrilScan(ws, units);
    assert.ok(scan.leads.some((l) => l.where === "BytecodeVault.sweep(address)" && l.impact === "High"));
  } finally { await cleanupWorkspace(ws); }
});

// ---- the proof: the oracle exploit clears the harm gate ----------------------

test("the oracle sweep exploit is proven through the funds channel on the bytecode lab", { skip: !hasForge && "foundry image not built", timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB);
  tmps.push(ws);
  const source = readFileSync(join(LAB, "oracle/BytecodeVaultExploit.t.sol"), "utf8");
  const submitted = [{ title: "Unprotected sweep", severity: "high", poc: "BytecodeVaultExploitTest", explanation: "x", source }];
  const events = [{ ev: "run_poc-done", passed: true, contract: "BytecodeVaultExploitTest" }];
  const [f] = await proveFindings(ws, submitted, events);
  assert.equal(f.proof.harm.ok, true);
  assert.equal(f.proof.harm.kind, "funds");
  assert.ok(BigInt(f.proof.harm.lostWei) > 0n);
  assert.equal(isProven(f), true);
});
