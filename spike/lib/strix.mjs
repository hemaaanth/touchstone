// Strix as a finding engine for a live target.
//
// ============================================================================
// THE DELIBERATE EXCEPTION. Every other engine in this repo is sealed: an
// offline lab, `--internal` networks, a scope proxy as the only egress, no
// internet. Strix is the ONE networked, non-offline engine. It is a full
// pentest agent, not a scanner: its sandbox needs the internet (target plus its
// own model calls), a browser, a proxy and its own containers. Sealing that is
// possible and would cost far more than it buys, because a live target is not
// offline to begin with. So:
//   - it runs in its own container through runDocker(), with the same caps and
//     the same backend switch as every other engine;
//   - that container mounts the Docker socket, because it starts its own
//     sandbox containers;
//   - its traffic does NOT pass the scope gate. The target list is the only
//     thing keeping it on the granted host. A run with Strix enabled therefore
//     reaches the internet, and a Strix lead can come from a host the grant
//     does not name (a link it followed). That is the accepted cost.
// If the Daytona backend is on, this call currently falls back to local Docker
// (its default network and the socket mount are host things). It says so.
// ============================================================================
//
// WHY. Our own oracles only cover a SIWE dApp. Strix (Apache-2.0, usestrix) is
// broad: Playwright browser, Caido proxy, a Kali sandbox, skills per class.
// Running it as a second engine means the agent starts from real, PoC-backed
// leads on classes we do not own — while our oracles stay the only minting
// path. A Strix result is ALWAYS a lead (`proven: false`, `corroborated:
// false`). It cannot short-circuit into a finding.
//
// HOW. Headless (`-n`), quick, budget- and turn-capped, one target. It writes
// `strix_runs/<run>/findings.sarif`; each result becomes a lead. Its model calls
// go through a loopback shim inside the same container (lib/llm-shim.mjs) that
// drops one parameter our gateway rejects; running the shim in-container is what
// keeps it working when the container is not on this host.
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerReady } from "./reach-confine.mjs";
import { requireImage } from "./proof-http.mjs";
import { runDocker } from "./wrap.mjs";

export const STRIX_IMAGE = "touchstone/strix:1.7.0";

// Cheap and honest: quick mode, a hard budget, a turn cap.
// The budget is checked after each model response, so a large prompt can
// overshoot it. Observed on a long DAST target: 25 turns cost about $4.30. Keep
// the turn count low; that is the real brake.
const DEFAULT_BUDGET_USD = Number(process.env.STRIX_BUDGET_USD ?? 0.5);
const DEFAULT_TURNS = Number(process.env.STRIX_TURNS ?? 15);
const DEFAULT_TIMEOUT_MS = Number(process.env.STRIX_TIMEOUT_MS ?? 8 * 60_000);

// error/warning/note is all SARIF guarantees; Strix keeps the real label in
// properties.strix.severity.
const IMPACT = { critical: "High", high: "High", medium: "Medium", low: "Low", informational: "Informational", info: "Informational" };
const LEVEL = { error: "High", warning: "Medium", note: "Low" };

export function strixEnabled() {
  return process.env.STRIX !== "0" && process.env.STRIX !== "false";
}

export async function strixReady() {
  if (!strixEnabled()) return { ok: false, reason: "disabled by STRIX=0" };
  const docker = await dockerReady();
  if (!docker.ok) return { ok: false, reason: docker.reason };
  try {
    await requireImage(STRIX_IMAGE, "strix");
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err).slice(0, 300) };
  }
  return { ok: true };
}

const cap = (s, n = 300) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const pathOf = (uri) => {
  if (!uri) return "/";
  try { return new URL(uri).pathname ?? "/"; } catch { return String(uri); }
};

