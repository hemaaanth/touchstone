// Scan a real repo or folder. Read-only on the source. Tools run in Docker, offline.
// Output is redacted: a secret shows as [REDACTED] plus a hash, never in full.
// A Git folder is read as committed files only. Add --worktree to read untracked and ignored files too.
// Usage: node packs/supply-chain/scan.mjs <path> [--json] [--worktree] [--skipped-out <file>]
//
// Live GitHub mode reads a repo or an org through the read-only GitHub API at a
// pinned commit. Nothing is cloned or run. It needs the operator's own statement
// of who authorized the test. GITHUB_TOKEN is optional: it lifts the rate limit
// and opens private repos the token can read. It is never printed.
// Usage: node packs/supply-chain/scan.mjs --github <owner/repo[@ref]|owner|github.com URL>[,...] --authorized "<who authorized this>" [--json] [--skipped-out <file>]
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pack, { SKIPPED_FILE } from "./pack.mjs";
import { cryptoDetectors } from "./crypto.mjs";
import { scannerDetectors } from "./scanners.mjs";
import { replayEvidence } from "../../lib/proof-evidence.mjs";
import { githubTarget, githubEntry, githubScopeKey } from "../../lib/scopes-store.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const VALUED = ["--skipped-out", "--github", "--authorized"];
const target = args.find((a, i) => !a.startsWith("--") && !VALUED.includes(args[i - 1]));
const usage = "Usage: node packs/supply-chain/scan.mjs <folder> [--json] [--worktree] [--skipped-out <file>]\n       node packs/supply-chain/scan.mjs --github <owner/repo[@ref]|owner>[,...] --authorized \"<who authorized this>\" [--json] [--skipped-out <file>]";
for (const f of VALUED) if (flag(f) && !value(f)) { console.error(usage); process.exit(2); }
let github = null;
if (flag("--github")) {
  if (target || flag("--worktree")) { console.error(usage); process.exit(2); }
  // Operator authorization: a GitHub read is a live action against a real target.
  if (!String(value("--authorized") ?? "").trim()) { console.error("--github needs --authorized \"<who authorized this test>\". Read only repos you have permission to test."); process.exit(2); }
  try { github = value("--github").split(",").map((g) => githubEntry(githubTarget(g))); }
  catch (err) { console.error(err.message); process.exit(2); }
} else if (!target || !statSync(target, { throwIfNoEntry: false })?.isDirectory()) { console.error(usage); process.exit(2); }

const ws = mkdtempSync(join(tmpdir(), "touchstone-scan-run-"));
try {
  const source = github ? github.map((g) => `github:${g}`).join(",") : realpathSync(target);
  writeFileSync(join(ws, ".touchstone.json"), JSON.stringify(github
    ? { pack: "supply-chain", kind: "live", github, reach: { granted: true, scope: github.map((g) => githubScopeKey(githubTarget(g))), authorizedBy: String(value("--authorized")).trim() } }
    : { pack: "supply-chain", kind: "folder", source, worktree: flag("--worktree") }));
  let record;
  try { ({ record } = await pack.prepass(ws, {})); }
  catch (err) {
    console.error(`scan failed: ${/no scannable text files/.test(err.message) ? "the folder has no readable text files (empty, binary only, or all too large)" : err.message}`);
    process.exitCode = 1;
  }
  if (record) {
    const detectors = { ...cryptoDetectors, ...scannerDetectors() };
    const rows = [];
    for (const l of record.leads) {
      const proof = await replayEvidence(ws, l.evidence, { detectors });
      rows.push({ id: l.id, impact: l.impact, check: l.check, file: l.file, line: l.lines[0], engines: l.engines, rootCause: l.rootCause.replace(/:[a-f0-9]{64}$/, ""), secret: l.secret, replay: proof.status });
    }
    // The full skip list dies with the workspace, so keep a copy where the operator can read it.
    let skippedFile = null;
    if (record.skipped) {
      skippedFile = resolve(value("--skipped-out") ?? join(homedir(), ".cache/touchstone/scans", `skipped-${record.snapshotHash.slice(0, 12)}.json`));
      mkdirSync(join(skippedFile, ".."), { recursive: true });
      copyFileSync(join(ws, SKIPPED_FILE), skippedFile);
    }
    const out = { source, scope: record.scope, commit: record.commit ?? null, ...(record.github ? { github: record.github } : {}), coverage: record.coverage, gaps: record.gaps, notScanned: record.notScanned ?? null, skipped: record.skipped ?? null, skippedFile, leads: rows };
    if (flag("--json")) console.log(JSON.stringify(out, null, 2));
    else {
      console.log(`source ${out.source}${out.commit ? ` @ ${out.commit.slice(0, 12)}` : ""}`);
      console.log(`scope: ${{ "committed-files-only": "COMMITTED FILES ONLY (add --worktree to read the rest)", folder: "plain folder, every readable file", worktree: "worktree: current files, tracked or not", "github-commit": "GitHub API read of committed files at the pinned commit" }[out.scope] ?? out.scope}`);
      for (const r of out.github?.repos ?? []) console.log(`  github ${r.repo}@${r.ref} = ${r.commit.slice(0, 12)}${r.private ? " (private)" : ""}`);
      if (out.github) console.log(`  github read: ${out.github.authenticated ? "with GITHUB_TOKEN" : "no token (public repos only, rate limited)"}`);
      for (const c of out.coverage) console.log(`  ${c.engine.padEnd(10)} ${c.status}${c.reason ? ` (${c.reason})` : ""} ${c.leads} leads`);
      const dirs = (o) => Object.entries(o).slice(0, 5).map(([d, c]) => `${d} ${c}`).join(", ");
      if (out.notScanned) console.log(`  not read: ${out.notScanned.untracked.count} untracked, ${out.notScanned.ignored.count} ignored${out.notScanned.ignored.count ? ` (${dirs(out.notScanned.ignored.byDir)})` : ""}${out.notScanned.untracked.rootFiles.length ? `; untracked at root: ${out.notScanned.untracked.rootFiles.join(", ")}` : ""}${out.notScanned.ignored.rootFiles.length ? `; ignored at root: ${out.notScanned.ignored.rootFiles.join(", ")}` : ""}`);
      if (out.skipped) {
        console.log(`  skipped ${out.skipped.count} files. By reason: ${dirs(out.skipped.byReason)}. By folder: ${dirs(out.skipped.byDir)}`);
        console.log(`  full list: ${skippedFile}`);
      }
      for (const g of out.gaps) console.log(`  COVERAGE GAP ${g.kind}: ${g.detail}`);
      for (const r of rows) console.log(`${r.id.padStart(3)} ${r.impact.padEnd(6)} ${r.replay.padEnd(4)} ${r.check} ${r.file}:${r.line} [${r.engines.join("+")}]${r.secret ? ` ${r.secret.redacted} sha256:${r.secret.sha256.slice(0, 12)}` : ""}`);
    }
  }
} finally { rmSync(ws, { recursive: true, force: true }); }
