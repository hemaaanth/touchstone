// Heimdall on a deployed-bytecode-only Contracts target.
//
//   node --experimental-test-module-mocks --test spike/test/contracts-heimdall.test.mjs
//
// The pure tests build ABI JSON and inject runTool: the parser, the signature
// render, fail-closed behaviour, and how the pre-pass carries the recovered ABI
// to the agent. They always run. The Docker tests run the real image against
// lab/vault-bytecode and skip when the image is not built.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHeimdallAbi, signatureOf, heimdallScan, HEIMDALL_IMAGE } from "../packs/contracts/bytecode/heimdall.mjs";
import { bytecodePrepass, bytecodeFindingsTool } from "../packs/contracts/bytecode/index.mjs";
import { prepassView } from "../lib/prepass-view.mjs";
import { makeWorkspace, cleanupWorkspace } from "../lib/sandbox.mjs";

const LAB = new URL("../../lab/vault-bytecode", import.meta.url).pathname;

const hasHeimdall = (() => {
  try { execFileSync("docker", ["image", "inspect", HEIMDALL_IMAGE], { stdio: "ignore" }); return true; } catch { return false; }
})();

const tmps = [];
const mkdir = () => { const d = mkdtempSync(join(tmpdir(), "heim-")); tmps.push(d); mkdirSync(join(d, "src")); return d; };
after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const UNIT = { name: "BytecodeVault", file: "src/BytecodeVault.runtime.hex", bytes: 1504 };

