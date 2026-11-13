import { rmSync } from "node:fs";
import { makeLabWorkspace } from "./lab.mjs";
import { runTool, sarifLeads } from "../../lib/wrap.mjs";
const ws = await makeLabWorkspace();
try {
  const tools = [
    ["zizmor", "ghcr.io/zizmorcore/zizmor:1.32.0@sha256:3014cc8f68f663935f69b3c3e0e41f5ce102b268d97db13db0f62208747f860d", ["--offline", "--no-config", "--no-ignores", "--persona", "pedantic", "--format", "sarif", "--no-exit-codes", "."]],
    ["poutine", "ghcr.io/boostsecurityio/poutine:1.1.6@sha256:722a8e0999b583c1540fe2974e691032b2d9d21b9256a17965132b6bfd0081b0", ["analyze_local", ".", "--format", "sarif"]],
    ["gitleaks", "ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f", ["dir", ".", "--no-banner", "--report-format", "json", "--report-path", "/dev/stdout", "--exit-code", "0"]],
    ["trufflehog", "trufflesecurity/trufflehog:3.99.8@sha256:674b2f187620a19df77f44cf9a7d77efcc581a5662accef2f2739cbb46ba4a3a", ["filesystem", "/work", "--json", "--no-verification", "--no-update"]],
    ["kingfisher", "ghcr.io/mongodb/kingfisher:2.18.1@sha256:e5cb2daee5521ad68f15f695c510fa87c1eefaa87103f13137cfb8420067700b", ["--no-update-check", "scan", ".", "--no-validate", "--git-history", "none", "--format", "json", "--redact", "--no-rule-cache"]],
  ];
  for (const [name, image, cmd] of tools) {
    const r = await runTool({ image, cmd, ws, env: { HOME: "/tmp", XDG_CACHE_HOME: "/tmp" } });
    let summary;
    try {
      if (["zizmor", "poutine"].includes(name)) summary = sarifLeads(r.stdout, name).map(({ check, file, lines }) => ({ check, file, lines }));
      if (name === "gitleaks") summary = JSON.parse(r.stdout).map(({ RuleID, File, StartLine }) => ({ check: RuleID, file: File, line: StartLine }));
      if (name === "trufflehog") summary = r.stdout.trim().split("\n").filter(Boolean).map((s) => { const a = JSON.parse(s); return { check: a.DetectorName, file: a.SourceMetadata?.Data?.Filesystem?.file, line: a.SourceMetadata?.Data?.Filesystem?.line }; });
      if (name === "kingfisher") summary = r.stdout.trim().split("\n").filter(Boolean).map((s) => { const a = JSON.parse(s); return { keys: Object.keys(a), count: typeof a.findings === "number" ? a.findings : undefined, rules: a.findings_by_rule?.map((f) => f.rule_id) }; });
    } catch { summary = { parseError: true, stdoutBytes: r.stdout.length }; }
    // Raw scanner stdout/stderr may contain secrets. Never log either.
    console.log(JSON.stringify({ name, code: r.code, timedOut: r.timedOut, summary }));
  }
} finally { rmSync(ws, { recursive: true, force: true }); }
