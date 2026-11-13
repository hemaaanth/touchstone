// Halmos adapter: symbolic testing of the project's own property suite.
//
// Halmos (a16z) runs every `check_*` function in the Foundry tests for ALL
// values of its arguments, not a random sample. When an assertion can fail it
// gives a counterexample: the exact argument values that break it. forge test
// ignores check_ functions, so they only run here.
//
// We run the real Halmos binary and read its --json-output report. We do not
// port any of its logic. It runs in Docker through runTool(): no network, no
// pull, no extra privileges. The scan copies the workspace to /tmp first, so
// out/ and cache/ never land in the workspace. Build the image once with spike/packs/contracts/images/build.sh.
//
// What a result means:
//   - A counterexample is a LEAD. It never makes a finding. The agent must still
//     replay it as a Foundry PoC.
//   - A pass is "unverified" until the vacuity gate trusts the suite
//     (suite-trust.mjs). Today the gate is not merged, so no pass is trusted.
//   - A timeout, a failed setUp, a build error, a missing image or output we
//     cannot read is a GAP, never a clean result.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { runTool } from "../../lib/wrap.mjs";
import { suiteTrust } from "./suite-trust.mjs";

const IMAGE = process.env.HALMOS_IMAGE || "touchstone/halmos:0.3.3";
const NO_JSON = "HALMOS_NO_JSON";
const KILLED = "HALMOS_KILLED";

// Copy the workspace to /tmp and run there, so the build output stays in the
// container. Print the JSON report on stdout. With no report, print a marker
// and the log tail on stderr, so the caller can say why.
// Forge 1.9 links test contracts dynamically and rewrites `new X()` into a
// deployCode cheat code Halmos does not support, so turn that off.
// When the docker client times out, the container keeps running. The inner
// `timeout` kills Halmos first, so the container never outlives the limit.
// --function check_: Halmos 0.3.3 also runs invariant_ functions by default.
// We list and bind only check_ suites, so run only those.
// The sh wrapper exits 0 on a normal run. Any other code is a failed run.
const scanCmd = (secs) => [
  "cp -a /work/. /tmp/p && cd /tmp/p",
  `&& { timeout -s KILL ${secs} halmos --function check_ --json-output /tmp/h.json >/tmp/h.log 2>&1; rc=$?; };`,
  `[ "$rc" = 137 ] && echo ${KILLED} >&2;`,
  `if [ "$rc" != 137 ] && [ -s /tmp/h.json ]; then cat /tmp/h.json; else echo ${NO_JSON} >&2; tail -c 4000 /tmp/h.log >&2; fi`,
].join(" ");

// The check_ functions Halmos can run: those in the code, not in a comment,
// and not internal or private (Halmos runs only ABI functions). The name list
// is read from the source text, so a commented-out check_ is not a gap.
const CHECK_FNS = /\bfunction\s+(check_\w+)\s*\([^)]*\)([^{;]*)/g;
const uncommented = (src) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "");
const checkFns = (src) => [...uncommented(src).matchAll(CHECK_FNS)].filter((m) => !/\b(internal|private)\b/.test(m[2])).map((m) => m[1]);
const bare = (name) => String(name).replace(/\(.*$/, "");

// The test files that hold at least one check_ function, relative to ws.
export function symbolicSuites(ws) {
  const root = join(ws, "test");
  if (!existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".sol") && checkFns(readFileSync(p, "utf8")).length) out.push(relative(ws, p));
    }
  };
  walk(root);
  return out.sort();
}

// One counterexample model -> { name: value } with the Solidity variable name.
function modelArgs(model) {
  const args = {};
  for (const v of Object.values(model?.model ?? {})) {
    if (!v || typeof v !== "object") continue;
    const name = v.variable_name ?? v.full_name ?? "arg";
    const val = typeof v.value === "number" || typeof v.value === "bigint" ? BigInt(v.value) : v.value;
    args[name] = typeof val === "bigint" ? `${val} (0x${val.toString(16)})` : String(val);
  }
  return args;
}

