// Slither adapter for the chain-watch and keys packs.
//
// Slither (crytic/slither, AGPL-3.0) is run as a separate program. We run the
// real binary in its own image and read its JSON report. No Slither code is
// copied or imported.
//
// It runs in Docker through lib/wrap.mjs runTool(): --network none, --pull=never,
// no capabilities, the workspace mounted at /work. The image pins Slither, every
// Python package, forge and solc 0.8.38 (packs/chain-watch/slither/Dockerfile).
// solc is inside the image, so a run never downloads a compiler.
//
// The scan copies the workspace to /tmp inside the container first. crytic-compile
// runs `forge clean` and `forge build`, and that must not touch the agent's files.
//
// Fail closed: a missing image, a timeout, a compile error or a report we cannot
// read gives `available: false` with a reason. It never gives a clean result.
//
// lib/static.mjs (the contracts pack) still runs its own Slither from the
// eth-security-toolbox image. This file does not change that path.
import { runTool } from "./wrap.mjs";

export const SLITHER_DEFAULT_IMAGE = "touchstone/slither:0.11.6";
// Read at call time, so a test can point it at a missing image.
export const slitherImage = () => process.env.SLITHER_IMAGE || SLITHER_DEFAULT_IMAGE;

// Vendored and test code is not the target. Match the pack's own source scan:
// `lib`, `test` and `script` at the repo root, and `node_modules` or `vendor` anywhere.
const VENDORED = /^(lib|test|script)\/|(^|\/)(node_modules|vendor)\//;
const FILTER = "/tmp/w/lib/,/tmp/w/test/,/tmp/w/script/,node_modules/,/vendor/";

// `cat` runs even when an earlier step fails. With no report file, stdout is empty,
// the parse gives "no report produced", and the tail of the Slither log goes to
// stderr so the reason can name the compile error.
const SCAN = "rm -rf /tmp/w && cp -r /work /tmp/w && cd /tmp/w && "
  + `slither . --compile-force-framework foundry --filter-paths '${FILTER}' --exclude-informational --exclude-optimization --json /tmp/s.json >/tmp/s.log 2>&1; `
  + "cat /tmp/s.json 2>/dev/null || tail -c 4000 /tmp/s.log >&2";

const IMPACT_ORDER = { High: 0, Medium: 1, Low: 2 };
const CONFIDENCE_ORDER = { High: 0, Medium: 1, Low: 2 };

// One Slither detector result as a lead. The first element names the place:
// a function, a state variable or a contract. Its parent contract, when there is
// one, makes the name `Contract.member`.
function toLead(d) {
  const el = (d.elements ?? [])[0] ?? {};
  const sm = el.source_mapping ?? {};
  const parent = el.type_specific_fields?.parent;
  // A local variable or a node sits inside a function: name the function, not the variable.
  const owner = parent?.type === "function" ? parent : null;
  const contract = parent?.type === "contract" ? parent.name : owner?.type_specific_fields?.parent?.name ?? null;
  const member = owner ? owner.name : el.name;
  const name = el.type === "contract" ? el.name : member ? `${contract ? `${contract}.` : ""}${member}` : contract;
  return {
    engine: "Slither",
    check: String(d.check ?? "slither-issue"),
    impact: d.impact,
    confidence: d.confidence ?? null,
    file: sm.filename_relative ?? null,
    where: name ?? null,
    lines: Array.isArray(sm.lines) ? sm.lines.filter(Number.isInteger) : [],
    description: String(d.description ?? "").trim(),
  };
}

// Parse the stdout of one scan. Pure, so the failure cases are easy to test.
// Returns { available, reason?, leads }.
export function parseSlither(stdout) {
  let report;
  try { report = JSON.parse(String(stdout ?? "")); } catch { return { available: false, reason: "no report produced", leads: [] }; }
  if (!report || typeof report !== "object") return { available: false, reason: "unparsable report", leads: [] };
  if (report.success !== true) {
    const why = String(report.error ?? "unknown error").split("\n").find((line) => line.trim()) ?? "unknown error";
    return { available: false, reason: `Slither failed: ${why.slice(0, 200)}`, leads: [] };
  }
  const detectors = report.results?.detectors ?? [];
  if (!Array.isArray(detectors)) return { available: false, reason: "unparsable report", leads: [] };
  const leads = detectors.map(toLead)
    .filter((l) => l.impact in IMPACT_ORDER && !(l.file && VENDORED.test(l.file)))
    .sort((a, b) => IMPACT_ORDER[a.impact] - IMPACT_ORDER[b.impact] || (CONFIDENCE_ORDER[a.confidence] ?? 9) - (CONFIDENCE_ORDER[b.confidence] ?? 9));
  return { available: true, leads };
}

// Run Slither over the workspace. Resolves (never rejects).
export async function slitherScan(ws, { timeoutMs = 240_000 } = {}) {
  const r = await runTool({ image: slitherImage(), cmd: ["sh", "-c", SCAN], ws, timeoutMs });
  if (r.timedOut) return { tool: "Slither", available: false, reason: "timed out", leads: [] };
  if (/unable to find image|no such image|pull access denied/i.test(r.stderr)) {
    return { tool: "Slither", available: false, reason: "image not built (spike/tools/build-slither-image.sh)", leads: [] };
  }
  const parsed = parseSlither(r.stdout);
  if (!parsed.available && parsed.reason === "no report produced") {
    const why = String(r.stderr).split("\n").map((line) => line.trim()).filter((line) => /error/i.test(line)).pop();
    if (why) parsed.reason = `no report produced: ${why.slice(0, 200)}`;
  }
  return { tool: "Slither", ...parsed };
}

// Slither leads in the shape the chain packs merge (packs/keys/common.mjs).
// Only High and Medium count, at most 10. A lead is never a finding.
export async function slitherLeads(ws, opts) {
  let scan;
  try { scan = await slitherScan(ws, opts); } catch (error) { return { available: false, reason: String(error?.message ?? error), leads: [] }; }
  const leads = scan.leads.filter((l) => l.impact === "High" || l.impact === "Medium").slice(0, 10)
    .map((l) => ({ engine: "Slither", check: l.check, impact: l.impact,
      where: `${l.where ?? "?"} (${l.file ?? "?"}:${l.lines[0] ?? 0})`, file: l.file, lines: l.lines, description: l.description }));
  return { available: scan.available, reason: scan.reason, leads };
}

// Tell the agent when Slither did not run, so "no Slither leads" is never read as "clean".
export const slitherNote = (slither) => (slither.available ? "" : `\n\nNOTE: Slither did NOT run (${String(slither.reason ?? "its image is missing").slice(0, 160)}). Having no Slither leads here does NOT mean the code is clean. Read the code yourself.`);
