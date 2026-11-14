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
import { STRIX_SANDBOX_IMAGE } from "./images.mjs";
import { runDocker } from "./wrap.mjs";

export const STRIX_IMAGE = "touchstone/strix:1.7.0";

// Cheap and honest: quick mode, a hard budget, a turn cap.
// The budget is checked after each model response, so a large prompt can
// overshoot it.
//
// `turns` is PER AGENT, not per scan: Strix fans out to several agents and each
// one counts its own turns. A low value kills every child mid-thought and Strix
// then reports "agent run failed ... marking stopped", which reads like a crash.
// A live target's first agent (a surface mapper) spends 10 to 20 turns before it
// reports anything, so 15 starved every run of 2026-11-14. The budget, not this
// cap, is the brake.
//
// The three limits are Web module settings (Modules > Web). A saved setting
// wins; else STRIX_TURNS / STRIX_BUDGET_USD / STRIX_TIMEOUT_MS; else these.
export const STRIX_DEFAULTS = { turns: 60, budgetUsd: 0.5, timeoutMin: 15 };
export const STRIX_LIMITS = {
  turns: { min: 1, max: 200, integer: true },
  budgetUsd: { min: 0.01, max: 100 },
  timeoutMin: { min: 1, max: 120 },
};
const STRIX_WORDS = { turns: "The Strix turn cap", budgetUsd: "The Strix budget", timeoutMin: "The Strix time limit" };
const STRIX_ENV = {
  turns: () => process.env.STRIX_TURNS,
  budgetUsd: () => process.env.STRIX_BUDGET_USD,
  timeoutMin: () => (process.env.STRIX_TIMEOUT_MS == null ? undefined : Number(process.env.STRIX_TIMEOUT_MS) / 60_000),
};

// One limit, checked. Throws a sentence the console can show.
export function validateStrixSetting(name, value) {
  const lim = STRIX_LIMITS[name];
  if (!lim) throw new Error(`Unknown Strix setting: ${name}.`);
  const n = Number(value);
  if (value === "" || value == null || !Number.isFinite(n) || n < lim.min || n > lim.max || (lim.integer && !Number.isInteger(n))) {
    throw new Error(`${STRIX_WORDS[name]} must be ${lim.integer ? "a whole number" : "a number"} from ${lim.min} to ${lim.max}.`);
  }
  return n;
}

// The limits a scan uses now, and where each came from. `cfg` is the provider
// config (readConfig()); its `modules.web.strix` holds the saved values. A bad
// saved or env value falls back to the next source rather than break a run.
export function strixSettings(cfg = {}) {
  const saved = cfg?.modules?.web?.strix ?? {};
  const out = { source: {} };
  for (const name of Object.keys(STRIX_DEFAULTS)) {
    out[name] = STRIX_DEFAULTS[name];
    out.source[name] = "default";
    for (const [source, raw] of [["saved", saved[name]], ["env", STRIX_ENV[name]()]]) {
      if (raw == null || raw === "") continue;
      try {
        out[name] = validateStrixSetting(name, raw);
        out.source[name] = source;
        break;
      } catch { /* try the next source */ }
    }
  }
  return out;
}

