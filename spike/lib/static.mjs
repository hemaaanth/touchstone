// Static-analysis pass for the Contracts module (submodule: static + AI audit).
//
// This whole pass is a HYPOTHESIS GENERATOR, not a verdict. Two independent
// engines read the contract and shout out suspects — a ranked list of where a bug
// is likely. The exploit-proof agent then has to turn a suspect into a passing
// Foundry PoC before it counts. A static alert is never a finding on its own;
// only a replay is.
//
// We drive two engines as black boxes and merge them in our own ensemble layer:
//   - Slither (Trail of Bits), run inside the toolbox image over the per-run
//     workspace, OFFLINE (--network none). We compile the whole src/ tree as ONE
//     unit so cross-file inheritance and inter-contract flows resolve and nothing
//     is double-counted — see collectSlitherLeads.
//   - Aderyn (Cyfrin), a Rust analyzer run in Docker through runTool(), OFFLINE.
//     It compiles the whole project natively — see lib/aderyn.mjs.
// Where the two engines agree, the ensemble layer (lib/ensemble.mjs) raises the
// suspect's rank. That agreement signal — not either tool — is our contribution.
import { readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { runDocker } from "./wrap.mjs";
import { aderynScan } from "./aderyn.mjs";
import { mergeStatic, IMPACT_RANK } from "./ensemble.mjs";

const IMG = "ghcr.io/trailofbits/eth-security-toolbox:nightly";
const SOLC = "0.8.38"; // match the sandbox replay compiler so the suspect lines line up
// The aggregate entry file we synthesize to force one compilation unit. It is
// written into src/ only for the scan and deleted immediately after, so the agent
// never sees it as a source file.
const UNIT_FILE = "_TouchstoneUnit.sol";

// Honors the execution backend (local Docker or Daytona), like runTool.
const run = (args, timeoutMs, ws, opts = {}) => runDocker(args, { ws, timeoutMs, maxBuffer: 8 * 1024 * 1024, ...opts });

// Every .sol under src/, recursively, as paths relative to src/. Recursion is the
// whole point of "multi-file": a project with src/interfaces/IFoo.sol and
// src/core/Foo.sol is one unit, not two isolated top-level files.
function solFilesUnder(srcDir) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else if (name.endsWith(".sol") && name !== UNIT_FILE) out.push(relative(srcDir, full));
    }
  };
  walk(srcDir);
  return out;
}

// Pull the fields we care about out of one Slither detector result, tagged as a
// Slither lead for the ensemble. The source file is read from the element's
// source mapping so a detector is attributed to the real file it lives in, not to
// the aggregate entry.
function toSlitherLead(d) {
  const el = (d.elements || []).find((e) => e.type === "function") || (d.elements || [])[0] || {};
  const sm = el.source_mapping || {};
  const contract =
    (el.type_specific_fields && el.type_specific_fields.parent && el.type_specific_fields.parent.name) ||
    (d.elements || []).find((e) => e.type === "contract")?.name ||
    null;
  return {
    engine: "Slither",
    check: d.check, // e.g. "reentrancy-eth"
    impact: d.impact, // High | Medium | Low | Informational | Optimization
    confidence: d.confidence, // High | Medium | Low
    file: sm.filename_relative || sm.filename_short || null,
    where: el.name ? `${contract ? contract + "." : ""}${el.name}` : contract,
    lines: Array.isArray(sm.lines) ? sm.lines : [],
    description: String(d.description || "").trim(),
  };
}

// Run Slither once over the whole src/ tree as ONE compilation unit. crytic-compile's
// solc platform wants a single file target, so we synthesize an aggregate entry
// that imports every source and point Slither at it; solc then resolves the full
// import graph in one go. Returns normalized Slither leads, or null if the unit
// could not be compiled at all (the caller falls back to per-file scanning).
async function collectSlitherLeadsUnit(ws, srcDir, files, timeoutMs) {
  const unitPath = join(srcDir, UNIT_FILE);
  const imports = files.map((f) => `import "./${f.split("\\").join("/")}";`).join("\n");
  const unit = `// SPDX-License-Identifier: UNLICENSED\npragma solidity >=0.4.0;\n${imports}\n`;
  writeFileSync(unitPath, unit);
  try {
    const args = [
      "run", "--rm", "--network", "none",
      "-v", `${ws}:/work`, "-w", "/work", "--entrypoint", "sh",
      IMG,
      "-c",
      `solc-select use ${SOLC} --always-install >/dev/null 2>&1; slither 'src/${UNIT_FILE}' --compile-force-framework solc --solc-disable-warnings --json /tmp/s.json >/dev/null 2>/tmp/s.err; cat /tmp/s.json 2>/dev/null`,
    ];
    const r = await run(args, timeoutMs, ws);
    if (!r.stdout.trim()) return null;
    let parsed;
    try { parsed = JSON.parse(r.stdout); } catch { return null; }
    if (!parsed || parsed.success !== true || !parsed.results) return null;
    const leads = (parsed.results.detectors || [])
      .map(toSlitherLead)
      // Drop anything attributed to the synthetic aggregate — it is not real source.
      .filter((l) => !l.file || !l.file.endsWith(UNIT_FILE));
    return leads;
  } finally {
    rmSync(unitPath, { force: true });
  }
}

