// Networked tools that cannot give a lead today. Each one fails closed: an
// opt-in gives coverage "unavailable" and a gap that says why. Never a clean
// result, never a lead, never a proof. networked.mjs calls this file.
//
// Legitify runs in capture mode (runCapture, lib/capture.mjs). Its raw output is saved with
// its SHA-256. No lead parser exists yet: the pack has never seen a real
// successful Legitify result (it rejects the fine-grained token it was given),
// so a parser would be a guess. A run that prints output is still a gap.
import { execFileSync } from "node:child_process";
import { cleanOutput, runCapture } from "../../lib/capture.mjs";
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

// chain-bench left this file: its image reads the token from SCM_TOKEN, so it
// runs in capture mode (chain-bench.mjs).

// raven (raven-cycode 1.0.9) is not wired. Reading its source (src/cmdline.py,
// src/downloader): `download` takes the token as argv `--token` (fixable the
// way chain-bench was: Python can set sys.argv in the process), but three
// blockers remain, and they are why it stays blocked:
//   - no single-repository mode: `download account` reads every repository of
//     a user or organization, and `download crawl` reads public repositories by
//     star count. The grant names one repository.
//   - it stores workflows in Redis and indexes them in Neo4j (`index`, `report`):
//     two servers the capture boundary does not run.
//   - it fetches each workflow file from its download_url on
//     raw.githubusercontent.com, outside the capture allow-list (api.github.com).
export const RAVEN = {
  version: "1.0.9",
  reason: "not covered: raven 1.0.9 has no single-repository mode (it reads a whole account, or crawls public repositories), needs Redis plus Neo4j servers, and fetches workflow files from raw.githubusercontent.com outside the capture allow-list; it is never run",
};

const now = () => new Date().toISOString();
const imageId = (image) => { try { return execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", image], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };
const unavailable = (tool, reason, extra = {}) => ({ tool, mode: "api", status: "unavailable", reason, sha256: sha256(""), text: "", capturedAt: now(), ...extra });

// A short reason from Legitify's stderr. Raw stderr is saved (scrubbed) beside it.
export function legitifyReason(r) {
  if (r.refused) return `not covered: capture refused: ${r.refused}`;
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

//   scopeId  the run's own saved scope; runCapture checks it and its own grant
// capture is a seam for tests.
export async function captureLegitify({ target = null, scopeId = null, token = process.env.GITHUB_TOKEN, capture = runCapture } = {}) {
  if (!target?.repo) return unavailable("legitify", "no GitHub repo target for the capture");
  if (!token) return unavailable("legitify", "no GITHUB_TOKEN: Legitify needs a token");
  const cmd = LEGITIFY.cmd(target);
  const r = await capture({ image: LEGITIFY.image, cmd, env: { HOME: "/tmp" }, timeoutMs: 300_000,
    scopeId, targets: [{ owner: target.owner, repo: target.repo }], hosts: LEGITIFY.hosts, secrets: { [LEGITIFY.secret]: token } });
  // Output that still holds part of the token after the scrub is dropped.
  const c = cleanOutput(r, [token]);
  const leaked = r.leaked ?? c.leaked;
  const text = leaked ? "" : c.stdout;
  // Only exit 0 with output is a run. No real run has shown an "issues found" exit.
  const ran = !leaked && !r.refused && !r.timedOut && r.code === 0 && text.trim().length > 0;
  return { tool: "legitify", mode: "api", image: LEGITIFY.image, imageId: imageId(LEGITIFY.image), cmd, status: ran ? "ran" : "unavailable", code: r.code, timedOut: Boolean(r.timedOut),
    sha256: sha256(text), text, stderr: leaked ? "" : c.stderr.slice(0, 8192), ...(ran ? {} : { reason: leaked ?? legitifyReason({ ...r, stderr: c.stderr }) }), ...(r.refused ? { gapKind: "not-covered-capture-refused" } : {}), ...(r.egress ? { egress: r.egress } : {}),
    capturedAt: now(), target: `${target.owner}/${target.repo}` };
}

export async function captureBlocked(tool, opts) {
  if (tool === "legitify") return captureLegitify(opts);
  if (tool === "raven") return unavailable("raven", RAVEN.reason, { gapKind: "not-covered-tool-scope" });
  throw new Error(`Unknown networked tool ${tool}`);
}

const CHECKS = {
  legitify: "repository policies (branch protection, review rules, actions permissions, secret scanning settings)",
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
