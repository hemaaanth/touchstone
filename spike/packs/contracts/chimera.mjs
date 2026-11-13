// Chimera adapter: run the project's own Chimera property suite.
//
// Chimera (Recon) is a Solidity library, not a binary. A project that uses it
// ships one property suite with a CryticTester entry point (test/recon/ by
// convention) and the library in lib/chimera. The same suite runs under
// Echidna and Medusa. We run both fuzzers on it and merge their results.
//
// We run the real Echidna and Medusa binaries and read their text reports. We
// do not port any of their logic. Each runs in Docker through runTool(): no
// network, no pull, no extra privileges. Each copies the workspace to /tmp
// first, so build output and corpora never land in the workspace. Build the
// image once with spike/packs/contracts/images/build.sh chimera.
//
// What a result means:
//   - A broken property is a LEAD. It never makes a finding. The agent must
//     still replay it as a Foundry PoC.
//   - A property that did not break is "unverified": the fuzzers ran out of
//     budget, which never means "holds". It stays unverified until the vacuity
//     gate trusts the suite (suite-trust.mjs). Today the gate is not merged.
//   - A timeout, a build error, a missing image, a test the fuzzer could not
//     run or output we cannot read is a GAP, never a clean result.
//
// We run in assertion mode. Chimera's asserts (t, eq, gte, ...) fail with
// assert(false), so every property and target function that uses them is
// checked. A property written as a bool-returning echidna_ function is not.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { runTool } from "../../lib/wrap.mjs";
import { suiteTrust } from "./suite-trust.mjs";

const IMAGE = process.env.CHIMERA_IMAGE || "touchstone/chimera:e2.3.3-m1.5.1";
const ENTRY = "CryticTester";
const NO_REPORT = "CHIMERA_NO_REPORT";
const KILLED = "CHIMERA_KILLED";

const TESTER = /\bcontract\s+CryticTester\b/;
const USES_CHIMERA = /import\s[^;]*["'](@chimera\/|chimera\/|[^"']*lib\/chimera\/)/;

// Copy the workspace to /tmp, write the engine config from $CFG, run the engine
// with an inner kill so the container never outlives the limit, then print the
// report on stdout. With no report, print a marker and the log tail on stderr.
const scanCmd = (engine, secs) => {
  const run = engine === "Echidna"
    ? `printf '%s' "$CFG" > /tmp/e.yaml && { timeout -s KILL ${secs} echidna . --contract ${ENTRY} --config /tmp/e.yaml --format text >/tmp/out.txt 2>/tmp/err.txt; rc=$?; };`
    : `printf '%s' "$CFG" > /tmp/m.json && { timeout -s KILL ${secs} medusa fuzz --config /tmp/m.json >/tmp/out.txt 2>/tmp/err.txt; rc=$?; };`;
  return [
    "cp -a /work/. /tmp/p && cd /tmp/p &&",
    run,
    `[ "$rc" = 137 ] && echo ${KILLED} >&2;`,
    `if [ "$rc" != 137 ] && [ -s /tmp/out.txt ]; then tail -c 2000000 /tmp/out.txt; else echo ${NO_REPORT} >&2; fi;`,
    "tail -c 4000 /tmp/err.txt >&2",
  ].join(" ");
};

// Engine configs. Both fuzz CryticTester only, with no corpus on disk.
const echidnaCfg = ({ fuzzSecs, testLimit }) => [
  "testMode: assertion",
  `testLimit: ${testLimit}`,
  `timeout: ${fuzzSecs}`,
  "seqLen: 50",
  "workers: 2",
  'cryticArgs: ["--foundry-compile-all"]',
].join("\n");

const medusaCfg = ({ fuzzSecs, testLimit }) => JSON.stringify({
  fuzzing: {
    workers: 2, timeout: fuzzSecs, testLimit, callSequenceLength: 50,
    corpusDirectory: "", coverageEnabled: true, coverageFormats: [],
    targetContracts: [ENTRY],
    testing: {
      stopOnFailedTest: false, testAllContracts: false,
      assertionTesting: { enabled: true },
      propertyTesting: { enabled: false },
      optimizationTesting: { enabled: false },
    },
  },
  // Medusa reads the target relative to the config file, so give it the path.
  compilation: { platform: "crytic-compile", platformConfig: { target: "/tmp/p", args: ["--foundry-compile-all"] } },
  logging: { level: "info", noColor: true },
});

// The test files that define a Chimera CryticTester, relative to ws.
export function chimeraSuites(ws) {
  const root = join(ws, "test");
  if (!existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".sol")) {
        const src = readFileSync(p, "utf8");
        if (TESTER.test(src) && USES_CHIMERA.test(src)) out.push(relative(ws, p));
      }
    }
  };
  walk(root);
  return out.sort();
}

