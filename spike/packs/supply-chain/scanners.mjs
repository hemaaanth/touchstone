import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, linkSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import { runTool, sarifLeads } from "../../lib/wrap.mjs";
import { redactSecret } from "../../lib/proof-evidence.mjs";

export const SCANNERS = {
  zizmor: { image: "ghcr.io/zizmorcore/zizmor:1.32.0@sha256:3014cc8f68f663935f69b3c3e0e41f5ce102b268d97db13db0f62208747f860d", cmd: ["--offline", "--no-config", "--no-ignores", "--persona", "pedantic", "--format", "sarif", "--no-exit-codes", "."] },
  poutine: { image: "ghcr.io/boostsecurityio/poutine:1.1.6@sha256:722a8e0999b583c1540fe2974e691032b2d9d21b9256a17965132b6bfd0081b0", cmd: ["analyze_local", ".", "--format", "sarif"] },
  gitleaks: { image: "ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f", cmd: ["dir", ".", "--no-banner", "--ignore-gitleaks-allow", "--report-format", "json", "--report-path", "/dev/stdout", "--exit-code", "0"] },
  trufflehog: { image: "trufflesecurity/trufflehog:3.99.8@sha256:674b2f187620a19df77f44cf9a7d77efcc581a5662accef2f2739cbb46ba4a3a", cmd: ["filesystem", "/work", "--json", "--no-verification", "--no-update"] },
  semgrep: { image: "semgrep/semgrep@sha256:cc1b68266f267878b39739373ea9985b9a78e5d64497dd875c8de100b22695ed", cmd: ["semgrep", "scan", "--config", "/work/.scanner-rules", "--metrics", "off", "--disable-version-check", "--sarif", "--quiet", "--no-git-ignore", "."] },
  grype: { image: "anchore/grype@sha256:13113eeceab017260370cf540e1d25442c59665fd07d1b09b66d63bb0c282887", cmd: ["sbom:/work/.scanner-sbom.json", "-o", "json", "-q"] },
  osv: { image: "ghcr.io/google/osv-scanner:v2.7.1@sha256:a70ffffc2bfd33482953e5d6b64c6fcdb30239717a07b0f0d3ab2859ce3e4cde", cmd: ["scan", "source", "--offline", "--no-call-analysis", "--no-resolve", "--format", "json"] },
};

// Syft builds the package list (SBOM). It is not a scanner, so it has no detector.
// Grype reads that SBOM against its own vulnerability database.
export const SYFT = { image: "anchore/syft@sha256:03215d0e98b661d0ecbc8575dbc14d65be1743b5de5df6410aecb7e80f95b060", cmd: ["scan", "dir:/work", "--exclude", "./.scanner-db", "--exclude", "./.scanner-rules", "-o", "syft-json", "-q"] };

// The grype database is 3 GB and needs the network to update. An operator runs
// refresh-db.mjs once. A scan never downloads. No database means a coverage gap.
export const grypeDbDir = () => process.env.TOUCHSTONE_GRYPE_DB || join(homedir(), ".cache", "touchstone", "grype-db");
const GRYPE_MARKER = "6/vulnerability.db";
export const grypeDbReady = () => existsSync(join(grypeDbDir(), GRYPE_MARKER));

// Hard link the cache into the scan dir. Copy only when the link is not possible.
function stageGrypeDb(dir) {
  const src = join(grypeDbDir(), "6"), dst = join(dir, ".scanner-db/grype/6");
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)) {
    try { linkSync(join(src, name), join(dst, name)); } catch { copyFileSync(join(src, name), join(dst, name)); }
  }
}