// Parse a Halmos --json-output report. Pure: no Docker. Returns
//   { results: [{ suite, contract, name, status, args?, validated?, paths, time }],
//     gaps:    [{ suite, name?, reason }] }
// status is "counterexample" | "pass" | "timeout" | "error". Only a
// counterexample or a pass is a result; the rest are gaps too.
// Throws when the report is not a Halmos report, so the caller fails closed.
export function parseHalmos(report) {
  const doc = typeof report === "string" ? JSON.parse(report) : report;
  if (!doc || typeof doc !== "object" || !doc.test_results || typeof doc.test_results !== "object" || Array.isArray(doc.test_results)) {
    throw new Error("not a Halmos report");
  }
  // A report with no test entry is not a clean scan.
  if (!Object.keys(doc.test_results).length) throw new Error("the report has no test results");
  const results = [];
  const gaps = [];
  for (const [key, tests] of Object.entries(doc.test_results)) {
    const i = key.lastIndexOf(":");
    const suite = i > 0 ? key.slice(0, i) : key;
    const contract = i > 0 ? key.slice(i + 1) : key;
    // An empty list means no check_ ran: setUp reverted or the build of this
    // contract failed. That is a gap for the whole suite.
    if (!Array.isArray(tests) || tests.length === 0) {
      gaps.push({ suite, contract, reason: "no check_ function ran (setUp failed or the suite did not build)" });
      continue;
    }
    for (const t of tests) {
      const name = String(t?.name ?? "?");
      const base = { suite, contract, name, paths: Array.isArray(t?.num_paths) ? t.num_paths[0] : t?.num_paths ?? null, time: Array.isArray(t?.time) ? t.time[0] : t?.time ?? null };
      const models = Array.isArray(t?.models) ? t.models : [];
      if (t?.exitcode === 0) {
        results.push({ ...base, status: "pass" });
      } else if (t?.exitcode === 1 && models.length) {
        // is_valid false: Halmos could not replay the model concretely. Keep
        // it, but say so; it is a weaker lead.
        const m = models.find((x) => x?.is_valid) ?? models[0];
        results.push({ ...base, status: "counterexample", args: modelArgs(m), validated: Boolean(m?.is_valid) });
      } else if (t?.exitcode === 2) {
        results.push({ ...base, status: "timeout" });
        gaps.push({ suite, contract, name, reason: "solver timed out; the property is unchecked" });
      } else {
        results.push({ ...base, status: "error" });
        gaps.push({ suite, contract, name, reason: `Halmos could not check this test (exit ${t?.exitcode ?? "?"}, no counterexample)` });
      }
    }
  }
  return { results, gaps };
}

// Run Halmos over the workspace. Never throws. Returns
//   { tool, available, applicable, reason, suites, trust, results, gaps, leads }
// available:false = the scan did not produce a report (gap for every suite).
// applicable:false = the project ships no check_ function; nothing to run.
// Any throw inside the scan (for example ELOOP from a symlink loop under
// test/) is a gap for Halmos only. It must never reject, or the pack's other
// prepass leads are lost with it.
export async function halmosScan(ws, opts = {}) {
  try {
    return await scanHalmos(ws, opts);
  } catch (e) {
    const reason = `Halmos could not scan the workspace (${e?.code ?? e?.message ?? e}); its checks are unchecked`;
    return { tool: "Halmos", available: false, applicable: true, reason, suites: [], trust: null, results: [], gaps: [{ suite: "test/", reason }], leads: [] };
  }
}

async function scanHalmos(ws, { timeoutMs = 300_000 } = {}) {
  const tool = "Halmos";
  const suites = symbolicSuites(ws);
  if (!suites.length) {
    return { tool, available: true, applicable: false, reason: "no check_ functions in test/", suites, trust: null, results: [], gaps: [], leads: [] };
  }
  const secs = Math.max(1, Math.floor(timeoutMs / 1000) - 5);
  const r = await runTool({ image: IMAGE, cmd: ["sh", "-c", scanCmd(secs)], ws, timeoutMs, env: { FOUNDRY_DYNAMIC_TEST_LINKING: "false" } });
  const down = (reason) => ({
    tool, available: false, applicable: true, reason, suites, trust: null, results: [],
    gaps: suites.map((suite) => ({ suite, reason })), leads: [], timedOut: r.timedOut,
  });
  if (r.timedOut) return down(`timed out after ${Math.round(timeoutMs / 1000)}s`);
  // SIGKILL (137) is our time limit or the 2g memory limit; we cannot tell which.
  if (r.stderr.includes(KILLED)) return down(`killed after at most ${secs}s (time limit or out of memory)`);
  if (/unable to find image|no such image|pull access denied/i.test(r.stderr)) return down(`image ${IMAGE} not built (spike/packs/contracts/images/build.sh halmos)`);
  if (r.code !== 0) return down(`the Halmos container exited with code ${r.code}`);
  let parsed;
  try {
    parsed = parseHalmos(r.stdout);
  } catch (e) {
    const why = r.stderr.includes(NO_JSON) ? (/compil|error/i.test(r.stderr) ? "the project did not build for Halmos" : "Halmos wrote no report") : `Halmos report could not be read (${e.message})`;
    return down(why);
  }
  // Bind the report to this workspace. A suite we did not list is dropped. A
  // listed suite with no entry in the report is a gap.
  const listed = new Set(suites);
  const dropped = [...new Set([...parsed.results, ...parsed.gaps].map((x) => x.suite).filter((x) => !listed.has(x)))];
  parsed = { results: parsed.results.filter((x) => listed.has(x.suite)), gaps: parsed.gaps.filter((x) => listed.has(x.suite)) };
  const seen = new Set([...parsed.results, ...parsed.gaps].map((x) => x.suite));
  for (const suite of suites) if (!seen.has(suite)) parsed.gaps.push({ suite, reason: "Halmos reported no result for this suite" });
  // Each check_ function the suite file declares, with no result in a suite
  // that did report, is a gap. A check_ inherited from another file is not
  // seen here; Halmos still reports it, and it counts.
  for (const suite of suites) {
    if (parsed.gaps.some((g) => g.suite === suite && !g.name)) continue;
    const got = new Set(parsed.results.filter((x) => x.suite === suite).map((x) => bare(x.name)));
    for (const fn of checkFns(readFileSync(join(ws, suite), "utf8"))) {
      if (!got.has(fn)) parsed.gaps.push({ suite, name: fn, reason: "Halmos reported no result for this check_ function" });
    }
  }
  // The gate call site. One verdict per suite; today every verdict is "untrusted".
  const trust = {};
  for (const s of suites) trust[s] = await suiteTrust(ws, { tool, suite: s });
  const trusted = (suite) => trust[suite]?.trusted === true;
  const results = parsed.results.map((x) => ({
    ...x,
    // A pass is never "safe" on its own. Untrusted: unverified.
    verdict: x.status === "pass" ? (trusted(x.suite) ? "holds" : "unverified") : x.status,
  }));
  const leads = results.filter((x) => x.status === "counterexample").map((x) => ({
    engine: tool,
    check: "symbolic-counterexample",
    // The harm is unknown until a PoC shows it.
    impact: "Medium",
    confidence: x.validated ? "validated" : "unvalidated",
    file: x.suite,
    where: `${x.contract}.${x.name.replace(/\(.*$/, "")}`,
    lines: [],
    property: x.name,
    args: x.args,
    validated: x.validated,
    // A tool result alone never supports a proof while the suite is untrusted.
    supportsProof: trusted(x.suite),
    description: `Halmos found inputs that break the property ${x.name} in ${x.suite}: ${Object.entries(x.args).map(([k, v]) => `${k} = ${v}`).join(", ") || "(no arguments)"}.${x.validated ? "" : " Halmos could not validate this counterexample."}`,
  }));
  return { tool, available: true, applicable: true, reason: gapSummary(results, parsed.gaps), suites, trust, results, gaps: parsed.gaps, leads, dropped };
}

