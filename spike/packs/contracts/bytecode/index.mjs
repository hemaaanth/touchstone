// Bytecode pre-pass for the Contracts pack.
//
// Some targets ship deployed code and no source: `src/<Name>.runtime.hex`.
// The source tools (Slither, Aderyn, the fuzzers) cannot see that logic. The
// bytecode tools read the hex directly. Their output goes to the agent as
// leads, in the same way as the static and fuzz leads. A lead is never a
// finding: the agent still proves it with a Foundry test that the harm gate
// accepts on replay.
//
// Every tool reports a status. A tool that could not run says "unavailable"
// with a reason. A tool that ran and found nothing says "no lead", never "safe".
import { defineTool } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { event } from "../../../lib/event.mjs";
import { bytecodeUnits } from "./units.mjs";
import { mythrilScan } from "./mythril.mjs";
import { heimdallScan, signatureOf } from "./heimdall.mjs";

export { bytecodeUnits };

const TOP = 8;
const MAX_JSON_LEADS = 30;

const RANK = { High: 0, Medium: 1, Low: 2, Informational: 3 };

// The record the run view reads (prepass-view.mjs, key `mythril`).
function mythrilRecord(scan) {
  const ran = scan.units.filter((u) => u.status === "ran");
  const incomplete = ran.some((u) => u.complete === false);
  const leads = [...scan.leads].sort((a, b) => (RANK[a.impact] ?? 4) - (RANK[b.impact] ?? 4));
  return {
    tool: "Mythril",
    engines: ["Mythril"],
    status: scan.available ? (incomplete ? "timed-out" : "ran") : "unavailable",
    reason: scan.reason,
    units: scan.units.map((u) => ({ name: u.name, file: u.file, status: u.status, reason: u.reason ?? null, leads: u.leads.length })),
    suspects: scan.leads.length,
    top: leads.slice(0, TOP).map((l) => ({
      check: l.check, impact: l.impact, where: l.where, line: null, pc: l.pc,
      sequence: l.sequence, engines: ["Mythril"], corroborated: false,
      description: l.description,
    })),
  };
}

// The record the run view reads (prepass-view.mjs, key `heimdall`). Heimdall is
// a decompiler, so it contributes no vuln leads (suspects: 0). Its value is the
// recovered ABI, carried for the agent in `abi`.
const MAX_ABI = 64;
function heimdallRecord(scan) {
  return {
    tool: "Heimdall",
    engines: ["Heimdall"],
    status: scan.available ? "ran" : "unavailable",
    reason: scan.reason,
    units: scan.units.map((u) => ({ name: u.name, file: u.file, status: u.status, reason: u.reason ?? null, functions: u.functions.length })),
    suspects: 0,
    recovered: scan.functions.length,
    abi: scan.functions.slice(0, MAX_ABI).map((f) => ({
      selector: f.selector, name: f.name, resolved: f.resolved,
      inputs: f.inputs, outputs: f.outputs, stateMutability: f.stateMutability,
      unit: f.unit, signature: signatureOf(f),
    })),
    top: [],
  };
}

// The ABI block Heimdall contributes to the agent brief and the findings tool.
function abiBlock(heim) {
  if (!heim) return "";
  if (heim.status === "unavailable") return `Heimdall: unavailable (${heim.reason}). This is a gap, not a clean result.`;
  if (!heim.abi?.length) return "Heimdall: ran, recovered no callable functions.";
  const lines = heim.abi.map((f) => `- ${f.signature}`).join("\n");
  return `Heimdall decompiled the bytecode and recovered this ABI (offline, selectors not resolved to names):\n${lines}\nDeclare these in an interface to call the contract from your PoC.`;
}

function leadLine(l, i) {
  const pc = l.pc != null ? ` (opcode at pc ${l.pc})` : "";
  const seq = l.sequence?.length ? `\nCall sequence Mythril found: ${l.sequence.join(" → ")}` : "";
  return `#${i + 1} [${l.impact}] ${l.check}${l.title ? ` ${l.title}` : ""} at ${l.where}${pc} — flagged by ${l.engine}${seq}\n${l.description}`;
}

function toolLine(t) {
  if (t.status === "unavailable") return `${t.tool}: unavailable (${t.reason}). This is a gap, not a clean result.`;
  const cap = t.status === "timed-out" ? " It stopped at its exploration cap, so it may have missed paths." : "";
  return `${t.tool}: ran on ${t.units.filter((u) => u.status === "ran").map((u) => u.file).join(", ")}, ${t.suspects} lead(s).${cap}`;
}

