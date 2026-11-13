// Networked tools for the supply-chain pack. Opt-in only: `.touchstone.json`
// sets `networkTools: ["scorecard", ...]`. With no opt-in nothing here runs.
//
// The proof model does not change. A networked tool runs ONCE, in a capture
// step, before the snapshot is pinned (runTool capture mode, lib/capture.mjs:
// grant check, GitHub-only egress, token by env name). Its raw output is saved
// in the snapshot with its SHA-256. Leads are derived from those saved bytes.
// Replay never reruns the tool and never touches the network: the detector
// re-parses the saved bytes, then checks the claim against the pinned files.
// A claim that only the tool can see (a repo setting) never passes replay.
//
// Fail closed: no grant, no token, no target, a refused capture, a tool error,
// a timeout, empty or unparsable output all give status "unavailable" and a
// gap. Never a clean result.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { execFileSync } from "node:child_process";
import { runTool } from "../../lib/wrap.mjs";
import { scrub } from "../../lib/capture.mjs";
import { loadSnapshot, pinSnapshot, sha256 } from "../../lib/proof-evidence.mjs";
import { githubTarget } from "../../lib/scopes-store.mjs";
import { captureSnapshot } from "./snapshot.mjs";
import { captureGithub } from "./github.mjs";
import { captureBlocked, blockedFrom } from "./networked-blocked.mjs";

// Scorecard v5.6.0, built locally from the release tarball checked by SHA-256
// (images/scorecard/Dockerfile). The CLI has no write flags: it only reads.
export const SCORECARD = {
  image: "touchstone/scorecard:5.6.0",
  version: "v5.6.0",
  // Offline: the file checks on the pinned snapshot, `--network none`.
  local: ["--local=.", "--format=json", "--show-details"],
  // Capture: the repo-setting checks through the GitHub API.
  api: (t, commit) => [`--repo=github.com/${t.owner}/${t.repo}`, ...(commit ? [`--commit=${commit}`] : []), "--format=json", "--show-details"],
  hosts: ["api.github.com", "codeload.github.com"],
};

// Checks Scorecard can only answer through the API (or another live service).
// Local mode either skips them or answers them with no data (SAST says "no pull
// requests merged"). They come from the API capture only.
export const API_CHECKS = ["Branch-Protection", "CI-Tests", "CII-Best-Practices", "Code-Review", "Contributors", "Maintained", "Packaging", "SAST", "Signed-Releases", "Webhooks", "Fuzzing"];
// File checks whose claim the detector re-checks on the pinned files.
const FILE_CHECKS = ["Pinned-Dependencies", "License", "Security-Policy", "Dependency-Update-Tool"];
// Checks the pack reads elsewhere or cannot trust. They are named as gaps.
const NOT_USED = { Vulnerabilities: "it needs api.osv.dev, which no run may reach, and with no network it still reports 0 vulnerabilities. The osv and grype scanners cover locked dependencies",
  "Binary-Artifacts": "it ran on the snapshot's text files, and the snapshot skips binaries. See the skipped list",
  "Dangerous-Workflow": "the offline zizmor and poutine scanners read the workflows", "Token-Permissions": "the offline zizmor scanner reads workflow permissions" };
// Checks that need a fine-grained token permission beyond Contents/Metadata read.
// The pack never asks for more: a missing one is a "not covered" gap.
const ADMIN_SCOPES = { "Branch-Protection": "Administration: read", Webhooks: "Webhooks: read" };

// legitify runs but always fails closed (networked-blocked.mjs): it saves its
// output, and no lead comes from it until a parser is checked on a real run.
// chain-bench is never run: an opt-in gives a gap (token only in argv).
export const NETWORKED_TOOLS = ["scorecard", "legitify", "chain-bench"];

const now = () => new Date().toISOString();
const imageId = (image) => { try { return execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", image], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };

// Write the snapshot's files to a scratch dir, with the same path rules as the
// offline scanners. A target's own .touchstone.json is not staged.
function stage(snapshot) {
  const dir = mkdtempSync(join(tmpdir(), "touchstone-net-"));
  for (const [file, content] of Object.entries(snapshot.files)) {
    if (posix.basename(file) === ".touchstone.json") continue;
    if (posix.isAbsolute(file) || posix.normalize(file) !== file || file.split("/").some((s) => s === ".." || s === ".git")) throw new Error("Invalid snapshot file");
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), content, { mode: 0o600 });
  }
  return dir;
}