const ANSI = /\x1b\[[0-9;]*m/g;
const SIG = /^(\w+\([^)]*\))$/;

// Parse Echidna's text report. Pure. Returns
//   { tests: [{ name, status: "broken" | "pass" | "error", sequence, note? }] }
// Throws when the report is missing or cut short, so the caller fails closed.
export function parseEchidna(text) {
  const lines = String(text ?? "").replace(ANSI, "").split("\n");
  // The report ends with these lines. Without them the run did not finish.
  if (!lines.some((l) => /^Unique instructions:/.test(l)) || !lines.some((l) => /^Total calls:/.test(l))) {
    throw new Error("not a finished Echidna report");
  }
  const tests = [];
  for (let i = 0; i < lines.length; i++) {
    // "property_solvent(): failed!💥". Live log lines start with "[" or "Contract.".
    const m = lines[i].match(/^(\w+\([^)]*\)):\s+(.*?)\s*$/);
    if (!m || !SIG.test(m[1])) continue;
    const [, name, raw] = m;
    // Echidna's own event checker, not a suite property.
    if (name.startsWith("AssertionFailed(")) continue;
    if (/^passing/.test(raw)) tests.push({ name, status: "pass", sequence: [] });
    else if (/^fuzzing/.test(raw)) tests.push({ name, status: "pass", sequence: [], note: "budget ended before the test limit" });
    else if (/^(failed|shrinking|solved)/.test(raw)) {
      const sequence = [];
      let j = i + 1;
      while (j < lines.length && !/^\s+Call sequence/.test(lines[j]) && !/^\w+\([^)]*\):/.test(lines[j])) j++;
      if (/^\s+Call sequence/.test(lines[j] ?? "")) {
        for (j += 1; j < lines.length && lines[j].trim(); j++) {
          const c = lines[j].match(/^\s+(?:\*wait\*.*|\w+\.)?(\w+)\(([^)]*)\)/);
          if (c) sequence.push(`${c[1]}(${c[2].trim()})`);
        }
      }
      tests.push({ name, status: "broken", sequence, ...(raw.startsWith("shrinking") ? { note: "not fully shrunk" } : {}) });
    } else tests.push({ name, status: "error", sequence: [], note: raw.slice(0, 200) });
  }
  if (!tests.length) throw new Error("Echidna report lists no tests");
  return { tests };
}

// Parse Medusa's text output. Pure. Same return shape as parseEchidna.
// Only the block after "test results follow below" is the final report.
export function parseMedusa(text) {
  const all = String(text ?? "").replace(ANSI, "").split("\n");
  const start = all.findIndex((l) => /Fuzzer stopped, test results follow below/.test(l));
  const summary = all.findIndex((l) => /Test summary: \d+ test\(s\) passed, \d+ test\(s\) failed/.test(l));
  if (start < 0 || summary < start) throw new Error("not a finished Medusa report");
  const lines = all.slice(start + 1, summary);
  const tests = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/\[([A-Z ]+)\]\s+\w+ Test:\s+(?:\w+\.)?(\w+\([^)]*\))\s*$/);
    if (!m) continue;
    const [, state, name] = m;
    if (state === "PASSED") tests.push({ name, status: "pass", sequence: [] });
    else if (state === "FAILED") {
      const sequence = [];
      let j = i + 1;
      while (j < lines.length && !/^\[Call Sequence\]/.test(lines[j]) && !/\[[A-Z ]+\]\s+\w+ Test:/.test(lines[j])) j++;
      for (j += 1; j < lines.length && /^\d+\)/.test(lines[j]); j++) {
        const c = lines[j].match(/^\d+\)\s+(?:\w+\.)?(\w+)\([^)]*\)\(([^)]*)\)/);
        if (c) sequence.push(`${c[1]}(${c[2].trim()})`);
      }
      tests.push({ name, status: "broken", sequence });
    } else tests.push({ name, status: "error", sequence: [], note: `Medusa left the test ${state.toLowerCase()}` });
  }
  if (!tests.length) throw new Error("Medusa report lists no tests");
  return { tests };
}

