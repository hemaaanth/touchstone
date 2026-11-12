// Audit a REAL folder of IaC without model spend.
//
// The pack reads any folder. This runner proves that on a real checkout: it
// captures the folder, runs the exact prepass the engine runs, replays three
// leads through the evidence proof, and writes validation/real-input.json.
// It pins the folder in place (snapshot.json plus a .touchstone.json), so audit
// a copy when the folder must stay untouched.
//
// Usage: node spike/packs/infra-cloud/real-input.mjs <dir> [<dir> ...]
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cryptoDetectors } from "./checks.mjs";
import { SELECTED, scannerDetectors } from "./scanners.mjs";
import pack from "./pack.mjs";
import { prepareSnapshot } from "./snapshot.mjs";
import { replayEvidence } from "../../lib/proof-evidence.mjs";

const dirs = process.argv.slice(2);
if (!dirs.length) throw new Error("Give at least one folder to audit");
const limit = Number(process.env.REPLAYS ?? 3);

// Keys stay as typed, so a saved relative path can be re-run from the same cwd.
const out = { command: `node spike/packs/infra-cloud/real-input.mjs ${dirs.join(" ")}`, replays: limit };
for (const arg of dirs) {
  const dir = resolve(arg);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Not a folder: ${arg}`);
  const started = Date.now();
  try {
    const { snapshot } = prepareSnapshot(dir);
    const prep = await pack.prepass(dir, { emit: () => {} });
    const located = prep.record.leads.filter((lead) => lead.file);
    const replays = [];
    // A few leads through the real replay, so the proof is shown on real input.
    for (const lead of located.slice(0, limit)) {
      const proof = await replayEvidence(dir, lead.evidence, { detectors: { ...cryptoDetectors(), ...scannerDetectors(SELECTED) } });
      replays.push({ check: lead.check, file: lead.file, line: lead.lines[0], status: proof.status });
    }
    out[arg] = {
      files: Object.keys(snapshot.files).length,
      skipped: snapshot.skipped?.length ?? 0,
      leads: prep.record.leads.length,
      located: located.length,
      executors: prep.record.coverage.map(({ engine, status, reported, leads }) => ({ engine, status, reported, leads })),
      cryptoChecks: [...new Set(prep.record.leads.filter((lead) => lead.engine === "Touchstone").map((lead) => lead.check))],
      sample: located.slice(0, 5).map((lead) => `${lead.engine} ${lead.check} ${lead.file}:${lead.lines[0]}`),
      replays,
      ms: Date.now() - started,
    };
  } catch (err) {
    out[arg] = { error: String(err?.message ?? err).slice(0, 300), ms: Date.now() - started };
  }
}
mkdirSync(new URL("./validation/", import.meta.url), { recursive: true });
writeFileSync(new URL("./validation/real-input.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log(readFileSync(new URL("./validation/real-input.json", import.meta.url), "utf8"));