// Turn a tool's stderr into a short reason. Never copy raw stderr into a reason:
// stderr is saved (scrubbed) next to it for a human to read.
export function scorecardReason(r) {
  if (r.refused) return `capture refused: ${r.refused}`;
  if (r.timedOut) return "timed out";
  const e = String(r.stderr ?? "");
  if (/\b404 Not Found\b|repo unreachable/.test(e)) return "repo unreachable (404): the token cannot read this repo, or it does not exist";
  if (/\b401\b|Bad credentials/.test(e)) return "token rejected (401)";
  if (/rate limit/i.test(e)) return "rate limited";
  if (/\b403\b/.test(e)) return "forbidden (403): the token lacks a needed permission";
  if (/blocked|scope-gate|proxyconnect/i.test(e)) return "blocked by the egress allow-list";
  if (r.code !== 0 && String(r.stdout ?? "").trim()) return `tool exited ${r.code}, which is not a documented Scorecard exit; its output is not used`;
  return `tool exited ${r.code} with no usable output`;
}

// Scorecard v5.6.0 exit codes. 0: every check ran. 1 with "one or more checks
// failed during execution": it still printed the JSON, and at least one check
// has score -1 and an "internal error" reason (seen in the real --local run:
// Fuzzing has no network). Any other code, or 1 without both, is a failed run.
const checkErrored = (json) => Array.isArray(json?.checks) && json.checks.some((c) => c?.score === -1 && /internal error/i.test(String(c.reason ?? "")));
export function scorecardExitOk(code, stderr, json) {
  if (code === 0) return true;
  return code === 1 && /one or more checks failed during execution/.test(String(stderr ?? "")) && checkErrored(json);
}

// hide: secret values to strip from anything saved. Capture mode already scrubs
// its own output; this also covers the offline run, which never gets the token.
function record(mode, cmd, image, r, extra = {}, hide = []) {
  const text = scrub(r.stdout, hide);
  const ran = !r.refused && !r.timedOut && text.trim().length > 0 && scorecardExitOk(r.code, r.stderr, parse(text));
  return { tool: "scorecard", mode, image, imageId: imageId(image), cmd, status: ran ? "ran" : "unavailable", code: r.code, timedOut: Boolean(r.timedOut),
    sha256: sha256(text), text, stderr: scrub(r.stderr, hide).slice(0, 8192), ...(ran ? {} : { reason: scorecardReason(r) }), ...(r.egress ? { egress: r.egress } : {}), capturedAt: now(), ...extra };
}
const unavailable = (mode, reason) => ({ tool: "scorecard", mode, status: "unavailable", reason, sha256: sha256(""), text: "", capturedAt: now() });

// Run Scorecard for one snapshot. Returns { local, api } capture records.
//   target   { owner, repo } for the API capture, or null (no API capture)
//   reach    the operator grant; capture mode re-checks it
//   token    GITHUB_TOKEN value; never stored, never in argv
// run is a seam for tests.
export async function captureScorecard(snapshot, { target = null, reach, token = process.env.GITHUB_TOKEN, run = runTool } = {}) {
  let local;
  let dir;
  try {
    dir = stage(snapshot);
    // runTool's plain path: `--network none`. A timeout is `unavailable`.
    const r = await run({ image: SCORECARD.image, cmd: SCORECARD.local, ws: dir, env: { HOME: "/tmp", XDG_CACHE_HOME: "/tmp" }, timeoutMs: 180_000 });
    local = record("local", SCORECARD.local, SCORECARD.image, r, {}, [token]);
  } catch (err) { local = unavailable("local", `local run failed: ${scrub(err.message, [token]).slice(0, 200)}`); }
  finally { if (dir) rmSync(dir, { recursive: true, force: true }); }

  let api;
  if (!target?.repo) api = unavailable("api", "no GitHub repo target for the API capture");
  else if (!token) api = unavailable("api", "no GITHUB_TOKEN: Scorecard needs a token for the API capture");
  else {
    // Read the pinned commit, so the API result is about the same code. A local
    // commit that GitHub does not have makes the capture fail closed.
    const cmd = SCORECARD.api(target, /^[0-9a-f]{40}$/.test(snapshot.commit ?? "") ? snapshot.commit : null);
    const r = await run({ image: SCORECARD.image, cmd, env: { HOME: "/tmp", XDG_CACHE_HOME: "/tmp" }, timeoutMs: 300_000,
      capture: { reach, targets: [{ owner: target.owner, repo: target.repo }], hosts: SCORECARD.hosts, secrets: { GITHUB_TOKEN: token } } });
    api = record("api", cmd, SCORECARD.image, r, { target: `${target.owner}/${target.repo}` }, [token]);
  }
  return { local, api };
}

