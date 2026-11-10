// Static-analysis pass for the Contracts module (submodule: static + AI audit).
//
// This is a HYPOTHESIS GENERATOR, not a verdict. Slither reads the contract and
// reports suspects — a ranked list of where a bug is likely. The exploit-proof
// agent then has to turn a suspect into a passing Foundry PoC before it counts.
// A Slither alert is never a finding on its own; only a replay is.
//
// We run Slither inside the Trail of Bits toolbox image over the SAME per-run
// workspace the Foundry sandbox uses. The run is offline (--network none): we
// force the plain `solc` framework so Slither compiles each source file with the
// in-image solc-select compiler and never tries to fetch solc over the network
// (Foundry framework would). See lib/sandbox.mjs for the workspace shape.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";

const IMG = "ghcr.io/trailofbits/eth-security-toolbox:nightly";

// Impact ranking so the agent sees the scariest suspects first. Slither's own
// severity words, highest first.
const IMPACT_RANK = { High: 0, Medium: 1, Low: 2, Informational: 3, Optimization: 4 };

const run = (args, timeoutMs) =>
  new Promise((resolve) => {
    execFile("docker", args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ stdout: String(stdout), stderr: String(stderr), timedOut: err?.killed === true, code: err?.code ?? 0 });
    });
  });

// Pull the fields we care about out of one Slither detector result.
function normalizeDetector(d) {
  const el = (d.elements || []).find((e) => e.type === "function") || (d.elements || [])[0] || {};
  const sm = el.source_mapping || {};
  const contract =
    (el.type_specific_fields && el.type_specific_fields.parent && el.type_specific_fields.parent.name) ||
    (d.elements || []).find((e) => e.type === "contract")?.name ||
    null;
  return {
    check: d.check, // e.g. "reentrancy-eth"
    impact: d.impact, // High | Medium | Low | Informational | Optimization
    confidence: d.confidence, // High | Medium | Low
    where: el.name ? `${contract ? contract + "." : ""}${el.name}` : contract,
    lines: Array.isArray(sm.lines) ? sm.lines : [],
    // Slither's description is a ready-made plain-language sentence; trim the
    // trailing reference URL/noise to one tight block.
    description: String(d.description || "").trim(),
  };
}

// Run Slither on one source file. Returns the detector list (possibly empty) or
// null if the file could not be analysed at all.
async function scanFile(ws, relFile, timeoutMs) {
  const args = [
    "run", "--rm", "--network", "none",
    "-v", `${ws}:/work`, "-w", "/work", "--entrypoint", "sh",
    IMG,
    "-c",
    // Compile with the plain solc framework (offline), write JSON to /tmp, print it.
    `slither '${relFile}' --compile-force-framework solc --solc-disable-warnings --json /tmp/s.json >/dev/null 2>/tmp/s.err; cat /tmp/s.json 2>/dev/null`,
  ];
  const r = await run(args, timeoutMs);
  if (!r.stdout.trim()) return null; // compile failed outright — no JSON produced
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch { return null; }
  if (!parsed || parsed.success !== true || !parsed.results) return null;
  return (parsed.results.detectors || []).map(normalizeDetector);
}

// Scan every Solidity source under src/ and merge the results, ranked by impact.
// Informational/optimization noise is dropped — the agent wants real suspects.
export async function slitherScan(ws, { timeoutMs = 180_000 } = {}) {
  const src = join(ws, "src");
  let files = [];
  try { files = readdirSync(src).filter((f) => f.endsWith(".sol")); } catch { files = []; }

  const all = [];
  let analysed = 0;
  let failed = 0;
  for (const f of files) {
    const dets = await scanFile(ws, `src/${f}`, timeoutMs);
    if (dets === null) { failed += 1; continue; }
    analysed += 1;
    all.push(...dets);
  }

  const findings = all
    .filter((d) => d.impact === "High" || d.impact === "Medium" || d.impact === "Low")
    .sort((a, b) => (IMPACT_RANK[a.impact] ?? 9) - (IMPACT_RANK[b.impact] ?? 9));

  return { tool: "Slither", files: files.length, analysed, failed, findings };
}

// A compact, ranked brief the agent reads before it starts hunting. Kept short
// so it focuses the agent without drowning the prompt. Empty string when the
// scan found nothing actionable, so the caller can skip the section cleanly.
export function staticBrief(scan) {
  if (!scan || !scan.findings.length) return "";
  const lines = scan.findings.slice(0, 12).map((d, i) => {
    const at = d.where ? ` at \`${d.where}\`` : "";
    const where = d.lines.length ? ` (line ${d.lines[0]})` : "";
    return `${i + 1}. [${d.impact}] ${d.check}${at}${where}`;
  });
  return `Static analysis (Slither) flagged ${scan.findings.length} suspect(s), scariest first:\n${lines.join("\n")}`;
}
