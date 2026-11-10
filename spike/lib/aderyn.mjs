// Aderyn adapter — the second static engine.
//
// Aderyn is Cyfrin's Rust static analyzer. We treat it exactly like Slither: a
// black-box subprocess that reads the project and emits suspects. We do not port
// or copy any of its logic; we run the real binary and translate its JSON report
// into the one normalized lead shape the ensemble layer merges. Aderyn compiles
// the WHOLE project as one unit (it reads foundry.toml for the source dir and
// remappings), so it is multi-file by construction — a useful contrast to how we
// drive Slither. A second independent engine is the point: where it agrees with
// Slither, the ensemble layer raises the suspect's rank.
//
// The binary is a build artifact, not our source, so it is not committed. It is
// fetched by tools/install-aderyn.sh to tools/bin/aderyn (pinned version), or
// supplied on PATH / via ADERYN_BIN. If it is absent the scan degrades cleanly to
// "unavailable" and the pipeline runs Slither-only.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// spike/lib/aderyn.mjs -> repo root -> tools/bin/aderyn
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ADERYN_BIN = process.env.ADERYN_BIN || join(REPO_ROOT, "tools", "bin", "aderyn");

// Aderyn groups issues by severity section. It only emits high/low today; we read
// medium too, defensively, in case a future version adds it.
const SECTIONS = [
  ["high_issues", "High"],
  ["medium_issues", "Medium"],
  ["low_issues", "Low"],
];

const run = (bin, args, cwd, timeoutMs) =>
  new Promise((resolve) => {
    execFile(bin, args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ stdout: String(stdout), stderr: String(stderr), timedOut: err?.killed === true, code: err?.code ?? 0, spawnErr: err?.code === "ENOENT" ? err : null });
    });
  });

// Turn one Aderyn issue instance into a normalized lead. Aderyn anchors to a file
// and line but does not name the enclosing Contract.function the way Slither does,
// so `where` stays null and the file+line carry the location. The title is a
// ready-made plain sentence; we keep it as the lead's check-side description.
function toLead(issue, impact) {
  const instances = Array.isArray(issue.instances) ? issue.instances : [];
  return instances.map((inst) => ({
    engine: "Aderyn",
    check: issue.detector_name || "aderyn-issue",
    impact,
    confidence: null, // Aderyn does not report a confidence score
    file: inst.contract_path || null,
    where: null,
    lines: typeof inst.line_no === "number" ? [inst.line_no] : [],
    description: [issue.title, issue.description].filter(Boolean).join(" — "),
  }));
}

// Run Aderyn over the per-run workspace and return its leads. `available` is
// false when the binary is missing or the scan could not produce a report, so the
// ensemble layer can note that only one static engine ran instead of silently
// pretending the project is clean.
export async function aderynScan(ws, { timeoutMs = 180_000 } = {}) {
  const outDir = mkdtempSync(join(tmpdir(), "aderyn-out-"));
  const outFile = join(outDir, "report.json");
  try {
    const r = await run(ADERYN_BIN, [ws, "--output", outFile], ws, timeoutMs);
    if (r.spawnErr) return { tool: "Aderyn", available: false, reason: "binary not found", leads: [] };
    let report;
    try {
      report = JSON.parse(readFileSync(outFile, "utf8"));
    } catch {
      return { tool: "Aderyn", available: false, reason: r.timedOut ? "timed out" : "no report produced", leads: [] };
    }
    const leads = [];
    for (const [section, impact] of SECTIONS) {
      const issues = (report[section] && report[section].issues) || [];
      for (const issue of issues) leads.push(...toLead(issue, impact));
    }
    const files = (report.files_summary && report.files_summary.total_source_units) || null;
    return { tool: "Aderyn", available: true, files, leads };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
