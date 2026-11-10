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
import { staticScan, staticBrief } from "./static.mjs";
import { fuzzScan, fuzzBrief } from "./fuzz.mjs";

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
  };
}

// Run both ensembles against a prepared workspace and return everything a caller
// needs: the raw scans, the briefs, the UI events, and the agent `runEnv` that
// carries the leads into the run worker. Callbacks fire as each stage completes
// so a caller can stream the event to a UI and/or append it to an events file;
// the agent run must not start until this resolves, so the leads are ready.
export async function runPrepass(ws, { onStaticStart, onStatic, onFuzzStart, onFuzz } = {}) {
  // Static pre-pass: Slither + Aderyn as one compilation unit, merged into a
  // ranked suspect list. A static alert is only a lead.
  onStaticStart?.();
  const scan = await staticScan(ws);
  const brief = staticBrief(scan);
  const scanEvent = staticScanEvent(scan);
  onStatic?.(scanEvent, scan, brief);

  // Fuzz pre-pass: Echidna + Medusa drive the same generated harness against an
  // invariant we assert about the target. They catch accounting bugs the static
  // engines cannot — but only where a fuzz template fits; otherwise they honestly
  // find nothing. A broken invariant is a strong lead (it comes with the breaking
  // call sequence) but never a finding on its own.
  onFuzzStart?.();
  const fuzz = await fuzzScan(ws);
  const fuzzBriefText = fuzzBrief(fuzz);
  const fuzzEvent = fuzzScanEvent(fuzz);
  onFuzz?.(fuzzEvent, fuzz, fuzzBriefText);

  // The leads, packaged as the env the run worker reads (see agent-run.mjs
  // child): the briefs frame the leads in the prompt; the JSON arrays back the
  // static_findings / fuzz_findings tools with full detail on demand.
  const runEnv = {
    STATIC_BRIEF: brief,
    STATIC_JSON: JSON.stringify(scan.findings),
    FUZZ_BRIEF: fuzzBriefText,
    FUZZ_JSON: JSON.stringify(fuzz.findings),
  };

  return { scan, brief, scanEvent, fuzz, fuzzBriefText, fuzzEvent, runEnv };
}