const PARSE = { Echidna: parseEchidna, Medusa: parseMedusa };

// Run one engine. Never throws. Returns { engine, ok, reason, tests }.
async function runEngine(engine, ws, { fuzzSecs, testLimit, timeoutMs }) {
  const cfg = engine === "Echidna" ? echidnaCfg({ fuzzSecs, testLimit }) : medusaCfg({ fuzzSecs, testLimit });
  const secs = Math.max(1, Math.floor(timeoutMs / 1000) - 5);
  const r = await runTool({ image: IMAGE, cmd: ["sh", "-c", scanCmd(engine, secs)], ws, timeoutMs, env: { CFG: cfg }, maxBuffer: 16 * 1024 * 1024 });
  const fail = (reason) => ({ engine, ok: false, reason, tests: [] });
  if (r.timedOut || r.stderr.includes(KILLED)) return fail(`${engine} timed out after ${Math.round(timeoutMs / 1000)}s`);
  if (/unable to find image|no such image|pull access denied/i.test(r.stderr)) return fail(`image ${IMAGE} not built (spike/packs/contracts/images/build.sh chimera)`);
  try {
    return { engine, ok: true, reason: null, tests: PARSE[engine](r.stdout).tests };
  } catch {
    const log = `${r.stdout.slice(-4000)}\n${r.stderr}`;
    if (/not found in the compilation artifacts|compil\w* (error|fail)|Error \(\d+\)|ParserError|DeclarationError|TypeError|not found: File/i.test(log)) return fail(`the Chimera suite did not build for ${engine}`);
    return fail(r.stderr.includes(NO_REPORT) ? `${engine} wrote no report` : `${engine} output could not be read`);
  }
}