// SARIF results → our lead shape. ALWAYS a lead: `proven: false` here and
// `corroborated: false` mean nothing downstream may treat one as a finding. The
// only minting path stays submit_finding -> an oracle match -> prove(). A lead
// is prompt text; a finding is a replayed transcript. Exported for the unit
// test: no Docker.
export function parseSarif(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { return []; }
  const results = doc?.runs?.[0]?.results ?? [];
  return results.flatMap((r) => {
    const uri = r?.locations?.[0]?.physicalLocation?.artifactLocation?.uri;
    // Coverage rows ("Not applicable") carry a synthetic rule id; they are not
    // findings, so keep them out of the lead list.
    if (!r?.ruleId || String(r.ruleId).startsWith("strix-coverage/")) return [];
    const text = cap(r.message?.text);
    // A DAST finding is anchored to SECURITY.md, which says nothing about where
    // in the site it is. Prefer a URL or a path the write-up names; the path is
    // what the run view and the agent need.
    const hit = /https?:\/\/[^\s"`')]+/.exec(text)?.[0] ?? /(?<![:\w])\/[A-Za-z0-9._~%/-]{2,}/.exec(text)?.[0];
    const where = hit ?? (uri && !/SECURITY\.md$/i.test(uri) ? pathOf(uri) : "/");
    return [{
      engine: "strix",
      source: "strix",
      check: String(r.ruleId),
      impact: IMPACT[r?.properties?.strix?.severity] ?? LEVEL[r.level] ?? "Informational",
      where,
      description: text,
      corroborated: false,
      proven: false,
    }];
  });
}

const unavailable = (reason) => ({ status: "unavailable", reason, leads: [], coverage: { engine: "strix", status: "unavailable", reason, leads: 0 } });

// Strix is best-effort. Its own agent can crash inside its Python SDK, as in
// this real line from a live run:
//   ERROR ... strix.core.execution: agent run failed for 7693ddc3; marking stopped
// A crash with no findings file is a coverage gap, not a clean scan.
const CRASH = /agent run failed|Traceback \(most recent call last\)/;

// Strix's own verdict on its run. Its SARIF says executionSuccessful: false
// when the scan was interrupted or its agents did not finish (seen on a real
// example.com run whose root agent crashed). Returns the first note as the
// reason, or null when the run completed or the document says nothing.
export function sarifIncomplete(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { return null; }
  const inv = doc?.runs?.[0]?.invocations?.[0];
  if (inv?.executionSuccessful !== false) return null;
  return cap(inv.toolExecutionNotifications?.[0]?.message?.text ?? "strix reported the scan did not complete", 200);
}

// A work dir Strix's container can write. The default temp dir can sit where
// the Docker daemon cannot write; then fall back to /tmp. Null with a reason
// when no candidate works.
function workDir() {
  const tried = [];
  for (const base of [...new Set([process.env.STRIX_TMPDIR, tmpdir(), "/tmp"].filter(Boolean))]) {
    let dir = null;
    try {
      dir = mkdtempSync(join(base, "strix-run-"));
      // The daemon may remap root to a subuid that does not own the tmp dir.
      chmodSync(dir, 0o777);
      return { dir };
    } catch (err) {
      tried.push(`${base}: ${err?.code ?? cap(err?.message, 80)}`);
      if (dir) try { rmSync(dir, { recursive: true, force: true }); } catch { /* left behind */ }
    }
  }
  return { reason: `no writable temp dir for strix (${tried.join("; ")})` };
}

// Strix's container writes as its own user, so the host user may not be able
// to delete what it left (EACCES). Then delete it from a container, as that
// user. Never throws: a dir left behind must not cost the leads already read.
async function removeWorkDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); return null; } catch { /* try as the container user */ }
  await runDocker(["run", "--rm", "--network", "none", "--entrypoint", "sh", "-v", `${dir}:/work`, STRIX_IMAGE, "-c", "rm -rf /work/* /work/.[!.]*"], { timeoutMs: 60_000 });
  try { rmSync(dir, { recursive: true, force: true }); return null; } catch (err) {
    return `left ${dir}: ${err?.code ?? cap(err?.message, 80)}`;
  }
}