// Load the pin, or build the base snapshot, add the networked captures, and pin
// it. A pinned snapshot is never recaptured: replay reads the saved bytes.
export async function prepareNetworkedSnapshot(ws, cfg, { source = ws, worktree = false, token = process.env.GITHUB_TOKEN, run = runTool, base = null } = {}) {
  try { return loadSnapshot(ws); }
  catch (err) { if (err.code !== "ENOENT" && !String(err.message).includes("Missing snapshot SHA-256 pin")) throw err; }
  const tools = cfg.networkTools ?? [];
  for (const t of tools) if (!NETWORKED_TOOLS.includes(t)) throw new Error(`Unknown networked tool ${t}`);
  const list = cfg.github ? (Array.isArray(cfg.github) ? cfg.github : [cfg.github]).map(githubTarget) : [];
  const snapshot = base ?? (cfg.github ? await captureGithub(list, { reach: cfg.reach, token }) : captureSnapshot(source, { worktree }));
  // The API capture reads one repo: the live target, or `networkTarget` for a folder run.
  const named = list.length ? list : cfg.networkTarget ? [githubTarget(cfg.networkTarget)] : [];
  const target = named.find((t) => t.repo) ?? null;
  const captures = {};
  if (tools.includes("scorecard")) captures.scorecard = await captureScorecard(snapshot, { target, reach: cfg.reach, token, run });
  for (const t of tools) if (t !== "scorecard") captures[t] = await captureBlocked(t, { target, reach: cfg.reach, token, run });
  if (named.length > 1) captures.notes = [`networked tools read only ${target ? `${target.owner}/${target.repo}` : "no repo"}; ${named.length - 1} other targets were not captured`];
  const out = { ...snapshot, captures };
  return { snapshot: out, snapshotHash: pinSnapshot(ws, out) };
}

// ---- Derive leads from saved bytes ----

const PIN_RE = /^Warn: (.+?) not pinned by hash: (.+):(\d+)(?:-(\d+))?$/;
// A report with no checks array, or an empty one, is unparsable, not clean.
const parse = (text) => { try { const j = JSON.parse(text); return j && Array.isArray(j.checks) && j.checks.length > 0 ? j : null; } catch { return null; } };
const networkError = (s) => /dial tcp|lookup |network is unreachable|proxyconnect|Forbidden|blocked/i.test(s);
const adminError = (s) => /admin|Resource not accessible|403/i.test(s);
const slug = (s) => String(s).replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-|-$/g, "");

function scorecardLead({ check, kind, file, line, endLine, impact, capture, cap, score }) {
  const where = { capture, sha256: cap.sha256, check, ...(kind ? { kind } : {}), ...(file ? { file, line, ...(endLine ? { endLine } : {}) } : { score }) };
  const label = kind ? `${kind} not pinned by hash` : `${check} scored ${score}/10`;
  const root = kind === "GitHub-owned GitHubAction" || kind === "third-party GitHubAction" ? `action-pins:${file}` : file ? `scorecard-pins:${file}` : `scorecard:${check}`;
  return { engine: "scorecard", check: `scorecard/${check}${kind ? `/${slug(kind)}` : ""}`, impact, file: file ?? null, lines: file ? [line] : [], where, rootCause: root,
    description: `OpenSSF Scorecard ${SCORECARD.version} (${capture} run) reported ${label}. ${file ? "The detector re-checks the pinned file line." : capture === "api" ? "This is a repo setting seen only by the tool. Replay cannot confirm it from pinned files, so it stays an unproven lead." : "The detector re-checks the pinned file list."}` };
}