// The short block for the agent's first message, or "" when no tool gave a
// lead and none failed.
function briefFor(units, records, leads, heim) {
  const names = units.map((u) => `${u.file} (${u.bytes} bytes)`).join(", ");
  const status = records.map(toolLine).join("\n");
  const top = leads.slice(0, 5).map(leadLine).join("\n\n");
  const abi = abiBlock(heim);
  return `Bytecode-only target: ${names}. Its source is not available. The matching src/<Name>.sol is a stub that deploys this exact runtime code; deploy it with \`new <Name>()\` and call it through an interface you declare in your test.\n${status}${abi ? `\n\n${abi}` : ""}${top ? `\n\n${top}` : ""}`;
}

// Run every bytecode tool on every unit in the workspace. Returns the agent
// env (BYTECODE_BRIEF, BYTECODE_JSON) and the record keys for the run view.
// No units: nothing runs and both are empty.
export async function bytecodePrepass(ws, { emit, scan = mythrilScan, heimdall = heimdallScan } = {}) {
  const { units, skipped } = bytecodeUnits(ws);
  if (!units.length) return { env: {}, record: {} };
  const [myth, heim] = await Promise.all([scan(ws, units), heimdall(ws, units)]);
  const record = { mythril: mythrilRecord(myth), heimdall: heimdallRecord(heim) };
  if (skipped.length) record.mythril.skipped = skipped;
  emit?.({ t: Date.now(), ev: "bytecode-scan", tool: "Mythril", status: record.mythril.status, reason: record.mythril.reason, suspects: record.mythril.suspects, top: record.mythril.top });
  emit?.({ t: Date.now(), ev: "bytecode-scan", tool: "Heimdall", status: record.heimdall.status, reason: record.heimdall.reason, recovered: record.heimdall.recovered });
  const leads = [...myth.leads].sort((a, b) => (RANK[a.impact] ?? 4) - (RANK[b.impact] ?? 4));
  const json = {
    units: units.map((u) => ({ name: u.name, file: u.file, bytes: u.bytes })),
    skipped,
    tools: [
      { tool: "Mythril", status: record.mythril.status, reason: record.mythril.reason, suspects: record.mythril.suspects },
      { tool: "Heimdall", status: record.heimdall.status, reason: record.heimdall.reason, recovered: record.heimdall.recovered },
    ],
    leads: leads.slice(0, MAX_JSON_LEADS),
    abi: record.heimdall.abi,
  };
  return {
    env: { BYTECODE_BRIEF: briefFor(units, [record.mythril], leads, record.heimdall), BYTECODE_JSON: JSON.stringify(json) },
    record,
  };
}

// The block kickoff() adds to the first message, or null.
export function bytecodeKickoff(env) {
  if (!env?.BYTECODE_BRIEF) return null;
  return `${env.BYTECODE_BRIEF}\n\nThese leads come from tools that read only the deployed bytecode. A lead is only real once your PoC proves it. Call bytecode_findings for the full list.`;
}

// The agent tool that reads the bytecode report.
export function bytecodeFindingsTool() {
  return defineTool({
    name: "bytecode_findings",
    description: "Read the bytecode report for a target that ships deployed code without source: each tool's status, the ABI Heimdall recovered (the functions you can call and their argument types), and every lead Mythril found from the bytecode alone (the fault class, the opcode position, and the call sequence that reaches it). A lead is only a lead — prove it with run_poc against the contract the src/ stub deploys.",
    parameters: obj({}),
    replay: "safe",
    execute: async () => {
      event("bytecode_findings");
      let rep = null;
      try { rep = JSON.parse(process.env.BYTECODE_JSON || "null"); } catch { rep = null; }
      if (!rep || !Array.isArray(rep.tools)) return { output: [{ type: "text", text: "No bytecode report. The bytecode tools did not run for this target." }] };
      const status = rep.tools.map((t) => t.status === "unavailable"
        ? `${t.tool}: unavailable (${t.reason}). This is a gap, not a clean result.`
        : `${t.tool}: ${t.status}, ${t.suspects} lead(s).`).join("\n");
      const units = (rep.units ?? []).map((u) => `${u.file} (${u.bytes} bytes)`).join(", ");
      const abi = Array.isArray(rep.abi) && rep.abi.length
        ? `Heimdall recovered this ABI (declare it as an interface for your PoC):\n${rep.abi.map((f) => `- ${f.signature}`).join("\n")}`
        : "";
      const leads = Array.isArray(rep.leads) && rep.leads.length
        ? rep.leads.map(leadLine).join("\n\n")
        : "No lead within the tool budget. That does not mean the code is safe.";
      return { output: [{ type: "text", text: `Units: ${units}\n${status}${abi ? `\n\n${abi}` : ""}\n\n${leads}` }] };
    },
  });
}