// "2 of 3 checks unchecked (solver timed out; ...)", or null with no gap.
// A check is one test result, or one suite that gave no test result at all.
function gapSummary(results, gaps) {
  if (!gaps.length) return null;
  // A gap that mirrors a result (timeout, error) is counted once.
  const has = new Set(results.map((r) => `${r.suite}\0${r.name}`));
  const total = results.length + gaps.filter((g) => !g.name || !has.has(`${g.suite}\0${g.name}`)).length;
  const why = [...new Set(gaps.map((g) => g.reason))].join("; ");
  return `${gaps.length} of ${total} check${total === 1 ? "" : "s"} unchecked (${why})`;
}

// The kickoff block for the agent. Empty when Halmos did not apply.
export function halmosBrief(scan) {
  if (!scan || scan.applicable === false) return "";
  if (!scan.available) return `SYMBOLIC TESTING (Halmos) did not run: ${scan.reason}. The project's check_ properties are unchecked; treat them as a gap, not as passing.`;
  const lines = ["SYMBOLIC TESTING (Halmos) over the project's own check_ properties:"];
  for (const l of scan.leads) lines.push(`- COUNTEREXAMPLE ${l.where}: ${Object.entries(l.args).map(([k, v]) => `${k} = ${v}`).join(", ")}${l.validated ? "" : " (not validated)"}`);
  const passes = scan.results.filter((x) => x.status === "pass");
  if (passes.length) lines.push(`- ${passes.length} propert${passes.length === 1 ? "y" : "ies"} passed, but ${passes.every((x) => x.verdict === "unverified") ? "the suite is not vouched for (vacuity gate not merged), so a pass does NOT show the code is safe" : "see each verdict"}: ${passes.map((x) => x.name).join(", ")}`);
  for (const g of scan.gaps) lines.push(`- GAP ${g.name ?? g.suite ?? ""}: ${g.reason}`);
  lines.push("A counterexample is only a lead: it shows the property fails, not that funds move. Reproduce it with run_poc before you submit it.");
  return lines.join("\n");
}

// The record and event fields the run view reads (prepass-view.mjs).
// A run where nothing was checked (every check a gap) is "unavailable", not "ran".
export function halmosRecord(scan) {
  const checked = scan.results.filter((x) => x.status === "pass" || x.status === "counterexample").length;
  return {
    tool: scan.tool,
    engines: [scan.tool],
    applicable: scan.applicable,
    status: scan.available && (checked > 0 || scan.applicable === false) ? "ran" : "unavailable",
    reason: scan.reason,
    suspects: scan.leads.length,
    gaps: scan.gaps.length,
    trusted: Object.values(scan.trust ?? {}).some((t) => t?.trusted === true),
    top: scan.leads.slice(0, 8).map((l) => ({ check: l.check, impact: l.impact, where: l.where, property: l.property, engines: [scan.tool] })),
  };
}