// Run the project's Chimera suite under Echidna and Medusa. Never throws.
// Returns { tool, available, applicable, reason, suites, engines, trust,
//           results, gaps, leads }
// available:false = no engine produced a report (gap for every suite).
// applicable:false = the project ships no Chimera suite; nothing ran.
export async function chimeraScan(ws, { fuzzSecs = 60, testLimit = 50_000, timeoutMs = (fuzzSecs + 120) * 1000 } = {}) {
  const tool = "Chimera";
  const suites = chimeraSuites(ws);
  const base = { tool, suites, engines: [], trust: null, results: [], gaps: [], leads: [] };
  if (!suites.length) return { ...base, available: true, applicable: false, reason: "no Chimera CryticTester in test/" };
  const down = (reason, engines = []) => ({ ...base, engines, available: false, applicable: true, reason, gaps: suites.map((suite) => ({ suite, reason })) });
  // Both engines build "CryticTester" by name, so two of them is ambiguous.
  if (suites.length > 1) return down(`more than one CryticTester (${suites.join(", ")}); Chimera ran none`);
  const suite = suites[0];

  const engines = await Promise.all(["Echidna", "Medusa"].map((e) => runEngine(e, ws, { fuzzSecs, testLimit, timeoutMs })));
  const ran = engines.filter((e) => e.ok);
  const engineView = engines.map((e) => ({ engine: e.engine, status: e.ok ? "ran" : "unavailable", reason: e.reason }));
  if (!ran.length) return down(engines.map((e) => e.reason).join("; "), engineView);

  const gaps = engines.filter((e) => !e.ok).map((e) => ({ suite, engine: e.engine, reason: e.reason }));
  // Merge per test: broken by any engine wins; an error is a gap.
  const byName = new Map();
  for (const e of ran) {
    for (const t of e.tests) {
      const cur = byName.get(t.name) ?? { suite, contract: ENTRY, name: t.name, brokenBy: [], passedBy: [], erroredBy: [], sequences: {} };
      if (t.status === "broken") { cur.brokenBy.push(e.engine); cur.sequences[e.engine] = t.sequence; }
      else if (t.status === "pass") cur.passedBy.push(e.engine);
      else { cur.erroredBy.push(e.engine); gaps.push({ suite, engine: e.engine, name: t.name, reason: t.note || `${e.engine} could not run this test` }); }
      byName.set(t.name, cur);
    }
  }

  // The gate call site. Today every verdict is "untrusted".
  const trust = { [suite]: await suiteTrust(ws, { tool, suite }) };
  const trusted = trust[suite]?.trusted === true;
  const results = [...byName.values()].map((x) => {
    const status = x.brokenBy.length ? "broken" : x.passedBy.length ? "pass" : "error";
    // A fuzzer pass only means "not broken in this budget". Untrusted: unverified.
    return { ...x, status, verdict: status === "pass" ? (trusted ? "not-broken" : "unverified") : status };
  });
  const leads = results.filter((x) => x.status === "broken").map((x) => {
    // The shortest sequence is the easiest to replay.
    const sequence = Object.values(x.sequences).sort((a, b) => a.length - b.length)[0] ?? [];
    return {
      engine: tool,
      engines: x.brokenBy,
      check: "chimera-property-broken",
      // The harm is unknown until a PoC shows it.
      impact: "Medium",
      confidence: x.brokenBy.length > 1 ? "two engines" : "one engine",
      file: suite,
      where: `${x.contract}.${x.name.replace(/\(.*$/, "")}`,
      lines: [],
      property: x.name,
      sequence,
      // A tool result alone never supports a proof while the suite is untrusted.
      supportsProof: trusted,
      description: `${x.brokenBy.join(" and ")} broke ${x.name} in the Chimera suite ${suite} after: ${sequence.join(" -> ") || "(no sequence reported)"}.`,
    };
  });
  return { tool, available: true, applicable: true, reason: null, suites, engines: engineView, trust, results, gaps, leads };
}

// The kickoff block for the agent. Empty when Chimera did not apply.
export function chimeraBrief(scan) {
  if (!scan || scan.applicable === false) return "";
  if (!scan.available) return `PROPERTY SUITE (Chimera) did not run: ${scan.reason}. The project's Chimera properties are unchecked; treat them as a gap, not as passing.`;
  const ran = scan.engines.filter((e) => e.status === "ran").map((e) => e.engine).join(" + ");
  const lines = [`PROPERTY SUITE (Chimera, run with ${ran}) over the project's own ${scan.suites[0]}:`];
  for (const l of scan.leads) lines.push(`- BROKEN ${l.where} (${l.engines.join(", ")}): ${l.sequence.join(" -> ") || "no sequence reported"}`);
  const passes = scan.results.filter((x) => x.status === "pass");
  if (passes.length) lines.push(`- ${passes.length} test${passes.length === 1 ? "" : "s"} did not break in the fuzzing budget. ${passes.every((x) => x.verdict === "unverified") ? "The suite is not vouched for (vacuity gate not merged), so this does NOT show the code is safe" : "See each verdict"}: ${passes.map((x) => x.name).join(", ")}`);
  for (const g of scan.gaps) lines.push(`- GAP ${[g.engine, g.name].filter(Boolean).join(" ") || g.suite}: ${g.reason}`);
  lines.push("A broken property is only a lead: it shows the property fails, not that funds move. Reproduce the call sequence with run_poc before you submit it.");
  return lines.join("\n");
}

// The record and event fields the run view reads (prepass-view.mjs).
export function chimeraRecord(scan) {
  return {
    tool: scan.tool,
    engines: [scan.tool],
    runners: scan.engines,
    applicable: scan.applicable,
    status: scan.available ? "ran" : "unavailable",
    reason: scan.reason,
    suspects: scan.leads.length,
    gaps: scan.gaps.length,
    trusted: Object.values(scan.trust ?? {}).some((t) => t?.trusted === true),
    top: scan.leads.slice(0, 8).map((l) => ({ check: l.check, impact: l.impact, where: l.where, property: l.property, engines: [scan.tool] })),
  };
}
