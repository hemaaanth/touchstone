// Chimera runs the project's own CryticTester suite under Echidna and Medusa,
// in Docker. The real-run tests need the image
// (spike/packs/contracts/images/build.sh chimera) and skip when it is not built.
// The lab is lab/vault-shares: its redeem takes shares off managedAssets, so
// the vault counts assets it does not hold. Its suite is test/recon/.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { chimeraBrief, chimeraRecord, chimeraScan, chimeraSuites, parseEchidna, parseMedusa } from "../packs/contracts/chimera.mjs";
import { makeWorkspace, cleanupWorkspace } from "../lib/sandbox.mjs";
import { prepassView } from "../lib/prepass-view.mjs";
import contracts from "../packs/contracts/pack.mjs";

const LAB = new URL("../../lab/vault-shares", import.meta.url).pathname;
const SUITE = "test/recon/CryticTester.sol";
const IMAGE = "touchstone/chimera:e2.3.3-m1.5.1";
const has = (img) => { try { execFileSync("docker", ["image", "inspect", img], { stdio: "ignore" }); return true; } catch { return false; } };
const hasChimera = has(IMAGE);
const hasOthers = has("touchstone/halmos:0.3.3") && has("touchstone/slither:0.11.6") && has("touchstone/aderyn:0.6.8");
// Real stdout from both engines on lab/vault-shares, captured with this image.
const fixture = (name) => readFileSync(new URL(`./fixtures/chimera/${name}`, import.meta.url), "utf8");
const ECHIDNA = fixture("echidna-2.3.3-vault-shares.txt");
const MEDUSA = fixture("medusa-1.5.1-vault-shares.txt");

function tree(dir) {
  const out = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); const s = statSync(p); if (s.isDirectory()) walk(p); else out.push(`${relative(dir, p)}:${s.size}`); } };
  walk(dir);
  return out.sort();
}

test("Chimera breaks the lab's solvency property under Echidna and Medusa through runTool and leaves the workspace clean", { skip: !hasChimera && "image not built" }, async () => {
  const ws = makeWorkspace(LAB);
  try {
    assert.deepEqual(chimeraSuites(ws), [SUITE]);
    const before = tree(ws);
    const scan = await chimeraScan(ws);
    assert.equal(scan.available, true, scan.reason);
    assert.equal(scan.applicable, true);
    assert.deepEqual(scan.engines.map((e) => [e.engine, e.status]), [["Echidna", "ran"], ["Medusa", "ran"]]);
    assert.deepEqual(scan.gaps, []);
    assert.equal(scan.leads.length, 1);
    const lead = scan.leads[0];
    assert.equal(lead.engine, "Chimera");
    assert.equal(lead.where, "CryticTester.property_solvent");
    assert.equal(lead.supportsProof, false);
    // Each engine finds it alone, so both should name it. The sequence must
    // reach redeem: that is the bug.
    assert.deepEqual([...lead.engines].sort(), ["Echidna", "Medusa"]);
    assert.ok(lead.sequence.some((c) => c.startsWith("vault_redeem(")), lead.sequence.join(" "));
    // A property that did not break is reported, but never as "holds".
    const supply = scan.results.find((r) => r.name === "property_shareSupply()");
    assert.deepEqual([supply.status, supply.verdict], ["pass", "unverified"]);
    assert.equal(scan.trust[SUITE].trusted, false);
    assert.deepEqual(tree(ws), before);
  } finally { await cleanupWorkspace(ws); }
});

