// chain-bench in capture mode for the supply-chain pack (opt-in: networkTools).
//
// chain-bench v0.1.10 checks one repository against the CIS software supply
// chain benchmark through the GitHub API. Upstream takes the token only as the
// flag -t, so the pack builds its own image (images/chain-bench) whose main
// reads it from SCM_TOKEN. The capture passes SCM_TOKEN by name (`-e SCM_TOKEN`,
// lib/capture.mjs), so the token is in no argv: not the docker command, not
// chain-bench's own process (test: supply-chain-chain-bench-env.test.mjs).
//
// Same gate as Scorecard and Legitify: the run's own scope and grant, one
// repository, read-only, GitHub API egress only. The report goes to a scratch
// folder, is read back, and is dropped if it holds any part of the token.
// Fail closed: no target, no token, a refused capture, a timeout, a non-zero
// exit, or a report that is not chain-bench's JSON for this repository is
// "unavailable", never a clean result.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { cleanOutput, holdsSecret, LEAK_REASON, runCapture } from "../../lib/capture.mjs";
import { sha256 } from "../../lib/proof-evidence.mjs";

export const CHAIN_BENCH = {
  image: "touchstone/chain-bench:0.1.10-env",
  version: "v0.1.10",
  // `scan` only reads. The report file is chain-bench's own JSON (no template).
  cmd: (t) => ["scan", "--repository-url", `https://github.com/${t.owner}/${t.repo}`, "--output-file", "/work/chain-bench.json", "--quiet", "--no-color"],
  report: "chain-bench.json",
  hosts: ["api.github.com"],
  // Read by the image's main, never put on a command line.
  secret: "SCM_TOKEN",
};
const MAX_REPORT = 4 * 1024 * 1024;

