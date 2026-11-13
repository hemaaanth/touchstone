// Heimdall adapter: decompiles deployed EVM bytecode and recovers its ABI.
//
// Heimdall is a decompiler, not a bug finder. On a target that ships only
// runtime bytecode it recovers the interface the source tools cannot see: the
// function selectors, their argument and return types, and each function's
// state mutability. That recovered ABI is evidence — it tells the agent which
// functions exist and how to call them, so it can declare the interface for
// its PoC. It is never a finding and never a verdict of safe.
//
// It runs in Docker through runTool(): --network none, --pull=never, the
// workspace read at /work. We pass `--skip-resolving`, so Heimdall never looks
// a selector up online; names stay as `Unresolved_<selector>` and the ABI is
// recovered from the bytecode alone. `-o print` needs a TTY, which runTool has
// not, so we write the ABI to a scratch dir inside the workspace, read it back,
// and delete it. Fail closed: a missing image, a timeout, a non-zero exit or an
// ABI file that is missing or not a JSON list gives available: false, never an
// empty-but-clean result.
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runTool } from "../../../lib/wrap.mjs";

export const HEIMDALL_IMAGE = process.env.HEIMDALL_IMAGE || "touchstone/heimdall:0.9.3";
// Per-function symbolic-execution budget, in milliseconds. Small units finish
// well under this; the container gets more wall time than the sum.
const FUNC_TIMEOUT_MS = 10_000;
const MAX_FUNCTIONS = 64;
const MAX_SOURCE_CHARS = 6000;

// Turn one Heimdall ABI JSON into the recovered functions, or a reason why it
// does not count. With --skip-resolving a name is `Unresolved_<selector>`; we
// read the selector back out of it. A name without that prefix means Heimdall
// matched a known signature (it would need its bundled list, not the network).
export function parseHeimdallAbi(text, _unit) {
  let abi;
  try { abi = JSON.parse(String(text)); } catch { return { ok: false, reason: "unparsable ABI" }; }
  if (!Array.isArray(abi)) return { ok: false, reason: "ABI is not a list" };
  const functions = abi
    .filter((e) => e && e.type === "function")
    .slice(0, MAX_FUNCTIONS)
    .map((e) => {
      const name = String(e.name ?? "").slice(0, 120);
      const m = name.match(/^Unresolved_([0-9a-fA-F]{8})$/);
      return {
        selector: m ? `0x${m[1].toLowerCase()}` : null,
        name: name || null,
        resolved: Boolean(name) && !/^Unresolved_/.test(name),
        inputs: (Array.isArray(e.inputs) ? e.inputs : []).map((i) => String(i?.type ?? "")).filter(Boolean),
        outputs: (Array.isArray(e.outputs) ? e.outputs : []).map((o) => String(o?.type ?? "")).filter(Boolean),
        stateMutability: String(e.stateMutability ?? "nonpayable").slice(0, 20),
      };
    });
  return { ok: true, functions };
}

// A readable signature for one recovered function, e.g.
//   sweep(address)  [0x01681a62, nonpayable]
// or, when a name was resolved, the resolved name in place of the selector id.
export function signatureOf(f) {
  const base = f.name && f.resolved ? f.name : `fn_${(f.selector ?? "0x????????").slice(2)}`;
  const args = f.inputs.join(",");
  const ret = f.outputs.length ? ` returns (${f.outputs.join(",")})` : "";
  const sel = f.selector ? `${f.selector}, ` : "";
  return `${base}(${args})${ret}  [${sel}${f.stateMutability}]`;
}

// Run Heimdall on every bytecode unit. Returns
//   { tool, available, reason, units: [{ name, file, status, reason, functions, source }], functions }
// available is true only when every unit decompiled to a JSON ABI list.
export async function heimdallScan(ws, units, { timeoutMs = (FUNC_TIMEOUT_MS * 8) + 60_000, run = runTool } = {}) {
  const out = [];
  for (const unit of units) {
    // Heimdall needs a writable output dir; `-o print` wants a TTY we do not
    // have. Give it a scratch dir inside the workspace, read it, then remove it.
    const outAbs = mkdtempSync(join(ws, ".heimdall-"));
    const outRel = outAbs.slice(ws.length).replace(/^[/\\]/, "");
    try {
      const r = await run({
        image: HEIMDALL_IMAGE,
        cmd: ["decompile", unit.file, "--skip-resolving", "--include-sol", "-d", "-o", `/work/${outRel}`, "-n", "unit", "--timeout", String(FUNC_TIMEOUT_MS)],
        ws,
        timeoutMs,
      });
      if (r.timedOut) { out.push({ name: unit.name, file: unit.file, status: "unavailable", reason: "timed out", functions: [] }); continue; }
      if (/unable to find image|no such image|pull access denied|image .* not found/i.test(r.stderr ?? "")) {
        out.push({ name: unit.name, file: unit.file, status: "unavailable", reason: `image ${HEIMDALL_IMAGE} not built (see spike/packs/contracts/Dockerfile.heimdall)`, functions: [] });
        continue;
      }
      const abiPath = join(outAbs, "unit-abi.json");
      if (r.code !== 0 || !existsSync(abiPath)) {
        out.push({ name: unit.name, file: unit.file, status: "unavailable", reason: `Heimdall wrote no ABI (exit ${r.code})`, functions: [] });
        continue;
      }
      const parsed = parseHeimdallAbi(readFileSync(abiPath, "utf8"), unit);
      if (!parsed.ok) { out.push({ name: unit.name, file: unit.file, status: "unavailable", reason: `${parsed.reason} (exit ${r.code})`, functions: [] }); continue; }
      let source = null;
      const solPath = join(outAbs, "unit-decompiled.sol");
      if (existsSync(solPath)) source = readFileSync(solPath, "utf8").slice(0, MAX_SOURCE_CHARS);
      out.push({ name: unit.name, file: unit.file, status: "ran", reason: null, functions: parsed.functions, source });
    } finally {
      rmSync(outAbs, { recursive: true, force: true });
    }
  }
  const failed = out.filter((u) => u.status !== "ran");
  return {
    tool: "Heimdall",
    available: out.length > 0 && failed.length === 0,
    reason: out.length === 0 ? "no bytecode units" : failed.length ? failed.map((u) => `${u.name}: ${u.reason}`).join("; ") : null,
    units: out,
    functions: out.flatMap((u) => u.functions.map((f) => ({ ...f, unit: u.name, file: u.file }))),
  };
}
