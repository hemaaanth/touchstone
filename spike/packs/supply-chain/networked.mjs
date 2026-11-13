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
// Checks that need a fine-grained token permission beyond Contents/Metadata read.
// The pack never asks for more: a missing one is a "not covered" gap.
const ADMIN_SCOPES = { "Branch-Protection": "Administration: read", Webhooks: "Webhooks: read" };

export const NETWORKED_TOOLS = ["scorecard"];

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
  return `tool exited ${r.code} with no usable output`;
}

// hide: secret values to strip from anything saved. Capture mode already scrubs
// its own output; this also covers the offline run, which never gets the token.
function record(mode, cmd, image, r, extra = {}, hide = []) {
  const text = scrub(r.stdout, hide);
  const ran = !r.refused && !r.timedOut && text.trim().length > 0;
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
    const r = await run({ image: SCORECARD.image, cmd: SCORECARD.local, ws: dir, env: { HOME: "/tmp", XDG_CACHE_HOME: "/tmp" }, timeoutMs: 180_000 });
    local = record("local", SCORECARD.local, SCORECARD.image, r, {}, [token]);
  } catch (err) { local = unavailable("local", `local run failed: ${scrub(err.message, [token]).slice(0, 200)}`); }
  finally { if (dir) rmSync(dir, { recursive: true, force: true }); }

  let api;
  if (!target?.repo) api = unavailable("api", "no GitHub repo target for the API capture");
  else if (!token) api = unavailable("api", "no GITHUB_TOKEN: Scorecard needs a token for the API capture");
  else {
    const cmd = SCORECARD.api(target, snapshot.scope === "github-commit" ? snapshot.commit : null);
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
  if (named.length > 1) captures.notes = [`networked tools read only ${target ? `${target.owner}/${target.repo}` : "no repo"}; ${named.length - 1} other targets were not captured`];
  const out = { ...snapshot, captures };
  return { snapshot: out, snapshotHash: pinSnapshot(ws, out) };
}

// ---- Derive leads from saved bytes ----

const PIN_RE = /^Warn: (.+?) not pinned by hash: (.+):(\d+)(?:-(\d+))?$/;
const parse = (text) => { try { const j = JSON.parse(text); return j && Array.isArray(j.checks) ? j : null; } catch { return null; } };
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
export function scorecardFrom(snapshot) {
  const caps = snapshot.captures?.scorecard;
  if (!caps) return { leads: [], coverage: [], gaps: [] };
  const leads = [], coverage = [], gaps = [];
  for (const capture of ["local", "api"]) {
    const cap = caps[capture];
    const engine = `scorecard-${capture}`;
    const json = cap?.status === "ran" && sha256(cap.text) === cap.sha256 ? parse(cap.text) : null;
    const wantRepo = capture === "api" ? `github.com/${cap?.target}` : "file://.";
    if (!json || json.scorecard?.version !== SCORECARD.version || json.repo?.name !== wantRepo) {
      const reason = cap?.reason ?? (cap?.status === "ran" ? "output was empty, unparsable, or not from the pinned Scorecard version" : "not captured");
      coverage.push({ engine, status: "unavailable", code: cap?.code ?? null, timedOut: Boolean(cap?.timedOut), reason, leads: 0 });
      gaps.push({ kind: "networked-tool-unavailable", detail: `Scorecard ${capture} run is unavailable: ${reason}. ${capture === "api" ? `Its checks (${API_CHECKS.filter((c) => c !== "Fuzzing" && c !== "Packaging").join(", ")}) were not run.` : "Its file checks were not run."} This is not a clean result.` });
      continue;
    }
    const before = leads.length;
    for (const c of json.checks) {
      const reason = String(c.reason ?? "");
      const isApi = API_CHECKS.includes(c.name);
      if (capture === "local" ? isApi : !isApi) continue; // each check from the run that can answer it
      if (c.score === -1 && /internal error/i.test(reason)) {
        const scope = capture === "api" && ADMIN_SCOPES[c.name] && adminError(reason);
        gaps.push(scope
          ? { kind: "not-covered-needs-scope", detail: `Scorecard ${c.name}: not covered: needs scope ${ADMIN_SCOPES[c.name]} on the repo. The token does not have it.` }
          : { kind: "scorecard-check-error", detail: `Scorecard ${c.name} (${capture}) did not run${networkError(reason) ? ": its host is outside the GitHub-only egress allow-list" : ""}. Not a clean result.` });
        continue;
      }
      if (c.name === "Pinned-Dependencies") {
        for (const d of c.details ?? []) {
          const m = String(d).match(PIN_RE);
          if (!m || !Object.hasOwn(snapshot.files, m[2])) continue;
          leads.push(scorecardLead({ check: c.name, kind: m[1], file: m[2], line: Number(m[3]), endLine: m[4] ? Number(m[4]) : undefined, impact: "Low", capture, cap }));
        }
      } else if (FILE_CHECKS.includes(c.name) && c.score === 0) {
        leads.push(scorecardLead({ check: c.name, impact: c.name === "License" ? "Informational" : "Low", capture, cap, score: 0 }));
      } else if (isApi && Number.isInteger(c.score) && c.score >= 0 && c.score < 5) {
        leads.push(scorecardLead({ check: c.name, impact: "Low", capture, cap, score: c.score }));
      }
    }
    if (capture === "local") {
      // Two local results look clean but are not: say so every time.
      gaps.push({ kind: "scorecard-check-not-trusted", detail: "Scorecard Vulnerabilities is not used: it needs api.osv.dev, which no run may reach, and with no network it still reports 0 vulnerabilities. The osv and grype scanners cover locked dependencies." });
      gaps.push({ kind: "scorecard-check-not-trusted", detail: "Scorecard Binary-Artifacts is not used: it ran on the snapshot's text files, and the snapshot skips binaries. See the skipped list." });
    }
    coverage.push({ engine, status: "ok", code: cap.code, timedOut: false, leads: leads.length - before });
  }
  return { leads, coverage, gaps };
}

export function networkedResults(snapshot) {
  const out = { leads: [], coverage: [], gaps: [] };
  for (const r of [scorecardFrom(snapshot)]) for (const k of Object.keys(out)) out[k].push(...r[k]);
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
