import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { tmpdir } from "node:os";
import { runTool, sarifLeads } from "../../lib/wrap.mjs";
import { sha256 } from "../../lib/proof-evidence.mjs";

export const SCANNERS = {
  trivy: { image: "aquasec/trivy:0.76.2@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb", cmd: ["config", "--skip-check-update", "--format", "sarif", "--config", "", "/work"] },
  checkov: { image: "touchstone/checkov-cli:3.4.3", cmd: ["--directory", "/work", "--framework", "terraform", "cloudformation", "kubernetes", "helm", "dockerfile", "--skip-download", "--download-external-modules", "false", "-o", "sarif", "--quiet", "--soft-fail"], report: "results.sarif" },
  kics: { image: "checkmarx/kics:v2.2.1@sha256:49ccc54b6ae7f5d5fc95e96f8f95c18c57f3bba047ab611a03d80792bdff6757", cmd: ["scan", "--path", "/work", "--queries-path", "/app/bin/assets/queries", "--libraries-path", "/app/bin/assets/libraries", "--report-formats", "sarif", "--output-path", "/work/.reports", "--output-name", "kics", "--ignore-on-exit", "results", "--no-progress", "--disable-secrets", "--silent"], report: ".reports/kics.sarif" },
  kubescape: { image: "touchstone/kubescape-cli:4.0.20", cmd: ["scan", "framework", "WorkloadScan", "/work/kubernetes.yaml", "--keep-local", "--use-from", "/opt/policies/workloadscan.json", "--controls-config", "/opt/policies/controls-config.json", "--exceptions", "/opt/policies/exceptions.json", "--format", "sarif", "--output", "/work/.reports/kubescape.sarif", "--scan-timeout", "90s", "--honor-inline-exceptions=false", "--no-ignore-file"], report: ".reports/kubescape.sarif" },
};

export const SELECTED = ["trivy", "kics"];

export async function scanSnapshot(snapshot, engine) {
  const spec = SCANNERS[engine];
  if (!spec) throw new Error("Unknown infrastructure scanner");
  const ws = mkdtempSync(join(tmpdir(), "infra-scan-"));
  try {
    for (const [file, source] of Object.entries(snapshot.files)) {
      if (posix.isAbsolute(file) || posix.normalize(file) !== file || file.split("/").some((p) => p === ".." || p.startsWith("."))) throw new Error("Unsafe snapshot path");
      mkdirSync(dirname(join(ws, file)), { recursive: true });
      writeFileSync(join(ws, file), source, { mode: 0o600 });
    }
    mkdirSync(join(ws, ".reports"));
    const r = await runTool({ ...spec, ws, env: { HOME: "/tmp", XDG_CACHE_HOME: "/tmp", CKV_SKIP_DOWNLOAD: "true", ENABLE_BC_SOURCE: "false", CHECKOV_SKIP_MAPPING: "true" }, timeoutMs: 150_000 });
    if (r.timedOut || ![0, 1].includes(r.code)) return { engine, status: "error", code: r.code, timedOut: r.timedOut, leads: [] };
    const raw = spec.report ? readFileSync(join(ws, spec.report), "utf8") : r.stdout;
    const sarif = JSON.parse(raw);
    if (sarif.version !== "2.1.0" || !Array.isArray(sarif.runs)) throw new Error("Invalid scanner output");
    const titles = new Map(sarif.runs.flatMap((run) => (run.tool?.driver?.rules ?? []).map((rule) => [rule.id, String(rule.shortDescription?.text ?? rule.name ?? rule.id).replace(/(?:0x)?\b[a-f0-9]{64}\b/gi, "[REDACTED]").slice(0, 240)])));
    const leads = sarifLeads(sarif, engine).flatMap((l) => {
      const file = l.file?.replace(/^\.\//, "").replace(/^\//, "");
      const line = l.lines[0];
      if (!Object.hasOwn(snapshot.files, file) || !Number.isInteger(line) || line < 1 || line > snapshot.files[file].split("\n").length || !/^[A-Za-z0-9_.:/-]+$/.test(l.check)) return [];
      const title = titles.get(l.check) ?? l.check;
      return [{ engine, check: l.check, title, impact: l.impact, file, lines: [line], where: { file, line, rule: l.check },
        description: `${title}. ${engine} confirms this static rule at the cited location. No deployment or exploit is tested.` }];
    });
    const reported = sarif.runs.reduce((n, run) => n + (run.results?.length ?? 0), 0);
    return { engine, status: "ok", code: r.code, reported, unlocated: reported - leads.length, leads };
  } catch {
    // Never expose diagnostics or SARIF snippets: they may include a wallet key.
    return { engine, status: "error", leads: [] };
  } finally { rmSync(ws, { recursive: true, force: true }); }
}

export function scannerDetectors(engines) {
  const cache = new Map();
  return Object.fromEntries(engines.map((engine) => [`tool:${engine}`, async (snapshot, where) => {
    const key = sha256(JSON.stringify(snapshot));
    let runs = cache.get(key);
    if (!runs) { runs = new Map(); cache.set(key, runs); }
    if (!runs.has(engine)) runs.set(engine, scanSnapshot(snapshot, engine));
    const r = await runs.get(engine);
    return { ok: r.status === "ok" && r.leads.some((l) => l.check === where?.rule && l.file === where?.file && l.lines[0] === where?.line) };
  }]));
}