// Leads, coverage and gaps from one snapshot's saved Scorecard captures.
// The units each run must answer: FILE_CHECKS (local) and API_CHECKS (api). A
// unit with no usable score is a gap, and the coverage row says how many.
export function scorecardFrom(snapshot) {
  const caps = snapshot.captures?.scorecard;
  if (!caps) return { leads: [], coverage: [], gaps: [] };
  const leads = [], coverage = [], gaps = [];
  for (const capture of ["local", "api"]) {
    const cap = caps[capture];
    const engine = `scorecard-${capture}`;
    const json = cap?.status === "ran" && sha256(cap.text) === cap.sha256 ? parse(cap.text) : null;
    const wantRepo = capture === "api" ? `github.com/${cap?.target}` : "file://.";
    const units = capture === "local" ? FILE_CHECKS : API_CHECKS;
    let reason = null;
    if (!json) reason = cap?.reason ?? (cap?.status === "ran" ? "unparsable report: empty, no checks, or not JSON" : "not captured");
    else if (json.scorecard?.version !== SCORECARD.version) reason = "report is not from the pinned Scorecard version";
    else if (json.repo?.name !== wantRepo) reason = `report is for ${String(json.repo?.name).slice(0, 80)}, not ${wantRepo}`;
    else if (!(cap.code === 0 || (cap.code === 1 && checkErrored(json)))) reason = `tool exited ${cap.code}, which is not a documented Scorecard exit`;
    // The API run must have read the pinned commit, or its results are about other code.
    else if (capture === "api" && /^[0-9a-f]{40}$/.test(snapshot.commit ?? "") && json.repo?.commit !== snapshot.commit) reason = `report is for commit ${String(json.repo?.commit).slice(0, 40)}, not the pinned commit ${snapshot.commit}`;
    const results = json ? new Map(json.checks.filter((c) => units.includes(c?.name)).map((c) => [c.name, c])) : new Map();
    if (!reason && results.size === 0) reason = `unparsable report: none of the ${units.length} expected checks has a result`;
    if (reason) {
      coverage.push({ engine, status: "unavailable", code: cap?.code ?? null, timedOut: Boolean(cap?.timedOut), reason, leads: 0 });
      gaps.push({ kind: "networked-tool-unavailable", detail: `Scorecard ${capture} run is unavailable: ${reason}. ${capture === "api" ? `Its checks (${API_CHECKS.join(", ")}) were not run.` : `Its file checks (${FILE_CHECKS.join(", ")}) were not run.`} This is not a clean result.` });
      continue;
    }
    const before = leads.length;
    const unchecked = [];
    const gap = (name, g) => { unchecked.push(name); gaps.push(g); };
    for (const name of units) {
      const c = results.get(name);
      const why = String(c?.reason ?? "").slice(0, 200);
      if (!c) { gap(name, { kind: "scorecard-check-missing", detail: `Scorecard ${name} (${capture}) has no result in the report. Not a clean result.` }); continue; }
      if (c.score === -1 && /internal error/i.test(why)) {
        const scope = capture === "api" && ADMIN_SCOPES[name] && adminError(why);
        gap(name, scope
          ? { kind: "not-covered-needs-scope", detail: `Scorecard ${name}: not covered: needs scope ${ADMIN_SCOPES[name]} on the repo. The token does not have it.` }
          : { kind: "scorecard-check-error", detail: `Scorecard ${name} (${capture}) did not run${networkError(why) ? ": its host is outside the GitHub-only egress allow-list" : ""}. Not a clean result.` });
        continue;
      }
      if (!(Number.isInteger(c.score) && c.score >= 0 && c.score <= 10)) {
        // -1 without an error is "inconclusive" (for example no workflows to read).
        gap(name, { kind: "scorecard-check-inconclusive", detail: `Scorecard ${name} (${capture}) gave no score (${c.score}): ${why || "no reason"}. Not a clean result.` });
        continue;
      }
      if (name === "Pinned-Dependencies") {
        for (const d of c.details ?? []) {
          const m = String(d).match(PIN_RE);
          if (!m) continue;
          // Bound to this snapshot: a path the snapshot does not hold is a gap, not dropped.
          if (!Object.hasOwn(snapshot.files, m[2])) { gaps.push({ kind: "scorecard-result-outside-snapshot", detail: `Scorecard ${name} (${capture}) named ${m[2].slice(0, 120)}, which is not a file in the pinned snapshot. That result is not used.` }); continue; }
          leads.push(scorecardLead({ check: name, kind: m[1], file: m[2], line: Number(m[3]), endLine: m[4] ? Number(m[4]) : undefined, impact: "Low", capture, cap }));
        }
      } else if (FILE_CHECKS.includes(name) && c.score === 0) {
        leads.push(scorecardLead({ check: name, impact: name === "License" ? "Informational" : "Low", capture, cap, score: 0 }));
      } else if (capture === "api" && c.score < 5) {
        leads.push(scorecardLead({ check: name, impact: "Low", capture, cap, score: c.score }));
      }
    }
    if (capture === "local") {
      // Results that look clean but are not: say so every time.
      for (const [name, why] of Object.entries(NOT_USED)) if (json.checks.some((c) => c?.name === name)) gaps.push({ kind: "scorecard-check-not-trusted", detail: `Scorecard ${name} is not used: ${why}.` });
    }
    if (unchecked.length === units.length) {
      coverage.push({ engine, status: "unavailable", code: cap.code, timedOut: false, reason: `all ${units.length} checks unchecked`, leads: 0 });
      leads.length = before;
      continue;
    }
    coverage.push({ engine, status: "ok", code: cap.code, timedOut: false, ...(unchecked.length ? { reason: `${unchecked.length} of ${units.length} checks unchecked: ${unchecked.join(", ")}` } : {}), leads: leads.length - before });
  }
  return { leads, coverage, gaps };
}

