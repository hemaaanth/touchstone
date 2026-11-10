import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { runTool, sarifLeads } from "../../lib/wrap.mjs";
import { redactSecret } from "../../lib/proof-evidence.mjs";

export const SCANNERS = {
  zizmor: { image: "ghcr.io/zizmorcore/zizmor:1.32.0@sha256:3014cc8f68f663935f69b3c3e0e41f5ce102b268d97db13db0f62208747f860d", cmd: ["--offline", "--no-config", "--no-ignores", "--persona", "pedantic", "--format", "sarif", "--no-exit-codes", "."] },
  poutine: { image: "ghcr.io/boostsecurityio/poutine:1.1.6@sha256:722a8e0999b583c1540fe2974e691032b2d9d21b9256a17965132b6bfd0081b0", cmd: ["analyze_local", ".", "--format", "sarif"] },
  gitleaks: { image: "ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f", cmd: ["dir", ".", "--no-banner", "--ignore-gitleaks-allow", "--report-format", "json", "--report-path", "/dev/stdout", "--exit-code", "0"] },
  trufflehog: { image: "trufflesecurity/trufflehog:3.99.8@sha256:674b2f187620a19df77f44cf9a7d77efcc581a5662accef2f2739cbb46ba4a3a", cmd: ["filesystem", "/work", "--json", "--no-verification", "--no-update"] },
  osv: { image: "ghcr.io/google/osv-scanner:v2.7.1@sha256:a70ffffc2bfd33482953e5d6b64c6fcdb30239717a07b0f0d3ab2859ce3e4cde", cmd: ["scan", "source", "--offline", "--no-call-analysis", "--no-resolve", "--format", "json", "--lockfile", "package-lock.json"] },
};

function safeFile(raw, files) {
  const file = String(raw ?? "").replace(/^file:\/\//, "").replace(/^\/work\//, "").replace(/^\.\//, "");
  return Object.hasOwn(files, file) ? file : null;
}
function lead(engine, check, file, line, snapshot, { secret, impact = "Medium", ...extra } = {}) {
  if (!file || !Number.isInteger(line) || line < 1 || line > snapshot.files[file].split("\n").length || !/^[A-Za-z0-9_./-]+$/.test(check)) return null;
  const summary = secret ? redactSecret(secret) : undefined;
  return { engine, check, impact, file, lines: [line], where: { file, line, rule: check, ...(summary ? { secretHash: summary.sha256 } : {}) },
    description: `${engine} reported ${check}. This is an offline lead, not a live credential or exploit claim.`,
    ...(summary ? { secret: summary } : {}), ...extra };
}

export async function scanSnapshot(snapshot, engine) {
  const spec = SCANNERS[engine];
  if (!spec) throw new Error("Unknown scanner");
  const dir = mkdtempSync(join(tmpdir(), "touchstone-scan-"));
  try {
    for (const [file, content] of Object.entries(snapshot.files)) {
      if (posix.isAbsolute(file) || posix.normalize(file) !== file || file.split("/").some((s) => s === ".." || s === ".git") || file.startsWith(".scanner-db/")) throw new Error("Invalid snapshot file");
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), content, { mode: 0o600 });
    }
    // The advisory slice is part of the pinned snapshot. No database downloads.
    if (engine === "osv") {
      mkdirSync(join(dir, ".scanner-db/osv-scalibr/npm"), { recursive: true });
      writeFileSync(join(dir, ".scanner-db/osv-scalibr/npm/all.zip"), Buffer.from(snapshot.npmAdvisories, "base64"));
    }
    const r = await runTool({ ...spec, ws: dir, env: { HOME: "/tmp", XDG_CACHE_HOME: "/tmp", OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: "/work/.scanner-db", POUTINE_DISABLE_VERSION_CHECK: "1", GITLEAKS_CONFIG_TOML: readFileSync(new URL("./gitleaks.toml", import.meta.url), "utf8") }, timeoutMs: 120_000 });
    if (r.timedOut || ![0, ...(engine === "osv" ? [1] : [])].includes(r.code)) return { engine, status: "error", code: r.code, timedOut: r.timedOut, leads: [] };
    let leads;
    if (engine === "zizmor" || engine === "poutine") {
      leads = sarifLeads(r.stdout, engine).map((l) => lead(engine, l.check, safeFile(l.file, snapshot.files), l.lines[0], snapshot, { impact: l.impact }));
    } else if (engine === "gitleaks") {
      leads = JSON.parse(r.stdout).map((l) => lead(engine, l.RuleID, safeFile(l.File, snapshot.files), l.StartLine, snapshot, { secret: l.Secret, impact: "High" }));
    } else if (engine === "trufflehog") {
      leads = r.stdout.trim().split("\n").filter(Boolean).map((s) => {
        const l = JSON.parse(s), loc = l.SourceMetadata?.Data?.Filesystem;
        return lead(engine, l.DetectorName, safeFile(loc?.file, snapshot.files), loc?.line, snapshot, { secret: l.Raw, impact: "High" });
      });
    } else {
      leads = [];
      for (const result of JSON.parse(r.stdout).results ?? []) {
        const file = safeFile(result.source?.path, snapshot.files);
        for (const pkg of result.packages ?? []) for (const v of pkg.vulnerabilities ?? []) {
          const name = pkg.package?.name, version = pkg.package?.version;
          const line = file ? snapshot.files[file].split("\n").findIndex((s) => s.includes(JSON.stringify(`node_modules/${name}`))) + 1 : 0;
          leads.push(lead(engine, v.id, file, line, snapshot, { package: name, version, impact: "Medium" }));
        }
      }
    }
    return { engine, status: "ok", code: r.code, timedOut: false, leads: leads.filter(Boolean) };
  } catch {
    // Scanner exceptions can include secret-bearing output. Keep only a status.
    return { engine, status: "error", leads: [] };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// One fresh tool execution per engine per replay, not one per finding.
export function scannerDetectors() {
  const runs = new WeakMap();
  return Object.fromEntries(Object.keys(SCANNERS).map((engine) => [`tool:${engine}`, async (snapshot, where) => {
    let cache = runs.get(snapshot);
    if (!cache) { cache = new Map(); runs.set(snapshot, cache); }
    if (!cache.has(engine)) cache.set(engine, scanSnapshot(snapshot, engine));
    const r = await cache.get(engine);
    return { ok: r.status === "ok" && r.leads.some((l) => l.file === where?.file && l.lines[0] === where?.line && l.check === where?.rule && l.where.secretHash === where?.secretHash) };
  }]));
}
