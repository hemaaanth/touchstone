// The pre-pass ensemble — the "modules" that feed the agent its leads.
//
// Two independent static analyzers (Slither + Aderyn) and two independent
// property fuzzers (Echidna + Medusa) scan the SAME prepared workspace before
// the agent starts. Our ensemble layer merges each pair into a ranked suspect
// list: where two engines agree, the suspect ranks higher — agreement sharpens
// attention, it never substitutes for the replay that makes a finding real. A
// static alert or a broken invariant is only a LEAD; the agent must still turn
// it into a passing Foundry PoC.
//
// WHY THIS IS SHARED. The CLI vertical slice ran this pre-pass but the web app
// did not — clicking Run spawned a bare agent with no leads, so the ensemble was
// invisible in the live product and every run looked the same. Both the CLI
// (agent-run.mjs main) and the app (app/server/runs.mjs) now call runPrepass so
// a live run and a CLI run drive the identical pipeline and emit the identical
// scan events. Showing a module as "on" in the UI is honest only because it
// actually ran here.
import { staticScan, staticBrief, staticGap } from "./static.mjs";
import { fuzzScan, fuzzBrief, fuzzGap } from "./fuzz.mjs";
import { scanSources } from "../packs/keys/source-checks.mjs";
import { mergeStatic } from "./ensemble.mjs";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

// The Solidity our rules read: src/ and vendor/, the same two roots the agent may
// read. For Contracts, vendor/ is NOT a dependency folder — it is where a brief's
// fetched scope lands, so it is the target. The real dependency folder is the
// repo-root lib/ (Foundry's), and a repo-root lib/ is never walked. Build output
// and installed packages are skipped. Capped, so a very large repo stays cheap.
const OUR_SOURCE_CAP = 400;
const OUR_SKIP = new Set(["node_modules", "out", "cache", ".git", "broadcast", "artifacts"]);
function oursSourceFiles(ws) {
  const out = [];
  let capped = false, unreadable = false;
  const walk = (rel) => {
    let entries = [];
    try { entries = readdirSync(join(ws, rel), { withFileTypes: true }); } catch (e) {
      if (e.code !== "ENOENT") unreadable = true;
      return;
    }
    for (const e of entries) {
      if (out.length >= OUR_SOURCE_CAP) { capped = true; return; }
      if (OUR_SKIP.has(e.name)) continue;
      const child = rel ? join(rel, e.name) : e.name;
      if (e.isDirectory()) { walk(child); continue; }
      if (!e.isFile() || !e.name.endsWith(".sol")) continue;
      try { out.push({ path: child.split(sep).join("/"), content: readFileSync(join(ws, child), "utf8") }); } catch { unreadable = true; }
    }
  };
  for (const root of ["src", "vendor"]) walk(root);
  const gaps = [];
  if (capped) gaps.push(`Touchstone source checks stopped at the ${OUR_SOURCE_CAP}-file limit; additional source files were not checked.`);
  if (unreadable) gaps.push("Touchstone source checks could not read some source files or folders.");
  return { files: out, gap: gaps.join(" ") };
}

// Our own crypto source checks over this workspace's Solidity, as lead-shaped
// rows. They come from packs/keys/source-checks.mjs — one implementation used by
// three packs, so a rule fixed there is fixed everywhere.
function sourceCheckLeads(ws) {
  try {
    const { files, gap } = oursSourceFiles(ws);
    const leads = scanSources(files).map((l) => ({
      engine: "Touchstone",
      check: l.check,
      impact: l.impact,
      file: l.file,
      where: l.where,
      lines: l.lines,
      description: l.description,
    }));
    return { leads, gap };
  } catch {
    return { leads: [], gap: "Touchstone source checks did not complete. This is a coverage gap, not a clean result." };
  }
}

// Merge source-check leads with the existing board, preserving its provenance.
function mergeOurs(findings, ours) {
  return mergeStatic([...findings, ...ours]);
}

const scanGap = (scan) => [staticGap(scan), scan.sourceGap].filter(Boolean).join("\n");

// The `static-scan` event shape, built once so the CLI and the app agree to the
// byte. `scan` is the staticScan result.
export function staticScanEvent(scan) {
  return {
    t: Date.now(), ev: "static-scan", tool: scan.tool, engines: scan.engines,
    files: scan.files, analysed: scan.analysed, failed: scan.failed,
    suspects: scan.findings.length,
    top: scan.findings.slice(0, 8).map((d) => ({
      check: d.check, impact: d.impact, where: d.where, line: d.lines[0] ?? null,
      engines: d.engines, corroborated: d.corroborated,
    })),
    // Why this scan's row is not evidence: it read no file, or it read some and
    // failed the rest. Absent when the scan really read what it was given.
    ...(scanGap(scan) ? { gap: scanGap(scan) } : {}),
  };
}