// The six functions Heimdall recovers from the lab, named Unresolved_<selector>
// because we run it with --skip-resolving (no online signature lookup).
const goodAbi = (over = []) => JSON.stringify([
  { type: "function", name: "Unresolved_01681a62", inputs: [{ name: "arg0", type: "address" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "Unresolved_01e1d114", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "Unresolved_d0e30db0", inputs: [], outputs: [], stateMutability: "payable" },
  ...over,
]);

// ---- the parser -------------------------------------------------------------

test("parseHeimdallAbi lifts each function with its selector, types and mutability", () => {
  const r = parseHeimdallAbi(goodAbi(), UNIT);
  assert.equal(r.ok, true);
  assert.equal(r.functions.length, 3);
  const sweep = r.functions.find((f) => f.selector === "0x01681a62");
  assert.deepEqual(sweep.inputs, ["address"]);
  assert.deepEqual(sweep.outputs, []);
  assert.equal(sweep.stateMutability, "nonpayable");
  assert.equal(sweep.resolved, false);
  const total = r.functions.find((f) => f.selector === "0x01e1d114");
  assert.deepEqual(total.outputs, ["uint256"]);
  assert.equal(total.stateMutability, "view");
});

test("parseHeimdallAbi keeps a resolved name and reports it as resolved", () => {
  const r = parseHeimdallAbi(JSON.stringify([{ type: "function", name: "transfer", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" }]), UNIT);
  assert.equal(r.functions[0].resolved, true);
  assert.equal(r.functions[0].name, "transfer");
  assert.equal(r.functions[0].selector, null);
});

test("parseHeimdallAbi fails closed on junk and a non-list", () => {
  assert.equal(parseHeimdallAbi("not json", UNIT).ok, false);
  assert.match(parseHeimdallAbi("not json", UNIT).reason, /unparsable/);
  assert.equal(parseHeimdallAbi("{}", UNIT).ok, false);
  assert.match(parseHeimdallAbi("{}", UNIT).reason, /not a list/);
});

test("parseHeimdallAbi treats an ABI with no function as a gap, not a clean empty result", () => {
  // A valid JSON list that recovers no function: empty, or only non-function
  // entries. Heimdall gave us no interface, so it must fail closed.
  assert.equal(parseHeimdallAbi("[]", UNIT).ok, false);
  assert.match(parseHeimdallAbi("[]", UNIT).reason, /recovered no functions/);
  const eventsOnly = JSON.stringify([{ type: "event", name: "Deposit" }, { type: "constructor" }]);
  assert.equal(parseHeimdallAbi(eventsOnly, UNIT).ok, false);
  assert.match(parseHeimdallAbi(eventsOnly, UNIT).reason, /recovered no functions/);
});

test("signatureOf renders a callable signature with selector and mutability", () => {
  const [sweep] = parseHeimdallAbi(goodAbi(), UNIT).functions;
  assert.equal(signatureOf(sweep), "fn_01681a62(address)  [0x01681a62, nonpayable]");
  const total = parseHeimdallAbi(goodAbi(), UNIT).functions.find((f) => f.selector === "0x01e1d114");
  assert.equal(signatureOf(total), "fn_01e1d114() returns (uint256)  [0x01e1d114, view]");
});

// ---- heimdallScan fail-closed and happy path (no Docker: runTool injected) ---

// A fake runTool. When `abi` is given it writes it to the output dir heimdall
// would, so the scan can read it back; otherwise it writes nothing.
const fakeRun = (res, abi) => async ({ cmd, ws }) => {
  if (abi != null) {
    const i = cmd.indexOf("-o");
    const rel = String(cmd[i + 1]).replace(/^\/work\//, "");
    writeFileSync(join(ws, rel, "unit-abi.json"), abi);
  }
  return { code: 0, stdout: "", stderr: "", timedOut: false, ...res };
};

test("heimdallScan reports unavailable (never empty-clean) on timeout, missing image, bad exit and junk", async () => {
  const ws = mkdir();
  const timeout = await heimdallScan(ws, [UNIT], { run: fakeRun({ timedOut: true }) });
  assert.equal(timeout.available, false);
  assert.match(timeout.reason, /timed out/);

  const noImage = await heimdallScan(ws, [UNIT], { run: fakeRun({ stderr: "Unable to find image 'touchstone/heimdall:0.9.3' locally" }) });
  assert.equal(noImage.available, false);
  assert.match(noImage.reason, /not built/);

  const noFile = await heimdallScan(ws, [UNIT], { run: fakeRun({ code: 1 }) });
  assert.equal(noFile.available, false);
  assert.match(noFile.reason, /wrote no ABI/);

  const junk = await heimdallScan(ws, [UNIT], { run: fakeRun({ code: 0 }, "not json") });
  assert.equal(junk.available, false);
  assert.match(junk.reason, /unparsable/);

  // No scratch dir is left behind in any case.
  assert.deepEqual(readdirSync(ws).filter((f) => f.startsWith(".heimdall")), []);
});

test("heimdallScan returns the recovered functions when the unit decompiles", async () => {
  const ws = mkdir();
  const scan = await heimdallScan(ws, [UNIT], { run: fakeRun({ code: 0 }, goodAbi()) });
  assert.equal(scan.available, true);
  assert.equal(scan.reason, null);
  assert.equal(scan.functions.length, 3);
  assert.ok(scan.functions.every((f) => f.unit === "BytecodeVault"));
  assert.deepEqual(readdirSync(ws).filter((f) => f.startsWith(".heimdall")), []);
});

test("heimdallScan treats a non-zero exit as unavailable even when a good ABI was written", async () => {
  const ws = mkdir();
  const scan = await heimdallScan(ws, [UNIT], { run: fakeRun({ code: 1 }, goodAbi()) });
  assert.equal(scan.available, false);
  assert.match(scan.reason, /exit 1/);
  assert.equal(scan.units[0].status, "unavailable");
  assert.deepEqual(scan.functions, []);
  assert.deepEqual(readdirSync(ws).filter((f) => f.startsWith(".heimdall")), []);
});

test("heimdallScan treats an empty ABI as a gap, not a clean run with zero functions", async () => {
  const ws = mkdir();
  const scan = await heimdallScan(ws, [UNIT], { run: fakeRun({ code: 0 }, "[]") });
  assert.equal(scan.available, false);
  assert.match(scan.reason, /recovered no functions/);
  assert.equal(scan.units[0].status, "unavailable");
  assert.deepEqual(scan.functions, []);
  assert.deepEqual(readdirSync(ws).filter((f) => f.startsWith(".heimdall")), []);
});

test("heimdallScan runs the pinned image offline and passes no network flag", async () => {
  let seen = null;
  const ws = mkdir();
  const run = async (opts) => {
    seen = opts;
    const i = opts.cmd.indexOf("-o");
    writeFileSync(join(ws, String(opts.cmd[i + 1]).replace(/^\/work\//, ""), "unit-abi.json"), goodAbi());
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  await heimdallScan(ws, [UNIT], { run });
  assert.equal(seen.image, HEIMDALL_IMAGE);
  // runTool defaults to --pull=never and --network none; the call must not
  // override the network (no bridge). The mutation network:"bridge" fails here.
  assert.ok(!("network" in seen), "the call must not override --network none");
  assert.equal(seen.cmd[0], "decompile");
  assert.ok(seen.cmd.includes("--skip-resolving"), "offline: --skip-resolving must be passed");
  assert.ok(seen.cmd.includes("--timeout"), "a per-function timeout must be passed");
});

test("a runTool timeout gives unavailable with a reason, never an empty-clean ABI", async () => {
  // The tool code owns the fail-closed mapping: timedOut:true -> available:false,
  // reason "timed out", no functions. Whether the timeout actually STOPS the
  // container is a shared runDocker() fault in spike/lib/wrap.mjs, fixed by shared
  // commit 6526bbe (named container + `docker rm -f`); it is not fixed on this
  // branch and must not be wrapped per-tool, so the "container is gone" check
  // belongs with that commit. See the report.
  const ws = mkdir();
  const scan = await heimdallScan(ws, [UNIT], { run: fakeRun({ timedOut: true, code: 137 }) });
  assert.equal(scan.available, false);
  assert.match(scan.reason, /timed out/);
  assert.equal(scan.units[0].status, "unavailable");
  assert.deepEqual(scan.functions, []);
  assert.deepEqual(readdirSync(ws).filter((f) => f.startsWith(".heimdall")), []);
});

// ---- the pre-pass carries the ABI to the agent ------------------------------

test("bytecodePrepass carries the recovered ABI in the brief, the JSON and the run view", async () => {
  const ws = mkdir();
  writeFileSync(join(ws, "src/BytecodeVault.runtime.hex"), readFileSync(join(LAB, "src/BytecodeVault.runtime.hex")));
  const scan = async () => ({ tool: "Mythril", available: true, reason: null, units: [{ name: "BytecodeVault", file: "src/BytecodeVault.runtime.hex", status: "ran", complete: true, leads: [] }], leads: [] });
  const heimdall = async () => ({ tool: "Heimdall", available: true, reason: null, units: [{ name: "BytecodeVault", file: "src/BytecodeVault.runtime.hex", status: "ran", reason: null, functions: parseHeimdallAbi(goodAbi(), UNIT).functions.map((f) => ({ ...f, unit: "BytecodeVault", file: "src/BytecodeVault.runtime.hex" })), source: "// decompiled" }], functions: parseHeimdallAbi(goodAbi(), UNIT).functions.map((f) => ({ ...f, unit: "BytecodeVault", file: "src/BytecodeVault.runtime.hex" })) });
  const { env, record } = await bytecodePrepass(ws, { scan, heimdall });
  assert.match(env.BYTECODE_BRIEF, /Heimdall decompiled the bytecode and recovered this ABI/);
  assert.match(env.BYTECODE_BRIEF, /0x01681a62/);
  const json = JSON.parse(env.BYTECODE_JSON);
  assert.equal(json.abi.length, 3);
  assert.ok(json.tools.some((t) => t.tool === "Heimdall" && t.status === "ran" && t.recovered === 3));
  assert.equal(record.heimdall.status, "ran");
  assert.equal(record.heimdall.suspects, 0);          // a decompiler contributes no vuln leads
  assert.equal(record.heimdall.recovered, 3);
  // The run view shows Heimdall ran with zero leads (it is not a bug finder).
  const view = prepassView(record);
  const row = view.tools.find((t) => t.name === "Heimdall");
  assert.ok(row && row.status === "ran" && row.leads === 0);
});

test("bytecodePrepass surfaces an unavailable Heimdall as a gap, not a clean ABI", async () => {
  const ws = mkdir();
  writeFileSync(join(ws, "src/BytecodeVault.runtime.hex"), "6080");
  const scan = async () => ({ tool: "Mythril", available: true, reason: null, units: [{ name: "BytecodeVault", file: "src/BytecodeVault.runtime.hex", status: "ran", complete: true, leads: [] }], leads: [] });
  const heimdall = async () => ({ tool: "Heimdall", available: false, reason: "BytecodeVault: image touchstone/heimdall:0.9.3 not built", units: [{ name: "BytecodeVault", file: "src/BytecodeVault.runtime.hex", status: "unavailable", reason: "image not built", functions: [] }], functions: [] });
  const { env, record } = await bytecodePrepass(ws, { scan, heimdall });
  assert.equal(record.heimdall.status, "unavailable");
  assert.match(env.BYTECODE_BRIEF, /Heimdall: unavailable/);
  assert.match(env.BYTECODE_BRIEF, /gap, not a clean result/);
  assert.equal(prepassView(record).tools.find((t) => t.name === "Heimdall").status, "unavailable");
});

test("bytecode_findings renders the recovered ABI for the agent", async () => {
  const tool = bytecodeFindingsTool();
  process.env.BYTECODE_JSON = JSON.stringify({
    units: [{ file: "src/BytecodeVault.runtime.hex", bytes: 1504 }],
    tools: [{ tool: "Heimdall", status: "ran", recovered: 3 }],
    leads: [],
    abi: parseHeimdallAbi(goodAbi(), UNIT).functions.map((f) => ({ ...f, signature: signatureOf(f) })),
  });
  try {
    const out = await tool.execute({});
    assert.match(out.output[0].text, /Heimdall recovered this ABI/);
    assert.match(out.output[0].text, /0x01681a62/);
  } finally { delete process.env.BYTECODE_JSON; }
});

test("bytecode_findings prints Heimdall's recovered-function count, not a lead count", async () => {
  const tool = bytecodeFindingsTool();
  process.env.BYTECODE_JSON = JSON.stringify({
    units: [{ file: "src/BytecodeVault.runtime.hex", bytes: 1504 }],
    tools: [{ tool: "Mythril", status: "ran", suspects: 1 }, { tool: "Heimdall", status: "ran", recovered: 6 }],
    leads: [],
    abi: [],
  });
  try {
    const text = (await tool.execute({})).output[0].text;
    assert.match(text, /Heimdall: ran, 6 function\(s\) recovered\./);
    assert.match(text, /Mythril: ran, 1 lead\(s\)\./);
    assert.ok(!/undefined/.test(text), text);
  } finally { delete process.env.BYTECODE_JSON; }
});

// ---- real Docker run --------------------------------------------------------

const EXPECTED = {
  "0x01681a62": { inputs: ["address"], outputs: [], mut: "nonpayable" },   // sweep(address)
  "0x01e1d114": { inputs: [], outputs: ["uint256"], mut: "view" },         // totalAssets()
  "0x2e1a7d4d": { inputs: ["uint256"], outputs: [], mut: "nonpayable" },   // withdraw(uint256)
  "0x70a08231": { inputs: ["address"], outputs: ["uint256"], mut: "view" }, // balanceOf(address)
  "0x8da5cb5b": { inputs: [], outputs: ["address"], mut: "view" },         // owner()
  "0xd0e30db0": { inputs: [], outputs: [], mut: "payable" },               // deposit()
};

test("Heimdall recovers the full ABI from the bytecode lab and leaves the workspace clean", { skip: !hasHeimdall && "heimdall image not built", timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB);
  try {
    const before = readdirSync(ws).sort();
    const scan = await heimdallScan(ws, [{ name: "BytecodeVault", file: "src/BytecodeVault.runtime.hex", bytes: 1504 }]);
    assert.equal(scan.available, true, scan.reason ?? "");
    const bySel = Object.fromEntries(scan.functions.map((f) => [f.selector, f]));
    assert.deepEqual(Object.keys(bySel).sort(), Object.keys(EXPECTED).sort());
    for (const [sel, want] of Object.entries(EXPECTED)) {
      assert.deepEqual(bySel[sel].inputs, want.inputs, `${sel} inputs`);
      assert.deepEqual(bySel[sel].outputs, want.outputs, `${sel} outputs`);
      assert.equal(bySel[sel].stateMutability, want.mut, `${sel} mutability`);
    }
    assert.deepEqual(readdirSync(ws).sort(), before);   // scratch dir removed
  } finally { await cleanupWorkspace(ws); }
});

test("Heimdall reports unavailable, not an empty ABI, when the image is missing", async () => {
  const ws = mkdir();
  writeFileSync(join(ws, "src/BytecodeVault.runtime.hex"), "6080604052");
  process.env.HEIMDALL_IMAGE = "touchstone/heimdall:does-not-exist";
  try {
    const mod = await import("../packs/contracts/bytecode/heimdall.mjs?missing");
    const scan = await mod.heimdallScan(ws, [{ name: "BytecodeVault", file: "src/BytecodeVault.runtime.hex", bytes: 5 }], { timeoutMs: 30_000 });
    assert.equal(scan.available, false);
    assert.deepEqual(scan.functions, []);
    assert.deepEqual(readdirSync(ws).filter((f) => f.startsWith(".heimdall")), []);
  } finally { delete process.env.HEIMDALL_IMAGE; }
});

// ---- the lift: the full interface, from bytecode the agent has no source for -

test("Heimdall recovers functions the readable source never names and Mythril does not flag", { skip: !hasHeimdall && "heimdall image not built", timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB);
  try {
    // The only readable .sol is the stub; it names no vault function.
    const stub = readFileSync(join(ws, "src/BytecodeVault.sol"), "utf8");
    assert.ok(!/function\s+(sweep|deposit|withdraw|owner|totalAssets|balanceOf)\b/.test(stub));
    const scan = await heimdallScan(ws, [{ name: "BytecodeVault", file: "src/BytecodeVault.runtime.hex", bytes: 1504 }]);
    const sels = new Set(scan.functions.map((f) => f.selector));
    // Mythril's leads point only at the faulting sweep/withdraw path. Heimdall
    // also recovers deposit, owner, totalAssets and balanceOf — the rest of the
    // interface the agent needs to set up and check the exploit.
    for (const sel of ["0xd0e30db0", "0x8da5cb5b", "0x01e1d114", "0x70a08231"]) {
      assert.ok(sels.has(sel), `Heimdall should recover ${sel}`);
    }
  } finally { await cleanupWorkspace(ws); }
});
