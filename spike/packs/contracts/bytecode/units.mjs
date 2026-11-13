// Deployed-bytecode units in a Contracts workspace.
//
// A target that ships runtime bytecode without source puts it under src/ as
// `<Name>.runtime.hex`: one line of hex, the code a deployed contract holds.
// The bytecode tools (Mythril, Heimdall) read only these files. They never see
// Solidity source. The agent cannot read them either (read_source opens .sol
// files under src/ and vendor/); it gets the tool leads instead.
//
// A unit is accepted only when the file is plain hex of a sane size. A bad file
// is reported as a skipped unit with a reason, never scanned and never dropped
// in silence.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SUFFIX = ".runtime.hex";
// EIP-170 caps deployed code at 24576 bytes. Allow some slack for other chains.
const MAX_BYTES = 64 * 1024;
const MAX_UNITS = 8;

// Every `src/**/<Name>.runtime.hex`, as { name, file, bytes } for good units
// and { file, reason } for skipped ones. `file` is workspace-relative, which is
// also its path at /work inside a tool container.
export function bytecodeUnits(ws) {
  const units = [];
  const skipped = [];
  const walk = (rel, depth) => {
    let entries;
    try { entries = readdirSync(join(ws, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = `${rel}/${e.name}`;
      if (e.isDirectory()) { if (depth < 4) walk(childRel, depth + 1); continue; }
      if (!e.isFile() || !e.name.endsWith(SUFFIX)) continue;
      const name = e.name.slice(0, -SUFFIX.length);
      if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) { skipped.push({ file: childRel, reason: "bad unit name" }); continue; }
      let size = 0;
      try { size = statSync(join(ws, childRel)).size; } catch { continue; }
      if (size > MAX_BYTES * 2 + 16) { skipped.push({ file: childRel, reason: "too large" }); continue; }
      const hex = readFileSync(join(ws, childRel), "utf8").trim().replace(/^0x/i, "");
      if (!hex || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) { skipped.push({ file: childRel, reason: "not plain hex" }); continue; }
      if (units.length >= MAX_UNITS) { skipped.push({ file: childRel, reason: `more than ${MAX_UNITS} units` }); continue; }
      units.push({ name, file: childRel, bytes: hex.length / 2 });
    }
  };
  walk("src", 0);
  return { units, skipped };
}