// The default per-scan budget, for callers that do not pass the settings.
export const DEFAULT_BUDGET_USD = strixSettings().budgetUsd;

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
    await requireImage(STRIX_SANDBOX_IMAGE, "strix");
  } catch {
    return { ok: false, reason: "Strix needs its CLI and sandbox images. Run: node spike/scripts/setup.mjs --only strix --include-optional" };
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
  await runDocker(["run", "--rm", "--pull=never", "--network", "none", "--entrypoint", "sh", "-v", `${dir}:/work`, STRIX_IMAGE, "-c", "rm -rf /work/* /work/.[!.]*"], { timeoutMs: 60_000 });
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

async function scanStrix({ baseUrl, provider, budgetUsd = DEFAULT_BUDGET_USD, turns = STRIX_DEFAULTS.turns, timeoutMs = STRIX_DEFAULTS.timeoutMin * 60_000, emit }) {
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
    "run", "--rm", "--pull=never", "--name", name,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "512", "--memory", "2g",
    "-v", "/var/run/docker.sock:/var/run/docker.sock",
    "-v", `${cwd}:/work`, "-w", "/work",
    "-e", `STRIX_LLM=${provider.model}`,
    // In Strix this variable names its inner sandbox, not this CLI image.
    "-e", `STRIX_IMAGE=${STRIX_SANDBOX_IMAGE}`,
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
    "--max-turns", String(turns),
    "--instruction",
    `Black-box audit of ${baseUrl}. Report only vulnerabilities with a working PoC. It may not be a SIWE dApp: follow the site's actual surface.`,
  ];
  emit({ ev: "web-strix-started", baseUrl, budgetUsd, turns });

  const tail = [];
  let seen = 0;
  let crashLine = null;
  // Sticky flags, read before the 40-line tail can push the evidence out.
  // A turn-cap stop prints its own traceback 40+ lines after the "marking
  // stopped" line, so the tail alone mislabels it as a crash.
  let hitTurnCap = false;
  let proxyDown = false;
  const onLine = (d) => {
    for (const line of String(d).split("\n")) {
      if (!line.trim()) continue;
      tail.push(line);
      if (!crashLine && CRASH.test(line)) crashLine = cap(line, 200);
      if (!hitTurnCap && /MaxTurnsExceeded|Max turns/i.test(line)) hitTurnCap = true;
      if (!proxyDown && /Caido bootstrap failed/i.test(line)) proxyDown = true;
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
  // a stop, not a failure: the leads it did produce are kept. The flag is
  // sticky, so a traceback line falling out of the tail cannot hide it.
  // A dead Caido proxy is not a crash either: Strix keeps working with its
  // shell and browser tools, but it loses its traffic view. That is a recorded
  // coverage gap, never a silent one.
  const hitCap = hitTurnCap;
  // Time ran out. That is the normal end when the clock is the brake, so say so
  // instead of calling it a crash. Its own report says "interrupted" when it was
  // stopped too; that alone is only a clock-out when no crash line was found,
  // because a real agent crash also ends interrupted.
  const clockOut = timedOut || (!crashLine && /status 'interrupted'/i.test(String(incomplete ?? "")));
  // Its agent crashed, or its own report says the scan did not complete. With
  // no leads that is a coverage gap, never a clean scan: "unavailable",
  // whatever the exit code. Leads it did report are real and are kept.
  const broke = hitCap || clockOut ? null : crashLine ?? incomplete;
  const status = broke && !leads.length ? "unavailable"
    : clockOut || hitCap ? "timed-out" : r.code === 0 || r.code === 2 ? "ran" : "unavailable";
  const gaps = [
    clockOut ? `stopped at the ${Math.round(timeoutMs / 60_000)}-minute limit; leads found before that are kept` : null,
    hitCap ? `stopped at the ${turns}-turn-per-agent cap; leads found before that are kept` : null,
    proxyDown ? "Caido proxy did not start in its sandbox, so its recorded-traffic tools were unavailable" : null,
  ].filter(Boolean);
  const reason = broke
    ? (leads.length ? `strix did not finish; the ${leads.length} leads it reported are kept: ${broke}` : `strix did not finish and reported nothing: ${broke}`)
    : status === "unavailable" ? tail.slice(-3).join(" | ")
    : gaps.length ? gaps.join("; ") : undefined;
  emit({ ev: "web-strix-done", status, leads: leads.length, costUsd: Number(costUsd.toFixed(4)), ...(reason ? { reason } : {}) });
  return { status, leads, reason, timedOut, costUsd, coverage: { engine: "strix", status, leads: leads.length, ...(reason ? { reason } : {}), ...(costUsd ? { costUsd: Number(costUsd.toFixed(4)) } : {}) } };
}
