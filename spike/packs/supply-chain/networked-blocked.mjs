// Networked tools that cannot give a lead today. Each one fails closed: an
// opt-in gives coverage "unavailable" and a gap that says why. Never a clean
// result, never a lead, never a proof. networked.mjs calls this file.
//
// Legitify runs in capture mode (lib/capture.mjs). Its raw output is saved with
// its SHA-256. No lead parser exists yet: the pack has never seen a real
// successful Legitify result (it rejects the fine-grained token it was given),
// so a parser would be a guess. A run that prints output is still a gap.
import { execFileSync } from "node:child_process";
import { runTool } from "../../lib/wrap.mjs";
import { cleanOutput } from "../../lib/capture.mjs";
import { sha256 } from "../../lib/proof-evidence.mjs";

// Legitify v1.0.11, built locally from the release tarball checked by SHA-256
// (images/legitify/Dockerfile). `analyze` only reads. The pack never uses
// `gpt-analysis` (it calls OpenAI), `--server-url`, `--ignore-invalid-certificate`
// or `--scorecard yes`. Only the repository namespace runs: the grant names one
// repo, and the target owner is a user account, not an organization.
export const LEGITIFY = {
  image: "touchstone/legitify:1.0.11",
  version: "1.0.11",
  cmd: (t) => ["analyze", "--repo", `${t.owner}/${t.repo}`, "-n", "repository", "-f", "json", "--output-scheme", "flattened",
    "--color", "none", "--scorecard", "no", "-e", "/tmp/legitify-error.log", "--permissions-file", "/tmp/legitify-permissions.json"],
  hosts: ["api.github.com"],
  // Legitify reads its token from SCM_TOKEN (or -t, which the pack never uses).
  secret: "SCM_TOKEN",
};

// chain-bench v0.1.10 (images/chain-bench/Dockerfile) takes the token only as
// the argv flag `-t`: `scan` passes the cobra flag value straight to
// FetchClientData (internal/commands/scan.go). No env var or config key feeds
// it. The token rule forbids a token in argv (docker inspect and ps show it),
// so the pack never runs chain-bench. An opt-in is an honest gap, no docker call.
export const CHAIN_BENCH = {
  image: "touchstone/chain-bench:0.1.10",
  version: "0.1.10",
  reason: "not covered: chain-bench v0.1.10 accepts the token only in argv (-t), which the token rule forbids; it is never run",
};

// raven (raven-cycode 1.0.9) is not wired: `download` takes the token only as
// argv `--token`, it fetches workflow files from raw.githubusercontent.com
// (outside the capture allow-list), and it needs Redis plus Neo4j servers.
export const RAVEN = {
  version: "1.0.9",
  reason: "not covered: raven 1.0.9 takes the token only in argv (--token), reads raw.githubusercontent.com outside the capture allow-list, and needs Redis plus Neo4j; it is never run",
};