const now = () => new Date().toISOString();
const imageId = (image) => { try { return execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", image], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };
const unavailable = (reason, extra = {}) => ({ tool: "chain-bench", mode: "api", status: "unavailable", reason, sha256: sha256(""), text: "", capturedAt: now(), ...extra });

// chain-bench's report, or null when it is not one: { metadata, results: [] }
// with at least one result.
export function parseChainBench(text) {
  try {
    const j = JSON.parse(text);
    return j && typeof j === "object" && j.metadata && Array.isArray(j.results) && j.results.length > 0 ? j : null;
  } catch { return null; }
}

// A short reason from the run. Raw stderr is saved (scrubbed) beside it.
export function chainBenchReason(r, report) {
  if (r.refused) return `not covered: capture refused: ${r.refused}`;
  if (r.timedOut) return "timed out";
  const e = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  if (/\b401\b|Bad credentials/.test(e)) return "token rejected (401)";
  if (/rate limit/i.test(e)) return "rate limited";
  if (/\b404\b|Not Found/.test(e)) return "repo unreachable (404): the token cannot read this repo, or it does not exist";
  if (/proxyconnect|scope-gate|blocked/i.test(e)) return "blocked by the egress allow-list";
  if (r.code !== 0) return `tool exited ${r.code}`;
  if (!report) return "no report: the output file is missing, empty or not chain-bench's JSON";
  return "unusable report";
}

//   target   { owner, repo }
//   scopeId  the run's own saved scope; runCapture checks it and its own grant
//   token    GITHUB_TOKEN value; never stored, never in argv
// capture is a seam for tests.
export async function captureChainBench({ target = null, scopeId = null, token = process.env.GITHUB_TOKEN, capture = runCapture } = {}) {
  if (!target?.repo) return unavailable("no GitHub repo target for the capture");
  if (!token) return unavailable("no GITHUB_TOKEN: chain-bench needs a token");
  const cmd = CHAIN_BENCH.cmd(target);
  const ws = mkdtempSync(join(tmpdir(), "touchstone-chain-bench-"));
  try {
    const r = await capture({ image: CHAIN_BENCH.image, cmd, ws, env: { HOME: "/tmp" }, timeoutMs: 300_000,
      scopeId, targets: [{ owner: target.owner, repo: target.repo }], hosts: CHAIN_BENCH.hosts, secrets: { [CHAIN_BENCH.secret]: token } });
    let file = "";
    try { file = readFileSync(join(ws, CHAIN_BENCH.report), "utf8").slice(0, MAX_REPORT); } catch { /* no report */ }
    // Any part of the token in any output drops all of it.
    const c = cleanOutput(r, [token]);
    const leaked = r.leaked ?? c.leaked ?? (holdsSecret(file, [token]) ? LEAK_REASON : null);
    const text = leaked ? "" : file;
    const report = parseChainBench(text);
    const want = `https://github.com/${target.owner}/${target.repo}`;
    const forTarget = report?.metadata?.url === want;
    const ran = !leaked && !r.refused && !r.timedOut && r.code === 0 && Boolean(report) && forTarget;
    const reason = leaked ?? (report && !forTarget ? `report is for ${String(report.metadata?.url).slice(0, 80)}, not ${want}` : chainBenchReason({ ...r, ...c }, report));
    return { tool: "chain-bench", mode: "api", image: CHAIN_BENCH.image, imageId: imageId(CHAIN_BENCH.image), cmd, status: ran ? "ran" : "unavailable", code: r.code, timedOut: Boolean(r.timedOut),
      sha256: sha256(text), text, stderr: leaked ? "" : c.stderr.slice(0, 8192), ...(ran ? {} : { reason }), ...(r.refused ? { gapKind: "not-covered-capture-refused" } : {}), ...(r.egress ? { egress: r.egress } : {}),
      capturedAt: now(), target: `${target.owner}/${target.repo}` };
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

// ---- Leads, coverage and gaps from the saved capture (checked against one
// real run; the test fixture is synthetic, in the same shape).
//
// A Failed rule is a repository setting only the tool can see: an unproven lead
// that replay never confirms (the detector below). An Unknown rule is a gap,
// grouped by chain-bench's own reason ("Repository is missing minimal
// permissions" means the token lacks admin read; the pack never asks for it).
// A Passed rule gives nothing. A capture that did not run, or whose bytes no
// longer match their SHA-256, is "unavailable" and a gap.
const slug = (s) => String(s).replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-|-$/g, "");
export function chainBenchFrom(snapshot) {
  const cap = snapshot.captures?.["chain-bench"];
  if (!cap) return { leads: [], coverage: [], gaps: [] };
  const fail = (reason, kind) => ({ leads: [], coverage: [{ engine: "chain-bench", status: "unavailable", code: cap.code ?? null, timedOut: Boolean(cap.timedOut), reason, leads: 0 }],
    gaps: [{ kind: kind ?? (/^not covered: /.test(reason) ? "not-covered-needs-token" : "networked-tool-unavailable"), detail: `chain-bench is unavailable: ${reason}. Its CIS supply chain checks were not run. This is not a clean result.` }] });
  if (cap.status !== "ran") return fail(cap.reason ?? "not captured", cap.gapKind);
  if (sha256(cap.text ?? "") !== cap.sha256) return fail("saved output does not match its SHA-256");
  const report = parseChainBench(cap.text);
  if (!report) return fail("unparsable report");
  if (report.metadata?.url !== `https://github.com/${cap.target}`) return fail(`report is for ${String(report.metadata?.url).slice(0, 80)}, not ${cap.target}`);
  const leads = [], gaps = [], unknown = new Map();
  for (const r of report.results) {
    const id = String(r?.id ?? "").slice(0, 20);
    if (r?.result === "Failed") {
      leads.push({ engine: "chain-bench", check: `chain-bench/${slug(id)}`, impact: "Low", file: null, lines: [], rootCause: `chain-bench:${id}`,
        where: { capture: "api", sha256: cap.sha256, check: id },
        description: `chain-bench ${CHAIN_BENCH.version} (CIS software supply chain benchmark) reported rule ${id} failed: ${String(r.name ?? "").slice(0, 120)} (severity ${String(r.severity ?? "unknown").slice(0, 20)}). This is a repo setting seen only by the tool. Replay cannot confirm it from pinned files, so it stays an unproven lead.` });
    } else if (r?.result !== "Passed") {
      const why = String(r?.reason || `result ${String(r?.result).slice(0, 20)}`).slice(0, 120);
      unknown.set(why, [...(unknown.get(why) ?? []), id]);
    }
  }
  for (const [why, ids] of unknown) {
    const scope = /missing minimal permissions/i.test(why);
    gaps.push({ kind: scope ? "not-covered-needs-scope" : "chain-bench-check-unknown",
      detail: `chain-bench could not check ${ids.length} rule${ids.length === 1 ? "" : "s"} (${ids.join(", ")}): ${why}${scope ? ". The token has no admin read on the repo; the pack never asks for it" : ""}. Not a clean result.` });
  }
  const unchecked = [...unknown.values()].reduce((n, ids) => n + ids.length, 0);
  const total = report.results.length;
  if (unchecked === total) return { leads: [], gaps, coverage: [{ engine: "chain-bench", status: "unavailable", code: cap.code, timedOut: false, reason: `all ${total} rules unchecked`, leads: 0 }] };
  return { leads, gaps, coverage: [{ engine: "chain-bench", status: "ok", code: cap.code, timedOut: false, ...(unchecked ? { reason: `${unchecked} of ${total} rules unchecked` } : {}), leads: leads.length }] };
}

// Replay: a chain-bench lead is a repo setting only the tool can see. The pinned
// files cannot show it, so replay never confirms it.
export const chainBenchDetectors = () => ({ "tool:chain-bench": () => ({ ok: false }) });