// Fallback: scan each src file on its own. Used only when the one-unit compile
// fails (e.g. a project that cannot all compile under one solc version). Leads are
// deduped by file+check+first-line so a shared import flagged in two files is not
// counted twice.
async function collectSlitherLeadsPerFile(ws, files, timeoutMs) {
  const leads = [];
  let analysed = 0;
  let failed = 0;
  for (const rel of files) {
    const args = [
      "run", "--rm", "--network", "none",
      "-v", `${ws}:/work`, "-w", "/work", "--entrypoint", "sh",
      IMG,
      "-c",
      `slither 'src/${rel}' --compile-force-framework solc --solc-disable-warnings --json /tmp/s.json >/dev/null 2>/tmp/s.err; cat /tmp/s.json 2>/dev/null`,
    ];
    const r = await run(args, timeoutMs, ws);
    let parsed = null;
    if (r.stdout.trim()) { try { parsed = JSON.parse(r.stdout); } catch { parsed = null; } }
    if (!parsed || parsed.success !== true || !parsed.results) { failed += 1; continue; }
    analysed += 1;
    leads.push(...(parsed.results.detectors || []).map(toSlitherLead));
  }
  const seen = new Set();
  const deduped = leads.filter((l) => {
    const key = `${l.file}|${l.check}|${l.lines[0] ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { leads: deduped, analysed, failed };
}

// Slither leads for the workspace, as one compilation unit when possible.
async function slitherLeads(ws, timeoutMs) {
  const srcDir = join(ws, "src");
  const files = solFilesUnder(srcDir);
  if (!files.length) return { leads: [], files: 0, analysed: 0, failed: 0, mode: "none" };
  const unit = await collectSlitherLeadsUnit(ws, srcDir, files, timeoutMs).catch(() => null);
  if (unit) return { leads: unit, files: files.length, analysed: files.length, failed: 0, mode: "unit" };
  const perFile = await collectSlitherLeadsPerFile(ws, files, timeoutMs);
  return { leads: perFile.leads, files: files.length, analysed: perFile.analysed, failed: perFile.failed, mode: "per-file" };
}

// The public static pass: run both engines and merge them into one ranked suspect
// board. Slither's High/Medium/Low and Aderyn's High are standalone candidates;
// Aderyn's Low tier (full of style notes) only counts where it lands on a
// candidate, as a second opinion that raises rank — see lib/ensemble.mjs.
export async function staticScan(ws, { timeoutMs = 180_000 } = {}) {
  const sl = await slitherLeads(ws, timeoutMs);
  const ad = await aderynScan(ws, { timeoutMs }).catch(() => ({ available: false, leads: [] }));

  const slitherCandidates = sl.leads.filter((l) => l.impact === "High" || l.impact === "Medium" || l.impact === "Low");
  const aderynHigh = ad.leads.filter((l) => l.impact === "High" || l.impact === "Medium");
  const aderynLow = ad.leads.filter((l) => l.impact === "Low");

  const findings = mergeStatic([...slitherCandidates, ...aderynHigh], aderynLow);

  const engines = ["Slither"];
  if (ad.available) engines.push("Aderyn");
  const tool = engines.join(" + ");

  return {
    tool,
    engines,
    mode: sl.mode, // "unit" (one compilation unit) | "per-file" (fallback) | "none"
    aderynAvailable: Boolean(ad.available),
    files: sl.files,
    analysed: sl.analysed,
    failed: sl.failed,
    findings,
  };
}

// A compact, ranked brief the agent reads before it starts hunting. Kept short so
// it focuses the agent without drowning the prompt. Suspects two engines agree on
// are marked, because that is the signal worth acting on first. Empty string when
// the scan found nothing actionable, so the caller can skip the section cleanly.
export function staticBrief(scan) {
  if (!scan || !scan.findings.length) return "";
  const lines = scan.findings.slice(0, 12).map((d, i) => {
    const at = d.where ? ` at \`${d.where}\`` : d.file ? ` in \`${d.file}\`` : "";
    const where = d.lines.length ? ` (line ${d.lines[0]})` : "";
    const agree = d.corroborated ? ` — ${d.engines.join(" + ")} agree` : "";
    return `${i + 1}. [${d.impact}] ${d.check}${at}${where}${agree}`;
  });
  const who = scan.engines.join(" + ");
  return `Static analysis (${who}) flagged ${scan.findings.length} suspect(s), scariest first:\n${lines.join("\n")}`;
}

// Back-compat shim: older callers imported slitherScan and read .findings. The
// orchestrator replaces it; this keeps a single Slither-only entry available for
// anything that still wants the raw Slither view.
export async function slitherScan(ws, opts = {}) {
  const s = await staticScan(ws, opts);
  return { tool: "Slither", files: s.files, analysed: s.analysed, failed: s.failed, findings: s.findings };
}

export { IMPACT_RANK };