function safeFile(raw, files) {
  const file = String(raw ?? "").replace(/^file:\/\//, "").replace(/^\/work\//, "").replace(/^\.\//, "");
  return Object.hasOwn(files, file) ? file : null;
}
function lead(engine, check, file, line, snapshot, { secret, impact = "Medium", ...extra } = {}) {
  if (!file || !Number.isInteger(line) || line < 1 || line > snapshot.files[file].split("\n").length || !/^[A-Za-z0-9_./-]+$/.test(check)) return null;
  const summary = secret ? redactSecret(secret) : undefined;
  return { engine, check, impact, file, lines: [line], where: { file, line, rule: check, ...(summary ? { fingerprint: summary.sha256 } : {}) },
    description: `${engine} reported ${check}. This is an offline lead, not a live credential or exploit claim.`,
    ...(summary ? { secret: summary } : {}), ...extra };
}

export async function scanSnapshot(snapshot, engine) {
  const spec = SCANNERS[engine];
  if (!spec) throw new Error("Unknown scanner");
  const dir = mkdtempSync(join(tmpdir(), "touchstone-scan-"));
  try {
    for (const [file, content] of Object.entries(snapshot.files)) {
      // A target repo can commit its own .touchstone.json. Do not stage it: in
      // a scratch dir it could look like a run's config. Skip it; do not throw.
      if (posix.basename(file) === ".touchstone.json") continue;
      if (posix.isAbsolute(file) || posix.normalize(file) !== file || file.split("/").some((s) => s === ".." || s === ".git") || file.startsWith(".scanner-db/") || file.startsWith(".scanner-rules/") || file === ".scanner-sbom.json") throw new Error("Invalid snapshot file");
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), content, { mode: 0o600 });
    }
    // The advisory slice is part of the pinned snapshot. No database downloads.
    if (engine === "osv") {
      mkdirSync(join(dir, ".scanner-db/osv-scalibr/npm"), { recursive: true });
      writeFileSync(join(dir, ".scanner-db/osv-scalibr/npm/all.zip"), Buffer.from(snapshot.npmAdvisories, "base64"));
    }
    if (engine === "semgrep") {
      mkdirSync(join(dir, ".scanner-rules"), { recursive: true });
      const rules = new URL("./rules/", import.meta.url);
      // Semgrep skips node_modules by default. Vendored code is where this attack lives.
      writeFileSync(join(dir, ".semgrepignore"), ".scanner-rules/\n.scanner-db/\n.scanner-sbom.json\n");
      for (const name of readdirSync(rules).filter((n) => n.endsWith(".yml"))) writeFileSync(join(dir, ".scanner-rules", name), readFileSync(new URL(name, rules)));
    }
    if (engine === "grype") {
      if (!grypeDbReady()) return { engine, status: "gap", reason: "grype database missing. Run refresh-db.mjs.", leads: [] };
      stageGrypeDb(dir);
      const sbom = await runTool({ ...SYFT, ws: dir, env: { HOME: "/tmp", XDG_CACHE_HOME: "/tmp", SYFT_CHECK_FOR_APP_UPDATE: "false" }, timeoutMs: 120_000 });
      if (sbom.timedOut || sbom.code !== 0) return { engine, status: "error", code: sbom.code, timedOut: sbom.timedOut, leads: [] };
      writeFileSync(join(dir, ".scanner-sbom.json"), sbom.stdout, { mode: 0o600 });
    }
    let cmd = spec.cmd;
    // Zizmor exits with an error when there is nothing to audit. That is a scope fact, not a scanner failure.
    if (engine === "zizmor" && !Object.keys(snapshot.files).some((f) => /(^|\/)(\.github\/workflows\/[^/]+\.ya?ml|action\.ya?ml|dependabot\.ya?ml)$/.test(f))) return { engine, status: "ok", code: 0, timedOut: false, reason: "no workflow or action files in snapshot", leads: [] };
    if (engine === "osv") {
      const locks = Object.keys(snapshot.files).filter((f) => /(^|\/)package-lock\.json$/.test(f) && !/(^|\/)node_modules\//.test(f)).slice(0, 25);
      // No npm lockfile is a finding about scope, not a scanner error.
      if (!locks.length) return { engine, status: "ok", code: 0, timedOut: false, reason: "no package-lock.json in snapshot", leads: [] };
      cmd = [...cmd, ...locks.flatMap((f) => ["--lockfile", f])];
    }
    // Poutine reads only the workflows of the folder it is given. A GitHub capture
    // of several repos keeps each under "<owner>/<repo>/", so poutine runs once per repo.
    const roots = engine === "poutine" && (snapshot.github?.repos?.length ?? 0) > 1 ? snapshot.github.repos.map((x) => x.repo) : [null];
    const runs = [];
    for (const root of roots) {
      const r = await runTool({ ...spec, cmd: root ? cmd.map((c) => (c === "." ? root : c)) : cmd, ws: dir, env: { HOME: "/tmp", XDG_CACHE_HOME: "/tmp", OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: "/work/.scanner-db", POUTINE_DISABLE_VERSION_CHECK: "1", GRYPE_DB_CACHE_DIR: "/work/.scanner-db/grype", GRYPE_DB_AUTO_UPDATE: "false", GRYPE_DB_VALIDATE_AGE: "false", GRYPE_CHECK_FOR_APP_UPDATE: "false", GITLEAKS_CONFIG_TOML: readFileSync(new URL("./gitleaks.toml", import.meta.url), "utf8") }, timeoutMs: 120_000 });
      if (r.timedOut || ![0, ...(engine === "osv" ? [1] : [])].includes(r.code)) return { engine, status: "error", code: r.code, timedOut: r.timedOut, leads: [] };
      runs.push({ r, root });
    }
    const { r } = runs[0];
    let leads;
    if (engine === "zizmor" || engine === "poutine") {
      leads = runs.flatMap(({ r, root }) => sarifLeads(r.stdout, engine).map((l) => lead(engine, l.check, safeFile(l.file, snapshot.files) ?? (root ? safeFile(`${root}/${l.file}`, snapshot.files) : null), l.lines[0], snapshot, { impact: l.impact })));
    } else if (engine === "gitleaks") {
      leads = JSON.parse(r.stdout).map((l) => lead(engine, l.RuleID, safeFile(l.File, snapshot.files), l.StartLine, snapshot, { secret: l.Secret, impact: "High" }));
    } else if (engine === "trufflehog") {
      leads = r.stdout.trim().split("\n").filter(Boolean).map((s) => {
        const l = JSON.parse(s), loc = l.SourceMetadata?.Data?.Filesystem;
        return lead(engine, l.DetectorName, safeFile(loc?.file, snapshot.files), loc?.line, snapshot, { secret: l.Raw, impact: "High" });
      });
    } else if (engine === "semgrep") {
      // Semgrep prefixes the rule id with the rules folder path. Keep our id.
      leads = sarifLeads(r.stdout, engine).map((l) => lead(engine, l.check.replace(/^.*?(touchstone-[A-Za-z0-9-]+)$/, "$1"), safeFile(l.file, snapshot.files), l.lines[0], snapshot, { impact: l.impact }));
    } else if (engine === "grype") {
      leads = [];
      for (const m of JSON.parse(r.stdout).matches ?? []) {
        const name = m.artifact?.name, version = m.artifact?.version;
        const file = (m.artifact?.locations ?? []).map((x) => safeFile(String(x.path ?? "").replace(/^\//, ""), snapshot.files)).find(Boolean) ?? null;
        const text = file ? snapshot.files[file].split("\n") : [];
        const at = text.findIndex((t) => t.includes(JSON.stringify(`node_modules/${name}`)));
        const line = at >= 0 ? at + 1 : text.findIndex((t) => t.includes(name)) + 1 || 1;
        leads.push(lead(engine, m.vulnerability?.id, file, line, snapshot, { package: name, version, impact: { Critical: "High", High: "High", Medium: "Medium", Low: "Low" }[m.vulnerability?.severity] ?? "Medium" }));
      }
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
    return { ok: r.status === "ok" && r.leads.some((l) => l.file === where?.file && l.lines[0] === where?.line && l.check === where?.rule && l.where.fingerprint === where?.fingerprint) };
  }]));
}
