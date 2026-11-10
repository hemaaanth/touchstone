// Aderyn adapter — the second static engine.
//
// Aderyn is Cyfrin's Rust static analyzer. We treat it exactly like Slither: a
// black-box tool that reads the project and emits suspects. We do not port or
// copy any of its logic; we run the real binary and translate its JSON report
// into the one normalized lead shape the ensemble layer merges. Aderyn compiles
// the WHOLE project as one unit (it reads foundry.toml for the source dir and
// remappings), so it is multi-file by construction — a useful contrast to how we
// drive Slither. A second independent engine is the point: where it agrees with
// Slither, the ensemble layer raises the suspect's rank.
//
// Aderyn runs in Docker through lib/wrap.mjs runTool(): no network, no extra
// privileges, the workspace mounted at /work. The image holds a pinned Aderyn and
// the solc versions it needs. Build it once with tools/build-aderyn-image.sh. If
// the image is missing the scan degrades cleanly to "unavailable" and the
// pipeline runs Slither-only.
import { runTool } from "./wrap.mjs";

const IMAGE = process.env.ADERYN_IMAGE || "touchstone/aderyn:0.6.8";

// Aderyn writes its report to a file. Write it to /tmp inside the container, then
// print it, so nothing lands in the workspace the agent can see.
const SCAN = "aderyn /work --output /tmp/report.json >/dev/null 2>&1; cat /tmp/report.json";

// Aderyn groups issues by severity section. It only emits high/low today; we read
// medium too, defensively, in case a future version adds it.
const SECTIONS = [
  ["high_issues", "High"],
  ["medium_issues", "Medium"],
  ["low_issues", "Low"],
];

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
  const r = await runTool({ image: IMAGE, cmd: ["sh", "-c", SCAN], ws, timeoutMs });
  let report;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    const noImage = /unable to find image|no such image|pull access denied/i.test(r.stderr);
    const reason = r.timedOut ? "timed out" : noImage ? "image not built (tools/build-aderyn-image.sh)" : "no report produced";
    return { tool: "Aderyn", available: false, reason, leads: [] };
  }
  const leads = [];
  for (const [section, impact] of SECTIONS) {
    const issues = (report[section] && report[section].issues) || [];
    for (const issue of issues) leads.push(...toLead(issue, impact));
  }
  const files = (report.files_summary && report.files_summary.total_source_units) || null;
  return { tool: "Aderyn", available: true, files, leads };
}
