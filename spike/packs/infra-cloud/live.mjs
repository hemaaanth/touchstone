import { spawn } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeLabWorkspace } from "./snapshot.mjs";

const ledger = "/home/hemanth/Projects/near/redteam-harness/spike/spend.json";
if (process.env.SPEND_LEDGER !== ledger || process.env.SPEND_CAP_USD !== "50.85" || process.env.RUN_BUDGET_USD !== "1") throw new Error("Use WAVE1.md's shared ledger, cap and $1 run budget");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const results = join(root, "spike/results/agent");
// The app loads saved runs whose id matches `-<10 digits>-<n>`, so the stamp
// carries a seconds field and a counter instead of one millisecond number.
const stamp = `infra-cloud-qwen-abl-${Math.floor(Date.now() / 1000)}-1`;
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
  const data = JSON.parse(readFileSync(join(results, "run-qwen-abl.json"), "utf8"));
  const r = data.result;
  const kinds = (r.findings ?? []).reduce((n, f) => ({ ...n, [f.proof?.kind ?? "none"]: (n[f.proof?.kind ?? "none"] ?? 0) + 1 }), {});
  const summary = { provider: "near", alias: "qwen-abl", status: r.status, decision: r.decision, recorded: r.recorded, findings: r.findings?.length ?? 0, proofKinds: kinds, allProofsPassed: Boolean(r.findings?.length) && r.findings.every((f) => f.proof?.status === "pass"), allEvidencePassed: (r.findings ?? []).length > 0 && (r.findings ?? []).every((f) => f.proof?.kind === "evidence" && f.proof.status === "pass"), usage: r.usage, snapshotHash: r.snapshotHash, commit: r.commit, record: `spike/results/agent/run-${stamp}.json`, reports: r.reports };
  mkdirSync(new URL("./validation/", import.meta.url), { recursive: true });
  writeFileSync(new URL("./validation/live.json", import.meta.url), JSON.stringify(summary, null, 2) + "\n");
  writeFileSync(new URL("./validation/live-record.json", import.meta.url), JSON.stringify({ result: r }, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
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