test("the contracts prepass now surfaces a redeem solvency lead that static, fuzz and Halmos miss on this lab", { skip: (!hasChimera || !hasOthers) && "images not built" }, async () => {
  const ws = makeWorkspace(LAB);
  try {
    const events = [];
    const { env, record } = await contracts.prepass(ws, { emit: (e) => events.push(e) });
    // Before this wrap: nothing points at redeem or solvency.
    assert.ok(!record.static.top.some((l) => /redeem|solv/i.test(`${l.where ?? ""} ${l.check ?? ""}`)), JSON.stringify(record.static.top));
    assert.equal(record.fuzz.applicable, false);
    assert.ok(!record.symbolic.top.some((l) => /redeem|solv/i.test(`${l.where} ${l.property}`)), JSON.stringify(record.symbolic.top));
    // Now: Chimera breaks property_solvent with a sequence that redeems.
    assert.equal(record.chimera.suspects, 1);
    assert.equal(record.chimera.trusted, false);
    assert.equal(record.chimera.top[0].where, "CryticTester.property_solvent");
    assert.ok(events.some((e) => e.ev === "chimera-scan" && e.suspects === 1));
    assert.match(env.PROPERTY_BRIEF, /BROKEN CryticTester\.property_solvent \(.+\): .*vault_redeem\(/);
    assert.match(env.PROPERTY_BRIEF, /does NOT show the code is safe/);
    assert.match(contracts.kickoff(ws, env), /PROPERTY SUITE \(Chimera, run with Echidna \+ Medusa\)/);
    const view = prepassView(record);
    const chimera = view.tools.find((t) => t.name === "Chimera");
    assert.deepEqual([chimera.status, chimera.leads], ["ran", 1]);
    assert.ok(view.leads.some((l) => l.check === "chimera-property-broken"));
  } finally { await cleanupWorkspace(ws); }
});

test("Chimera reports unavailable with a gap, not clean, when the image is missing", async () => {
  process.env.CHIMERA_IMAGE = "touchstone/chimera:does-not-exist";
  const ws = makeWorkspace(LAB);
  try {
    const mod = await import("../packs/contracts/chimera.mjs?missing");
    const scan = await mod.chimeraScan(ws, { timeoutMs: 20_000 });
    assert.equal(scan.available, false);
    assert.match(scan.reason, /not built/);
    assert.deepEqual(scan.leads, []);
    assert.deepEqual(scan.gaps.map((g) => g.suite), [SUITE]);
    assert.match(chimeraBrief(scan), /did not run: .*treat them as a gap, not as passing/);
    assert.equal(chimeraRecord(scan).status, "unavailable");
  } finally { delete process.env.CHIMERA_IMAGE; await cleanupWorkspace(ws); }
});

test("Chimera reports unavailable when the image runs but writes no report", { skip: !has("alpine:latest") && "alpine not local" }, async () => {
  // alpine has no echidna or medusa: both runs produce nothing.
  process.env.CHIMERA_IMAGE = "alpine:latest";
  const ws = makeWorkspace(LAB);
  try {
    const mod = await import("../packs/contracts/chimera.mjs?noreport");
    const scan = await mod.chimeraScan(ws, { timeoutMs: 20_000 });
    assert.equal(scan.available, false);
    assert.equal(scan.reason, "Echidna wrote no report; Medusa wrote no report");
    assert.deepEqual(scan.leads, []);
    assert.equal(scan.gaps.length, 1);
  } finally { delete process.env.CHIMERA_IMAGE; await cleanupWorkspace(ws); }
});

test("Chimera reports unavailable on a timeout and leaves no container running", { skip: !hasChimera && "image not built" }, async () => {
  const ws = makeWorkspace(LAB);
  try {
    // 6s: the in-container kill (1s) ends both engines before the client limit.
    const scan = await chimeraScan(ws, { timeoutMs: 6000 });
    assert.equal(scan.available, false);
    assert.match(scan.reason, /Echidna timed out.*Medusa timed out/);
    assert.deepEqual(scan.leads, []);
    assert.equal(scan.gaps.length, 1);
    let left = "";
    for (let i = 0; i < 10; i++) {
      left = execFileSync("docker", ["ps", "-q", "--filter", `ancestor=${IMAGE}`, "--filter", `volume=${ws}`]).toString().trim();
      if (!left) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.equal(left, "");
  } finally { await cleanupWorkspace(ws); }
});

test("Chimera is not applicable and starts no container when the project has no CryticTester", async () => {
  process.env.CHIMERA_IMAGE = "touchstone/chimera:does-not-exist";
  const ws = makeWorkspace(new URL("../../lab/vault-reentrancy", import.meta.url).pathname);
  try {
    const mod = await import("../packs/contracts/chimera.mjs?noapply");
    const scan = await mod.chimeraScan(ws);
    // A missing image would make it unavailable, so this proves no run happened.
    assert.equal(scan.available, true);
    assert.equal(scan.applicable, false);
    assert.equal(chimeraBrief(scan), "");
  } finally { delete process.env.CHIMERA_IMAGE; await cleanupWorkspace(ws); }
});

test("parseEchidna reads the broken property, its call sequence and the passes from a real report", () => {
  const { tests } = parseEchidna(ECHIDNA);
  assert.deepEqual(tests.map((t) => [t.name, t.status]), [
    ["vault_redeem(uint256)", "pass"],
    ["property_solvent()", "broken"],
    ["property_shareSupply()", "pass"],
    ["vault_deposit(uint256)", "pass"],
    ["vault_addYield(uint256)", "pass"],
    ["vault_withdraw(uint256)", "pass"],
  ]);
  // The live "Call sequence:" log above the report is not mixed in.
  assert.deepEqual(tests[1].sequence, ["vault_deposit(0)", "vault_redeem(0)", "property_solvent()"]);
});

test("parseMedusa reads only the final report, once, from real output", () => {
  const { tests } = parseMedusa(MEDUSA);
  // The failure is printed twice (live and in the final report); it counts once.
  assert.equal(tests.filter((t) => t.status === "broken").length, 1);
  assert.equal(tests.filter((t) => t.status === "pass").length, 5);
  const broken = tests.find((t) => t.status === "broken");
  assert.equal(broken.name, "property_solvent()");
  assert.equal(broken.sequence.at(-1), "property_solvent()");
  assert.ok(broken.sequence.some((c) => c.startsWith("vault_redeem(")));
});

test("the parsers throw on output that is not a finished report, so the scan fails closed", () => {
  assert.throws(() => parseEchidna("Error: compilation failed"));
  assert.throws(() => parseEchidna(""));
  // Cut before the summary: the run did not finish.
  assert.throws(() => parseEchidna(ECHIDNA.slice(0, ECHIDNA.indexOf("Unique instructions:"))));
  assert.throws(() => parseMedusa("panic: runtime error"));
  // Only the live part: the fuzzer never wrote its final report.
  assert.throws(() => parseMedusa(MEDUSA.slice(0, MEDUSA.indexOf("Fuzzer stopped"))));
  // An Echidna status we do not know is an error, never a pass.
  const odd = parseEchidna("property_x(): something new\n\nUnique instructions: 1\nTotal calls: 1\n");
  assert.deepEqual(odd.tests.map((t) => t.status), ["error"]);
});

// The merge with one engine down. runTool is mocked: Echidna returns its real
// report, Medusa returns junk. The broken property stays a lead and the junk
// engine is a gap, not a silent pass.
test("one engine down is a gap; the other engine's lead still counts", async () => {
  const wrap = await import("../lib/wrap.mjs");
  const real = { ...wrap };
  mock.module("../lib/wrap.mjs", {
    exports: {
      ...real,
      runTool: async ({ cmd }) => (cmd.join(" ").includes("echidna")
        ? { code: 1, stdout: ECHIDNA, stderr: "", timedOut: false }
        : { code: 0, stdout: "garbage", stderr: "", timedOut: false }),
    },
  });
  const ws = makeWorkspace(LAB);
  try {
    const mod = await import("../packs/contracts/chimera.mjs?onedown");
    const scan = await mod.chimeraScan(ws);
    assert.equal(scan.available, true);
    assert.deepEqual(scan.engines.map((e) => [e.engine, e.status]), [["Echidna", "ran"], ["Medusa", "unavailable"]]);
    assert.deepEqual(scan.gaps.map((g) => [g.engine, g.reason]), [["Medusa", "Medusa output could not be read"]]);
    assert.deepEqual(scan.leads.map((l) => [l.where, l.engines.join(), l.confidence, l.supportsProof]), [["CryticTester.property_solvent", "Echidna", "one engine", false]]);
    assert.match(mod.chimeraBrief(scan), /GAP Medusa: Medusa output could not be read/);
  } finally { mock.reset(); await cleanupWorkspace(ws); }
});
