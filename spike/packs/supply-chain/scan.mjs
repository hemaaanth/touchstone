// Scan a real repo or folder. Read-only on the source. Tools run in Docker, offline.
// Output is redacted: a secret shows as [REDACTED] plus a hash, never in full.
// Usage: node packs/supply-chain/scan.mjs <path> [--json]
import { mkdtempSync, writeFileSync, rmSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pack from "./pack.mjs";
import { cryptoDetectors } from "./crypto.mjs";
import { scannerDetectors } from "./scanners.mjs";
import { replayEvidence } from "../../lib/proof-evidence.mjs";

const [target, ...flags] = process.argv.slice(2);
if (!target || !statSync(target, { throwIfNoEntry: false })?.isDirectory()) { console.error("Usage: node packs/supply-chain/scan.mjs <folder> [--json]"); process.exit(2); }

const ws = mkdtempSync(join(tmpdir(), "touchstone-scan-run-"));
writeFileSync(join(ws, ".touchstone.json"), JSON.stringify({ pack: "supply-chain", kind: "folder", source: realpathSync(target) }));
try {
  const { record } = await pack.prepass(ws, {});
  const detectors = { ...cryptoDetectors, ...scannerDetectors() };
  const rows = [];
  for (const l of record.leads) {
    const proof = await replayEvidence(ws, l.evidence, { detectors });
    rows.push({ id: l.id, impact: l.impact, check: l.check, file: l.file, line: l.lines[0], engines: l.engines, rootCause: l.rootCause.replace(/:[a-f0-9]{64}$/, ""), secret: l.secret, replay: proof.status });
  }
  const out = { source: realpathSync(target), commit: record.commit ?? null, coverage: record.coverage, skipped: record.skipped ?? null, leads: rows };
  if (flags.includes("--json")) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`source ${out.source}${out.commit ? ` @ ${out.commit.slice(0, 12)}` : " (folder, not git)"}`);
    for (const c of out.coverage) console.log(`  ${c.engine.padEnd(10)} ${c.status}${c.reason ? ` (${c.reason})` : ""} ${c.leads} leads`);
    if (out.skipped) console.log(`  skipped ${out.skipped.count} files (binary, large, or over budget)`);
    for (const r of rows) console.log(`${r.id.padStart(3)} ${r.impact.padEnd(6)} ${r.replay.padEnd(4)} ${r.check} ${r.file}:${r.line} [${r.engines.join("+")}]${r.secret ? ` ${r.secret.redacted} sha256:${r.secret.sha256.slice(0, 12)}` : ""}`);
  }
} finally { rmSync(ws, { recursive: true, force: true }); }
