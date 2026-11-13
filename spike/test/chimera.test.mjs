// Chimera runs the project's own CryticTester suite under Echidna and Medusa,
// in Docker. The real-run tests need the image
// (spike/packs/contracts/images/build.sh chimera) and skip when it is not built.
// The lab is lab/vault-shares: its redeem takes shares off managedAssets, so
// the vault counts assets it does not hold. Its suite is test/recon/.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { chimeraBrief, chimeraRecord, chimeraScan, chimeraSuites, parseEchidna, parseMedusa } from "../packs/contracts/chimera.mjs";
import { halmosRecord, halmosScan } from "../packs/contracts/halmos.mjs";
import { makeWorkspace, cleanupWorkspace } from "../lib/sandbox.mjs";
import { prepassView } from "../lib/prepass-view.mjs";
import contracts from "../packs/contracts/pack.mjs";

const LAB = new URL("../../lab/vault-shares", import.meta.url).pathname;
const SUITE = "test/recon/CryticTester.sol";
const IMAGE = "touchstone/chimera:e2.3.3-m1.5.1";
const has = (img) => { try { execFileSync("docker", ["image", "inspect", img], { stdio: "ignore" }); return true; } catch { return false; } };
const hasChimera = has(IMAGE);
// An image that runs but has no echidna or medusa: alpine, or else the Halmos image.
const NO_ENGINES = ["alpine:latest", "touchstone/halmos:0.3.3"].find(has);
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

