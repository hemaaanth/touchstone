// Every module pack Touchstone knows. The engine picks one per run from the
// workspace config (`.touchstone.json` field `pack`), so the tool set is fixed
// for the whole run, as pi-durable requires. A run with no `pack` field is a
// Contracts run, so every older workspace keeps working.
import contracts from "./contracts/pack.mjs";

export const PACKS = { [contracts.id]: contracts };

export function packFor(cfg = {}) {
  const id = cfg.pack ?? "contracts";
  const pack = PACKS[id];
  if (!pack) throw new Error(`Unknown pack "${id}". Known: ${Object.keys(PACKS).join(", ")}`);
  return pack;
}