// The `fuzz-scan` event shape. `fuzz` is the fuzzScan result.
export function fuzzScanEvent(fuzz) {
  return {
    t: Date.now(), ev: "fuzz-scan", tool: fuzz.tool, engines: fuzz.engines,
    template: fuzz.template, applicable: fuzz.applicable,
    suspects: fuzz.findings.length,
    top: fuzz.findings.slice(0, 8).map((d) => ({
      check: d.check, impact: d.impact, where: d.where, property: d.property,
      sequence: d.sequence, engines: d.engines || [], corroborated: Boolean(d.corroborated),
    })),
    // Set when no invariant template fit this target, so "0 suspects" is a gap.
    ...(fuzzGap(fuzz) ? { gap: fuzzGap(fuzz) } : {}),
  };
}

// Run both ensembles against a prepared workspace and return everything a caller
// needs: the raw scans, the briefs, the UI events, and the agent `runEnv` that
// carries the leads into the run worker. Callbacks fire as each stage completes
// so a caller can stream the event to a UI and/or append it to an events file;
// the agent run must not start until this resolves, so the leads are ready.
// `runStatic` / `runFuzz` gate each half on the run's module plan. A scope with
// no local source at start (a brief, before its code is fetched) turns both off:
// there is nothing on disk to scan, so spinning up the scanners would be noise.
// When a half is off it is skipped entirely — no docker, no callback, no env —
// and the agent simply starts without that half's leads.
export async function runPrepass(ws, { onStaticStart, onStatic, onFuzzStart, onFuzz, runStatic = true, runFuzz = true } = {}) {
  // Static pre-pass: Slither + Aderyn as one compilation unit, plus our own crypto
  // source checks, merged into one ranked suspect list. A static alert is only a
  // lead. The source checks exist because Slither and Aderyn do not model crypto
  // rules at all: an ungated `transferOwnership`, an unprotected initializer, a
  // signature with no nonce. Every other pack that reads source already runs
  // them; before this, Contracts — the pack that reads the most Solidity — did not.
  let scan = null, brief = "", staticGapText = "", scanEvent = null;
  if (runStatic) {
    onStaticStart?.();
    scan = await staticScan(ws);
    // Our own crypto rules are candidates on the same board, so a rule that only
    // we know about can outrank a generic analyzer's guess.
    const ours = sourceCheckLeads(ws);
    scan = { ...scan, findings: ours.leads.length ? mergeOurs(scan.findings, ours.leads) : scan.findings, sourceGap: ours.gap };
    brief = staticBrief(scan);
    staticGapText = scanGap(scan);
    scanEvent = staticScanEvent(scan);
    onStatic?.(scanEvent, scan, brief);
  }

  // Fuzz pre-pass: Echidna + Medusa drive the same generated harness against an
  // invariant we assert about the target. They catch accounting bugs the static
  // engines cannot — but only where a fuzz template fits; otherwise they honestly
  // find nothing. A broken invariant is a strong lead (it comes with the breaking
  // call sequence) but never a finding on its own.
  let fuzz = null, fuzzBriefText = "", fuzzGapText = "", fuzzEvent = null;
  if (runFuzz) {
    onFuzzStart?.();
    fuzz = await fuzzScan(ws);
    fuzzBriefText = fuzzBrief(fuzz);
    fuzzGapText = fuzzGap(fuzz);
    fuzzEvent = fuzzScanEvent(fuzz);
    onFuzz?.(fuzzEvent, fuzz, fuzzBriefText);
  }

  // The leads, packaged as the env the run worker reads (see agent-run.mjs
  // child): the briefs frame the leads in the prompt; the JSON arrays back the
  // static_findings / fuzz_findings tools with full detail on demand. A half that
  // did not run contributes nothing, so its tool stays empty and is gated off.
  const runEnv = {};
  if (runStatic) {
    runEnv.STATIC_BRIEF = brief;
    runEnv.STATIC_GAP = staticGapText;
    runEnv.STATIC_JSON = JSON.stringify(scan.findings);
  }
  if (runFuzz) {
    runEnv.FUZZ_BRIEF = fuzzBriefText;
    runEnv.FUZZ_GAP = fuzzGapText;
    runEnv.FUZZ_JSON = JSON.stringify(fuzz.findings);
  }

  return { scan, brief, staticGap: staticGapText, scanEvent, fuzz, fuzzBriefText, fuzzGap: fuzzGapText, fuzzEvent, runEnv };
}