export function networkedResults(snapshot) {
  const out = { leads: [], coverage: [], gaps: [] };
  for (const r of [scorecardFrom(snapshot), blockedFrom(snapshot)]) for (const k of Object.keys(out)) out[k].push(...r[k]);
  for (const note of snapshot.captures?.notes ?? []) out.gaps.push({ kind: "networked-target-not-captured", detail: note });
  return out;
}

// ---- Replay: saved bytes, then the pinned files ----

const lineHas = {
  containerImage: (s) => { const m = s.match(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i); return Boolean(m) && !m[1].includes("@sha256:") && m[1].toLowerCase() !== "scratch"; },
  npmCommand: (s) => /\bnpm\s+(?:install|i|add)\b|\bnpx\s/.test(s),
  pipCommand: (s) => /\bpip3?\s+install\b/.test(s) && !/--require-hashes/.test(s),
  goCommand: (s) => /\bgo\s+(?:install|get)\b/.test(s),
  downloadThenRun: (s) => /\b(?:curl|wget)\b[^|]*\|\s*(?:ba|z)?sh\b/.test(s),
  "third-party GitHubAction": (s) => /\buses:\s*[^\s@]+@(?![0-9a-f]{40}\b)\S+/.test(s),
  "GitHub-owned GitHubAction": (s) => /\buses:\s*[^\s@]+@(?![0-9a-f]{40}\b)\S+/.test(s),
};
const ABSENT = {
  License: /^(?:LICEN[CS]E|COPYING)(?:[.-][^/]*)?$|^LICENSES\//i,
  "Security-Policy": /^(?:\.github\/|docs\/)?SECURITY(?:\.(?:md|markdown|adoc|rst|txt))?$/i,
  "Dependency-Update-Tool": /^(?:\.github\/dependabot\.ya?ml|(?:\.github\/|\.gitlab\/)?renovate\.json5?|\.renovaterc(?:\.json5?)?|\.pyup\.ya?ml|\.lift\.toml)$/i,
};

// True only when the pinned files themselves show the claim.
function pinnedFilesShow(snapshot, where) {
  if (where.capture === "api") return false; // a repo setting: tool-only, never proven
  if (where.file) {
    const check = lineHas[where.kind];
    const text = snapshot.files[where.file];
    if (!check || typeof text !== "string") return false;
    const lines = text.split("\n");
    const end = where.endLine ?? where.line;
    if (!(where.line >= 1 && end >= where.line && end <= lines.length)) return false;
    return lines.slice(where.line - 1, end).some(check);
  }
  const re = ABSENT[where.check];
  if (!re || where.score !== 0) return false;
  // A truncated or capped capture may have missed the file: absence is then unknown.
  if ((snapshot.gaps ?? []).some((g) => ["github-tree-truncated", "github-fetch-capped"].includes(g.kind))) return false;
  const names = [...Object.keys(snapshot.files), ...(snapshot.skipped ?? []).map((s) => s.file)];
  return !names.some((n) => re.test(n));
}

const sameWhere = (a, b) => ["capture", "sha256", "check", "kind", "file", "line", "endLine", "score"].every((k) => a?.[k] === b?.[k]);

export function networkedDetectors() {
  return {
    "tool:scorecard": (snapshot, where) => {
      const cap = snapshot.captures?.scorecard?.[where?.capture];
      if (!cap || cap.status !== "ran" || sha256(cap.text) !== cap.sha256 || cap.sha256 !== where.sha256) return { ok: false };
      if (!scorecardFrom(snapshot).leads.some((l) => sameWhere(l.where, where))) return { ok: false };
      return { ok: pinnedFilesShow(snapshot, where) };
    },
  };
}
