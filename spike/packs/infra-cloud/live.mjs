import { spawn } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeLabWorkspace } from "./snapshot.mjs";
import { redactProof } from "./live-cloud.mjs";

// `node live.mjs` runs the paid end-to-end run. `node live.mjs summarize
// <record.json>` rebuilds the saved validation from an existing record, with no
// spend, so the checked-in summary is always script-generated.
const mode = process.argv[2] === "summarize" ? "summarize" : "run";
const ledger = "/home/hemanth/Projects/near/redteam-harness/spike/spend.json";
if (mode === "run" && (process.env.SPEND_LEDGER !== ledger || process.env.SPEND_CAP_USD !== "50.85" || process.env.RUN_BUDGET_USD !== "1")) throw new Error("Use WAVE1.md's shared ledger, cap and $1 run budget");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const results = join(root, "spike/results/agent");
const validation = new URL("./validation/", import.meta.url);

// The app loads saved runs whose id matches `-<10 digits>-<n>`, so the stamp
// carries a seconds field and a counter instead of one millisecond number.
const stamp = `infra-cloud-live-${Math.floor(Date.now() / 1000)}-1`;

export function summarizeResult(r, record) {
  const findings = r.findings ?? [];
  const live = findings.find((f) => f.proof?.kind === "http");
  return {
    provider: "near", alias: "qwen-abl", status: r.status, decision: r.decision, recorded: r.recorded,
    findings: findings.length,
    proofKinds: findings.reduce((n, f) => ({ ...n, [f.proof?.kind ?? "none"]: (n[f.proof?.kind ?? "none"] ?? 0) + 1 }), {}),
    allProofsPassed: findings.length > 0 && findings.every((f) => f.proof?.status === "pass"),
    liveProof: live ? { status: live.proof.status, oracle: live.proof.oracle?.name ?? "", requests: live.proof.log?.length ?? 0 } : null,
    usage: r.usage, snapshotHash: r.snapshotHash, commit: r.commit, record, reports: r.reports,
  };
}

function save(r, record) {
  // A record captured before redaction existed is scrubbed again here, so the
  // saved result never carries a credential value.
  if (r.findings) r = { ...r, findings: r.findings.map((f) => (f.proof?.kind === "http" ? { ...f, proof: redactProof(f.proof) } : f)) };
  const summary = summarizeResult(r, record);
  mkdirSync(validation, { recursive: true });
  writeFileSync(new URL("./live.json", validation), JSON.stringify(summary, null, 2) + "\n");
  writeFileSync(new URL("./live-record.json", validation), JSON.stringify({ result: r }, null, 2) + "\n");
  return summary;
}

if (mode === "summarize") {
  const file = process.argv[3];
  if (!file) throw new Error("Give a record file");
  const record = `spike/results/agent/${file.split("/").pop()}`;
  const summary = save(JSON.parse(readFileSync(file, "utf8")).result, record);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.allProofsPassed) process.exitCode = 1;
} else {
  const previous = mkdtempSync(join(tmpdir(), "infra-prior-runs-"));
  const suffixes = ["json", "events", "sqlite", "sqlite-wal", "sqlite-shm"];
  const saved = [];
  const ws = makeLabWorkspace();
  mkdirSync(results, { recursive: true });
  for (const suffix of suffixes) {
    const file = join(results, `run-qwen-abl.${suffix}`);
    if (existsSync(file)) { copyFileSync(file, join(previous, suffix)); saved.push(suffix); }
  }
  const log = createWriteStream(join(results, `run-${stamp}.log`));
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(root, "spike/agent-run.mjs")], { cwd: root, env: { ...process.env, PROVIDER: "near", ALIAS: "qwen-abl", TARGET: ws }, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (data) => log.write(data));
      child.stderr.on("data", (data) => log.write(data));
      child.on("error", reject);
      child.on("exit", resolve);
    });
    if (code !== 0) throw new Error(`Live engine exited ${code}; see the archived log`);
    const r = JSON.parse(readFileSync(join(results, "run-qwen-abl.json"), "utf8")).result;
    const summary = save(r, `spike/results/agent/run-${stamp}.json`);
    console.log(JSON.stringify(summary, null, 2));
    // The saved record is written first, so a failed run still leaves evidence.
    if (!summary.allProofsPassed) throw new Error("A submitted finding did not pass its replay");
  } finally {
    // Keep both runs. The engine's fixed qwen-abl filenames must not erase history.
    for (const suffix of suffixes) {
      const file = join(results, `run-qwen-abl.${suffix}`);
      if (existsSync(file)) copyFileSync(file, join(results, `run-${stamp}.${suffix}`));
    }
    for (const suffix of saved) copyFileSync(join(previous, suffix), join(results, `run-qwen-abl.${suffix}`));
    await new Promise((resolve) => log.end(resolve));
    rmSync(previous, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
}