test("Chimera reports unavailable when the image runs but writes no report", { skip: !NO_ENGINES && "no local image without echidna and medusa" }, async () => {
  // The image has no echidna or medusa: both runs produce nothing.
  process.env.CHIMERA_IMAGE = NO_ENGINES;
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

// The docker client hits its limit before the in-container kill. runTool must
// report timedOut and leave no container, not even one in state "Created"
// (the shared fix 44ba808, 135a436, 93dd481 on main).
// At timeoutMs 1000 the scan's own in-container kill is 1 s, so the container
// ends by itself and the test cannot see runTool's rm -f. A wrapper raises
// only that kill to 60 s. The real runTool still runs, so only its rm -f can
// stop the containers near the limit.
test("a client-side timeout reports timedOut for both engines, returns near the limit and leaves no container", { skip: !hasChimera && "image not built" }, async () => {
  const wrap = await import("../lib/wrap.mjs");
  const real = { ...wrap };
  let lifted = 0;
  const lift = (s) => s.replace(/timeout -s KILL \d+ /g, () => { lifted++; return "timeout -s KILL 60 "; });
  mock.module("../lib/wrap.mjs", { exports: { ...real, runTool: (o) => real.runTool({ ...o, cmd: o.cmd.map(lift) }) } });
  const ws = makeWorkspace(LAB);
  try {
    const { chimeraScan } = await import("../packs/contracts/chimera.mjs?clienttimeout");
    const t0 = Date.now();
    const scan = await chimeraScan(ws, { timeoutMs: 1000 });
    assert.equal(lifted, 2, "the in-container kill was not raised for both engines");
    assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0} ms`);
    assert.equal(scan.available, false);
    assert.equal(scan.reason, "Echidna timed out after 1s; Medusa timed out after 1s");
    assert.deepEqual(scan.engines.map((e) => [e.engine, e.timedOut]), [["Echidna", true], ["Medusa", true]]);
    assert.deepEqual(scan.leads, []);
    assert.equal(scan.gaps.length, 1);
    // The daemon can create the container after the client is gone, so wait
    // before the first look.
    await new Promise((r) => setTimeout(r, 5000));
    let left = "";
    for (let i = 0; i < 10; i++) {
      left = execFileSync("docker", ["ps", "-a", "--format", "{{.ID}} {{.Status}}", "--filter", `ancestor=${IMAGE}`, "--filter", `volume=${ws}`]).toString().trim();
      if (!left) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.equal(left, "");
  } finally {
    // Remove only what this test left on its own workspace.
    mock.reset();
    const mine = execFileSync("docker", ["ps", "-aq", "--filter", `ancestor=${IMAGE}`, "--filter", `volume=${ws}`]).toString().trim().split("\n").filter(Boolean);
    if (mine.length) execFileSync("docker", ["rm", "-f", ...mine], { stdio: "ignore" });
    await cleanupWorkspace(ws);
  }
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

// A PATH docker shim stands in for the real client. It sees the real argv and
// answers per engine with a given stdout and exit code.
async function withShim({ echidna = ECHIDNA, medusa = MEDUSA, ecode = 1, mcode = 7, prep = () => {} }, fn) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-shim-"));
  const path = process.env.PATH;
  for (const [e, out, code] of [["echidna", echidna, ecode], ["medusa", medusa, mcode]]) {
    writeFileSync(join(dir, `${e}.out`), out);
    writeFileSync(join(dir, `${e}.code`), String(code));
  }
  writeFileSync(join(dir, "docker"), [
    "#!/bin/sh",
    'case "$*" in *"echidna ."*) e=echidna;; *) e=medusa;; esac',
    `printf "%s\\n" "$@" > "${dir}/args.$e"`,
    `cat "${dir}/$e.out"`,
    `exit "$(cat "${dir}/$e.code")"`,
    "",
  ].join("\n"), { mode: 0o755 });
  const ws = makeWorkspace(LAB);
  prep(ws);
  process.env.PATH = `${dir}:${path}`;
  try {
    const scan = await chimeraScan(ws, { timeoutMs: 20_000 });
    const args = (e) => readFileSync(join(dir, `args.${e}`), "utf8").trim().split("\n");
    return await fn(scan, args);
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
    await cleanupWorkspace(ws);
  }
}
const STATIC = { tool: "Slither", engines: [], suspects: 0, top: [] };
const viewOf = (scan) => prepassView({ static: STATIC, chimera: chimeraRecord(scan) }).tools.find((t) => t.name === "Chimera");
// The final-report line only; the same failure is also printed live above it.
const lastReplace = (text, from, to) => { const i = text.lastIndexOf(from); return text.slice(0, i) + to + text.slice(i + from.length); };

test("the Chimera argv is pinned for both engines: --pull=never, --network none, the exact image", async () => {
  await withShim({}, (scan, args) => {
    assert.equal(scan.available, true, scan.reason);
    assert.equal(scan.leads.length, 1);
    for (const [e, run] of [["echidna", /echidna \. --contract CryticTester /], ["medusa", /medusa fuzz --config /]]) {
      const a = args(e);
      assert.deepEqual(a.slice(0, 3), ["run", "--rm", "--pull=never"]);
      assert.equal(a[a.indexOf("--network") + 1], "none");
      assert.equal(a.filter((x) => x === "--network").length, 1);
      const img = a.indexOf(IMAGE);
      assert.ok(img > 0, a.join(" "));
      assert.deepEqual(a.slice(img + 1, img + 3), ["sh", "-c"]);
      assert.match(a[img + 3], run);
    }
  });
});

test("an exit code that does not match the report is a failed run, never a lead or a pass", async () => {
  const clean = ECHIDNA.replace("property_solvent(): failed!💥", "property_solvent(): passing");
  const cases = [
    [{ ecode: 0 }, "Echidna exited with code 0, but its report has a broken test (expected 1)"],
    [{ mcode: 1 }, "Medusa exited with code 1, but its report has a broken test (expected 7)"],
    [{ echidna: clean, ecode: 1 }, "Echidna exited with code 1, but its report has no broken test (expected 0)"],
  ];
  for (const [opts, reason] of cases) {
    await withShim(opts, (scan) => {
      assert.equal(scan.available, true);
      assert.ok(scan.gaps.some((g) => g.reason === reason), JSON.stringify(scan.gaps));
      assert.ok(scan.engines.some((e) => e.status === "unavailable" && e.reason === reason));
    });
  }
  // Both engines fail: nothing ran, so nothing is a lead or a pass.
  await withShim({ ecode: 125, mcode: 125 }, (scan) => {
    assert.equal(scan.available, false);
    assert.equal(scan.reason, "Echidna exited with code 125, but its report has a broken test (expected 1); Medusa exited with code 125, but its report has a broken test (expected 7)");
    assert.deepEqual([scan.leads, scan.results], [[], []]);
    assert.equal(chimeraRecord(scan).status, "unavailable");
    assert.equal(viewOf(scan).status, "unavailable");
  });
});

test("a test on another contract, or one this suite does not declare, is a gap and never a lead", async () => {
  const medusa = lastReplace(MEDUSA, "[FAILED] Assertion Test: CryticTester.property_solvent()", "[FAILED] Assertion Test: OtherTarget.property_solvent()");
  const echidna = ECHIDNA.replace("vault_withdraw(uint256): passing", "vault_withdraw(uint256): passing\nproperty_drain(): failed!💥");
  await withShim({ echidna, medusa }, (scan) => {
    assert.equal(scan.available, true);
    assert.deepEqual(scan.dropped, ["Echidna: property_drain()", "Medusa: OtherTarget.property_solvent()"]);
    assert.deepEqual(scan.leads.map((l) => [l.where, l.engines.join()]), [["CryticTester.property_solvent", "Echidna"]]);
    assert.ok(!scan.results.some((r) => r.name === "property_drain()"));
    assert.deepEqual(scan.gaps.filter((g) => g.engine === "Medusa").map((g) => [g.name, g.reason]), [
      ["property_solvent()", "Medusa reported a test that is not in this suite"],
      ["property_solvent()", "Medusa reported no result for this property"],
    ]);
  });
});

test("a property the engine did not report is a gap, and the run view says some checks did not run", async () => {
  const echidna = ECHIDNA.replace("property_shareSupply(): passing\n", "");
  await withShim({ echidna }, (scan) => {
    assert.equal(scan.available, true);
    assert.deepEqual(scan.gaps, [{ suite: SUITE, engine: "Echidna", name: "property_shareSupply()", reason: "Echidna reported no result for this property" }]);
    assert.equal(scan.reason, "1 of 12 engine checks unchecked (Echidna reported no result for this property)");
    assert.deepEqual(viewOf(scan), { name: "Chimera", status: "ran", reason: scan.reason, leads: 1 });
  });
});

test("two CryticTester suites are ambiguous: unavailable with a gap per suite, and no engine runs", async () => {
  const a = "test/recon/CryticTester.sol";
  const b = "test/recon/CryticTester2.sol";
  const prep = (ws) => writeFileSync(join(ws, b), readFileSync(join(ws, a), "utf8"));
  await withShim({ prep }, (scan, args) => {
    const reason = `more than one CryticTester (${a}, ${b}); Chimera ran none`;
    assert.equal(scan.applicable, true);
    assert.equal(scan.available, false);
    assert.equal(scan.reason, reason);
    assert.deepEqual(scan.suites, [a, b]);
    assert.deepEqual(scan.gaps, [{ suite: a, reason }, { suite: b, reason }]);
    assert.deepEqual(scan.engines, []);
    assert.deepEqual(scan.leads, []);
    assert.deepEqual(viewOf(scan), { name: "Chimera", status: "unavailable", reason, leads: 0 });
    // The docker shim was never called.
    assert.throws(() => args("echidna"), /ENOENT/);
    assert.throws(() => args("medusa"), /ENOENT/);
  });
});

test("a finished report with no tests is unavailable, not clean", async () => {
  const echidna = "Unique instructions: 1\nTotal calls: 1\n";
  const medusa = "⇾ Fuzzer stopped, test results follow below ...\n⇾ Test summary: 0 test(s) passed, 0 test(s) failed\n";
  await withShim({ echidna, medusa, ecode: 0, mcode: 0 }, (scan) => {
    assert.equal(scan.available, false);
    assert.equal(scan.reason, "Echidna output could not be read; Medusa output could not be read");
    assert.deepEqual(scan.leads, []);
    assert.equal(viewOf(scan).status, "unavailable");
  });
});

test("when every check is a gap the run view shows unavailable with a reason, not ran", async () => {
  const echidna = "property_solvent(): something new\nproperty_shareSupply(): something new\n\nUnique instructions: 1\nTotal calls: 1\n";
  const medusa = "⇾ Fuzzer stopped, test results follow below ...\n⇾ [RUNNING] Assertion Test: CryticTester.property_solvent()\n⇾ Test summary: 0 test(s) passed, 0 test(s) failed\n";
  await withShim({ echidna, medusa, ecode: 0, mcode: 0 }, (scan) => {
    assert.equal(scan.available, true);
    assert.deepEqual(scan.leads, []);
    assert.ok(scan.results.every((r) => r.status === "error"));
    assert.match(scan.reason, /^4 of 4 engine checks unchecked \(/);
    const view = viewOf(scan);
    assert.deepEqual([view.status, view.reason], ["unavailable", scan.reason]);
  });
});

// A symlink loop under test/ makes the suite walk throw ELOOP. Each scan must
// turn that into its own gap and resolve, so the pack's Promise.all over both
// scans (and with it the static and fuzz leads) is not lost.
test("a symlink loop under test/ is a gap for Halmos and Chimera, never a throw, and starts no container", async () => {
  const ws = makeWorkspace(LAB);
  const dir = mkdtempSync(join(tmpdir(), "chimera-shim-"));
  writeFileSync(join(dir, "docker"), `#!/bin/sh\necho called >> "${dir}/called"\nexit 1\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try {
    symlinkSync("..", join(ws, "test", "recon", "loop"), "dir");
    assert.throws(() => chimeraSuites(ws), /ELOOP/);
    const [sym, prop] = await Promise.all([halmosScan(ws), chimeraScan(ws)]);
    for (const [scan, record, tool] of [[sym, halmosRecord(sym), "Halmos"], [prop, chimeraRecord(prop), "Chimera"]]) {
      assert.equal(scan.applicable, true, tool);
      assert.equal(scan.available, false, tool);
      assert.match(scan.reason, new RegExp(`^${tool} could not scan the workspace \\(ELOOP\\)`));
      assert.deepEqual(scan.leads, []);
      assert.equal(scan.gaps.length, 1);
      assert.equal(record.status, "unavailable");
    }
    const view = prepassView({ static: STATIC, symbolic: halmosRecord(sym), chimera: chimeraRecord(prop) });
    for (const tool of ["Halmos", "Chimera"]) {
      const row = view.tools.find((t) => t.name === tool);
      assert.equal(row.status, "unavailable", tool);
      assert.match(row.reason, /could not scan the workspace \(ELOOP\)/);
    }
    assert.throws(() => readFileSync(join(dir, "called")), /ENOENT/);
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
    await cleanupWorkspace(ws);
  }
});