// One scan. Resolves with { status, leads, coverage, timedOut }. It never
// throws: any Strix failure degrades to status "unavailable" with a reason, so
// the run keeps the other engines' results.
export async function runStrix(opts = {}) {
  const emit = (ev) => {
    try { opts.emit?.(ev); } catch { /* a view error must not stop the scan */ }
  };
  try {
    return await scanStrix({ ...opts, emit });
  } catch (err) {
    const reason = `strix failed: ${cap(err?.message ?? err)}`;
    emit({ ev: "web-strix-done", status: "unavailable", leads: 0, reason });
    return unavailable(reason);
  }
}

async function scanStrix({ baseUrl, provider, budgetUsd = DEFAULT_BUDGET_USD, timeoutMs = DEFAULT_TIMEOUT_MS, emit }) {
  // Gateways serve model ids LiteLLM cannot price, and without a price
  // --max-budget never fires. Always hand Strix our own per-token prices.
  const ready = await strixReady();
  if (!ready.ok) return unavailable(ready.reason);
  // Strix is the ONE networked, non-offline engine. It runs in its own container
  // through runDocker(), so it shares the backend switch (local Docker or
  // Daytona) and the resource caps the other engines get. It needs the Docker
  // socket because it starts its own sandbox containers, and it needs network
  // for the target and its model calls. The sealed/offline parity of the lab
  // engines is deliberately not chased here: a live target is not offline.
  //
  // The model shim runs INSIDE the same container (entrypoint.sh), so it works
  // unchanged when the container is on a remote Daytona machine.
  const work = workDir();
  if (!work.dir) {
    emit({ ev: "web-strix-done", status: "unavailable", leads: 0, reason: work.reason });
    return unavailable(work.reason);
  }
  const cwd = work.dir;
  const name = `touchstone-strix-${randomBytes(4).toString("hex")}`;
  const args = [
    "run", "--rm", "--name", name,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "512", "--memory", "2g",
    "-v", "/var/run/docker.sock:/var/run/docker.sock",
    "-v", `${cwd}:/work`, "-w", "/work",
    "-e", `STRIX_LLM=${provider.model}`,
    "-e", "LLM_API_KEY=shim", // the in-container shim adds the real one
    "-e", `UPSTREAM_BASE=${provider.baseUrl}`,
    "-e", `UPSTREAM_KEY=${provider.key}`,
    ...(provider.inputCost != null ? ["-e", `STRIX_LLM_INPUT_COST_PER_MTOK=${provider.inputCost}`] : []),
    ...(provider.outputCost != null ? ["-e", `STRIX_LLM_OUTPUT_COST_PER_MTOK=${provider.outputCost}`] : []),
    STRIX_IMAGE,
    "-n",
    "--target", baseUrl,
    "--scan-mode", "quick",
    "--max-budget", String(budgetUsd),
    "--max-turns", String(DEFAULT_TURNS),
    "--instruction",
    `Black-box audit of ${baseUrl}. Report only vulnerabilities with a working PoC. It may not be a SIWE dApp: follow the site's actual surface.`,
  ];
  emit({ ev: "web-strix-started", baseUrl, budgetUsd });

  const tail = [];
  let seen = 0;
  let crashLine = null;
  const onLine = (d) => {
    for (const line of String(d).split("\n")) {
      if (!line.trim()) continue;
      tail.push(line);
      if (!crashLine && CRASH.test(line)) crashLine = cap(line, 200);
      if (tail.length > 40) tail.shift();
      // The TUI prints a lot; one event per four lines is enough for the view.
      if (++seen % 4 === 0) emit({ ev: "web-strix-line", line: cap(line, 200) });
    }
  };
  const r = await runDocker(args, { ws: cwd, timeoutMs, stream: (_where, d) => onLine(d) });
  const timedOut = r.timedOut;
  // A killed CLI leaves its sandbox container behind: `docker run` was killed,
  // the daemon was not. Remove the CLI container by name and any sandbox that
  // appeared after this scan started.
  if (timedOut) {
    await runDocker(["rm", "-f", name], { timeoutMs: 20_000 });
    const since = String(Math.floor(Date.now() / 1000) - Math.ceil(timeoutMs / 1000) - 30);
    // Its sandbox image tag moves with the CLI release, so match the repo in the
    // image name rather than an exact ancestor tag (which would silently match
    // nothing). Only containers created since this scan started are touched.
    const q = await runDocker(["ps", "--format", "{{.ID}} {{.Image}}", "--filter", `since=${since}`], { timeoutMs: 20_000 });
    for (const line of q.stdout.split("\n")) {
      if (!line.includes("strix-sandbox")) continue;
      await runDocker(["rm", "-f", line.split(" ")[0]], { timeoutMs: 20_000 });
    }
  }
  if (r.code !== 0 && !timedOut) tail.push(r.stderr.trim().slice(-300));

  // Strix writes one run dir. A timed-out or partial run still has whatever it
  // reported before it stopped, which is the point of keeping the SARIF.
  let leads = [];
  let costUsd = 0;
  let incomplete = null;
  try {
    const runs = join(cwd, "strix_runs");
    const dirs = existsSync(runs) ? readdirSync(runs) : [];
    const dir = dirs.sort().at(-1);
    const sarif = dir ? join(runs, dir, "findings.sarif") : null;
    if (sarif && existsSync(sarif)) {
      const text = readFileSync(sarif, "utf8");
      leads = parseSarif(text);
      incomplete = sarifIncomplete(text);
    } else tail.push("strix wrote no findings file");
    // Its own spend, from its own usage record, at our prices. The run budget
    // guard counts only the engine's own inference, so report this separately.
    try {
      const usage = JSON.parse(readFileSync(join(runs, dir, "run.json"), "utf8")).llm_usage ?? {};
      costUsd = ((usage.input_tokens ?? 0) / 1e6) * (provider.inputCost ?? 0)
        + ((usage.output_tokens ?? 0) / 1e6) * (provider.outputCost ?? 0);
    } catch { /* no usage record */ }
  } catch (err) {
    tail.push(`could not read strix output: ${cap(err?.message ?? err, 120)}`);
  }
  if (process.env.STRIX_KEEP === "1") tail.push(`kept ${cwd}`);
  else {
    const left = await removeWorkDir(cwd);
    if (left) tail.push(left);
  }
  // Hitting the turn cap exits non-zero with a MaxTurnsExceeded trace. That is
  // a stop, not a failure: the leads it did produce are kept.
  const hitCap = tail.some((l) => /MaxTurnsExceeded|Max turns/i.test(l));
  // Its agent crashed, or its own report says the scan did not complete. With
  // no leads that is a coverage gap, never a clean scan: "unavailable",
  // whatever the exit code. Leads it did report are real and are kept.
  const broke = hitCap ? null : crashLine ?? incomplete;
  const status = broke && !leads.length ? "unavailable"
    : timedOut || hitCap ? "timed-out" : r.code === 0 || r.code === 2 ? "ran" : "unavailable";
  const reason = broke
    ? (leads.length ? `strix did not finish; the ${leads.length} leads it reported are kept: ${broke}` : `strix did not finish and reported nothing: ${broke}`)
    : status === "unavailable" ? tail.slice(-3).join(" | ")
    : hitCap ? "stopped at the turn cap; leads found before that are kept" : undefined;
  emit({ ev: "web-strix-done", status, leads: leads.length, costUsd: Number(costUsd.toFixed(4)), ...(reason ? { reason } : {}) });
  return { status, leads, reason, timedOut, costUsd, coverage: { engine: "strix", status, leads: leads.length, ...(reason ? { reason } : {}), ...(costUsd ? { costUsd: Number(costUsd.toFixed(4)) } : {}) } };
}
