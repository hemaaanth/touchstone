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

// One scan. Resolves with { status, leads, coverage, timedOut } and never throws
// for a scan that merely found nothing.
export async function runStrix({ baseUrl, provider, budgetUsd = DEFAULT_BUDGET_USD, timeoutMs = DEFAULT_TIMEOUT_MS, emit = () => {} } = {}) {
  // Gateways serve model ids LiteLLM cannot price, and without a price
  // --max-budget never fires. Always hand Strix our own per-token prices.
  const ready = await strixReady();
  if (!ready.ok) return { status: "unavailable", reason: ready.reason, leads: [], coverage: { engine: "strix", status: "unavailable", reason: ready.reason, leads: 0 } };
  // Strix is the ONE networked, non-offline engine. It runs in its own container
  // through runDocker(), so it shares the backend switch (local Docker or
  // Daytona) and the resource caps the other engines get. It needs the Docker
  // socket because it starts its own sandbox containers, and it needs network
  // for the target and its model calls. The sealed/offline parity of the lab
  // engines is deliberately not chased here: a live target is not offline.
  //
  // The model shim runs INSIDE the same container (entrypoint.sh), so it works
  // unchanged when the container is on a remote Daytona machine.
  const cwd = mkdtempSync(join(tmpdir(), "strix-run-"));
  // The daemon may remap root to a subuid that does not own the tmp dir.
  chmodSync(cwd, 0o777);
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
  const onLine = (d) => {
    for (const line of String(d).split("\n")) {
      if (!line.trim()) continue;
      tail.push(line);
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
  try {
    const runs = join(cwd, "strix_runs");
    const dirs = existsSync(runs) ? readdirSync(runs) : [];
    const dir = dirs.sort().at(-1);
    const sarif = dir ? join(runs, dir, "findings.sarif") : null;
    if (sarif && existsSync(sarif)) leads = parseSarif(readFileSync(sarif, "utf8"));
    else tail.push("strix wrote no findings file");
    // Its own spend, from its own usage record, at our prices. The run budget
    // guard counts only the engine's own inference, so report this separately.
    try {
      const usage = JSON.parse(readFileSync(join(runs, dir, "run.json"), "utf8")).llm_usage ?? {};
      costUsd = ((usage.input_tokens ?? 0) / 1e6) * (provider.inputCost ?? 0)
        + ((usage.output_tokens ?? 0) / 1e6) * (provider.outputCost ?? 0);
    } catch { /* no usage record */ }
  } finally {
    if (process.env.STRIX_KEEP !== "1") rmSync(cwd, { recursive: true, force: true });
    else tail.push(`kept ${cwd}`);
  }
  // Hitting the turn cap exits non-zero with a MaxTurnsExceeded trace. That is
  // a stop, not a failure: the leads it did produce are kept.
  const hitCap = tail.some((l) => /MaxTurnsExceeded|Max turns/i.test(l));
  const status = timedOut || hitCap ? "timed-out" : r.code === 0 || r.code === 2 ? "ran" : "unavailable";
  const reason = status === "unavailable"
    ? tail.slice(-3).join(" | ")
    : hitCap ? "stopped at the turn cap; leads found before that are kept" : undefined;
  emit({ ev: "web-strix-done", status, leads: leads.length, costUsd: Number(costUsd.toFixed(4)) });
  return { status, leads, reason, timedOut, costUsd, coverage: { engine: "strix", status, leads: leads.length, ...(reason ? { reason } : {}), ...(costUsd ? { costUsd: Number(costUsd.toFixed(4)) } : {}) } };
}
