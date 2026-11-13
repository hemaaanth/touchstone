// Mythril adapter: symbolic execution of deployed EVM bytecode.
//
// Mythril runs on the runtime bytecode only (`--bin-runtime`). It never sees
// Solidity source and needs no solc. It runs in Docker through runTool():
// --network none, --pull=never, the workspace read at /work. Each issue becomes
// a lead: the SWC class, the program counter of the faulting opcode, the
// function the last step calls, and the call sequence Mythril found. A lead is
// never a finding. The agent still proves it with a Foundry test that the
// harm gate accepts.
//
// Fail closed. Mythril prints `"issues": []` even when it could not load the
// code: the error is only in meta.logs. So a report counts only when every
// entry loaded raw bytecode and logged no error. A missing image, a timeout,
// unparsable output or a logged error gives available: false, never "clean".
import { runTool } from "../../../lib/wrap.mjs";

export const MYTHRIL_IMAGE = process.env.MYTHRIL_IMAGE || "touchstone/mythril:0.24.8";
// Mythril's own exploration budget per unit, in seconds. The container gets
// more time than this, so Mythril can stop and print what it found.
const EXEC_TIMEOUT_S = 90;
const TX_COUNT = 2;
const MAX_LEADS_PER_UNIT = 20;

const SEVERITY = { high: "High", medium: "Medium", low: "Low" };

// The function a step calls: Mythril's resolved name from its bundled
// signature list when it has one, else the 4-byte selector from the calldata.
function stepName(step) {
  const name = typeof step?.name === "string" ? step.name : "";
  if (name && name !== "unknown" && name !== "fallback") return name.slice(0, 120);
  const sel = String(step?.input ?? step?.calldata ?? "").match(/^0x([0-9a-f]{8})/i);
  return sel ? `0x${sel[1].toLowerCase()}` : name === "fallback" ? "fallback" : "unknown";
}

// Turn one Mythril jsonv2 report into a list of leads for one unit, or a
// reason why the report does not count.
export function parseMythril(stdout, unit) {
  let report;
  try { report = JSON.parse(String(stdout)); } catch { return { ok: false, reason: "unparsable output" }; }
  if (!Array.isArray(report) || report.length === 0) return { ok: false, reason: "no report" };
  const leads = [];
  let complete = true;
  for (const entry of report) {
    if (!entry || !Array.isArray(entry.issues)) return { ok: false, reason: "report has no issue list" };
    const logs = Array.isArray(entry.meta?.logs) ? entry.meta.logs : [];
    if (logs.some((l) => l?.level === "error")) return { ok: false, reason: "Mythril logged an error" };
    if (entry.sourceType !== "raw-bytecode") return { ok: false, reason: "Mythril did not load the bytecode" };
    const ns = Number(entry.meta?.mythril_execution_info?.analysis_duration);
    if (Number.isFinite(ns) && ns / 1e9 >= EXEC_TIMEOUT_S - 1) complete = false;
    for (const issue of entry.issues.slice(0, MAX_LEADS_PER_UNIT)) {
      const pc = Number(String(issue?.locations?.[0]?.sourceMap ?? "").split(":")[0]);
      const steps = Array.isArray(issue?.extra?.testCases?.[0]?.steps) ? issue.extra.testCases[0].steps : [];
      const sequence = steps.map(stepName);
      const head = String(issue?.description?.head ?? "").trim();
      const tail = String(issue?.description?.tail ?? "").trim();
      leads.push({
        engine: "Mythril",
        check: String(issue?.swcID || issue?.title || "mythril-issue").slice(0, 60),
        title: String(issue?.swcTitle || issue?.title || "").slice(0, 120),
        impact: SEVERITY[String(issue?.severity ?? "").toLowerCase()] ?? "Informational",
        confidence: null,
        file: unit.file,
        unit: unit.name,
        where: sequence.length ? `${unit.name}.${sequence[sequence.length - 1]}` : unit.name,
        pc: Number.isInteger(pc) ? pc : null,
        lines: [],
        sequence,
        description: [head, tail].filter(Boolean).join(" ").slice(0, 600),
      });
    }
  }
  return { ok: true, complete, leads };
}

// Run Mythril on every bytecode unit. Returns
//   { tool, available, reason, units: [{ name, file, status, reason, complete, leads }], leads }
// available is true only when every unit gave a report that counts. A unit
// that failed keeps its reason, so a gap is shown as a gap.
export async function mythrilScan(ws, units, { timeoutMs = (EXEC_TIMEOUT_S + 90) * 1000, run = runTool } = {}) {
  const out = [];
  for (const unit of units) {
    const r = await run({
      image: MYTHRIL_IMAGE,
      cmd: ["analyze", "-f", unit.file, "--bin-runtime", "-o", "jsonv2", "--execution-timeout", String(EXEC_TIMEOUT_S), "-t", String(TX_COUNT)],
      ws,
      timeoutMs,
    });
    if (r.timedOut) { out.push({ name: unit.name, file: unit.file, status: "unavailable", reason: "timed out", leads: [] }); continue; }
    if (/unable to find image|no such image|pull access denied|image .* not found/i.test(r.stderr ?? "")) {
      out.push({ name: unit.name, file: unit.file, status: "unavailable", reason: `image ${MYTHRIL_IMAGE} not built (see spike/packs/contracts/Dockerfile.mythril)`, leads: [] });
      continue;
    }
    const parsed = parseMythril(r.stdout, unit);
    if (!parsed.ok) { out.push({ name: unit.name, file: unit.file, status: "unavailable", reason: `${parsed.reason} (exit ${r.code})`, leads: [] }); continue; }
    out.push({ name: unit.name, file: unit.file, status: "ran", reason: parsed.complete ? null : `stopped at the ${EXEC_TIMEOUT_S} s exploration cap`, complete: parsed.complete, leads: parsed.leads });
  }
  const failed = out.filter((u) => u.status !== "ran");
  return {
    tool: "Mythril",
    available: out.length > 0 && failed.length === 0,
    reason: out.length === 0 ? "no bytecode units" : failed.length ? failed.map((u) => `${u.name}: ${u.reason}`).join("; ") : null,
    units: out,
    leads: out.flatMap((u) => u.leads),
  };
}