const now = () => new Date().toISOString();
const imageId = (image) => { try { return execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", image], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };
const unavailable = (tool, reason, extra = {}) => ({ tool, mode: "api", status: "unavailable", reason, sha256: sha256(""), text: "", capturedAt: now(), ...extra });

// A short reason from Legitify's stderr. Raw stderr is saved (scrubbed) beside it.
export function legitifyReason(r) {
  if (r.refused) return `capture refused: ${r.refused}`;
  if (r.timedOut) return "timed out";
  const e = String(r.stderr ?? "");
  if (/fine-grained tokens are not supported/i.test(e)) return "not covered: needs a classic PAT. Legitify rejects fine-grained tokens (github_pat_) before any request";
  if (/\b401\b|Bad credentials/.test(e)) return "token rejected (401)";
  if (/rate limit/i.test(e)) return "rate limited";
  if (/\b404\b|Not Found/.test(e)) return "repo unreachable (404): the token cannot read this repo, or it does not exist";
  if (/\b403\b|Resource not accessible/i.test(e)) return "forbidden (403): the token lacks a needed permission";
  if (/proxyconnect|scope-gate|blocked/i.test(e)) return "blocked by the egress allow-list";
  if (r.code === 0) return "unparsable report: empty output";
  if (String(r.stdout ?? "").trim()) return `tool exited ${r.code}, which is not an accepted Legitify exit; its output is not used`;
  return `tool exited ${r.code} with no usable output`;
}

export async function captureLegitify({ target = null, reach, token = process.env.GITHUB_TOKEN, run = runTool } = {}) {
  if (!target?.repo) return unavailable("legitify", "no GitHub repo target for the capture");
  if (!token) return unavailable("legitify", "no GITHUB_TOKEN: Legitify needs a token");
  const cmd = LEGITIFY.cmd(target);
  const r = await run({ image: LEGITIFY.image, cmd, env: { HOME: "/tmp" }, timeoutMs: 300_000,
    capture: { reach, targets: [{ owner: target.owner, repo: target.repo }], hosts: LEGITIFY.hosts, secrets: { [LEGITIFY.secret]: token } } });
  // Output that still holds part of the token after the scrub is dropped.
  const c = cleanOutput(r, [token]);
  const leaked = r.leaked ?? c.leaked;
  const text = leaked ? "" : c.stdout;
  // Only exit 0 with output is a run. No real run has shown an "issues found" exit.
  const ran = !leaked && !r.refused && !r.timedOut && r.code === 0 && text.trim().length > 0;
  return { tool: "legitify", mode: "api", image: LEGITIFY.image, imageId: imageId(LEGITIFY.image), cmd, status: ran ? "ran" : "unavailable", code: r.code, timedOut: Boolean(r.timedOut),
    sha256: sha256(text), text, stderr: leaked ? "" : c.stderr.slice(0, 8192), ...(ran ? {} : { reason: leaked ?? legitifyReason({ ...r, stderr: c.stderr }) }), ...(r.egress ? { egress: r.egress } : {}),
    capturedAt: now(), target: `${target.owner}/${target.repo}` };
}

export async function captureBlocked(tool, opts) {
  if (tool === "legitify") return captureLegitify(opts);
  if (tool === "chain-bench") return unavailable("chain-bench", CHAIN_BENCH.reason, { gapKind: "not-covered-token-in-argv" });
  if (tool === "raven") return unavailable("raven", RAVEN.reason, { gapKind: "not-covered-token-in-argv" });
  throw new Error(`Unknown networked tool ${tool}`);
}

const CHECKS = {
  legitify: "repository policies (branch protection, review rules, actions permissions, secret scanning settings)",
  "chain-bench": "CIS software supply chain benchmark (source code, build pipelines, dependencies, artifacts, deployment)",
  raven: "cross-workflow CI/CD graph queries (injection, untrusted checkout, artifact poisoning across workflows)",
};

// Coverage and gaps from the saved captures. Never a lead.
export function blockedFrom(snapshot) {
  const coverage = [], gaps = [];
  for (const tool of Object.keys(CHECKS)) {
    const cap = snapshot.captures?.[tool];
    if (!cap) continue;
    let reason = cap.reason ?? "not captured";
    if (cap.status === "ran") {
      reason = sha256(cap.text ?? "") === cap.sha256
        ? `output saved (sha256 ${cap.sha256.slice(0, 12)}), but no lead parser has been checked against a real ${tool} result, so nothing is derived from it`
        : "saved output does not match its SHA-256";
    }
    coverage.push({ engine: tool, status: "unavailable", code: cap.code ?? null, timedOut: Boolean(cap.timedOut), reason, leads: 0 });
    gaps.push({ kind: cap.gapKind ?? (/^not covered: /.test(reason) ? "not-covered-needs-token" : "networked-tool-unavailable"), detail: `${tool} is unavailable: ${reason}. Its checks (${CHECKS[tool]}) were not run. This is not a clean result.` });
  }
  return { leads: [], coverage, gaps };
}
