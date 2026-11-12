// Strix as a finding engine for a live target.
//
// WHY. Our own oracles only cover a SIWE dApp. Strix (Apache-2.0, usestrix) is a
// broad black-box web pentest agent: Playwright browser, Caido proxy, a Kali
// sandbox, skills per vulnerability class. Running it as a second engine means
// our agent starts from real, PoC-backed leads on classes we do not own —
// while our own oracles stay the only thing that can mark a finding proven.
//
// HOW. Headless (`-n`), budget-capped, quick mode, one target. Strix writes
// `strix_runs/<run>/findings.sarif`; each result becomes a lead. Its own model
// calls go through a loopback shim (lib/llm-shim.mjs) because the gateway
// rejects one parameter Strix always sends.
//
// NOT INSIDE THE GATE. Strix brings its own Docker sandbox and browser, so its
// traffic does not pass the scope proxy. The target list is what keeps it on the
// granted host; nothing else it does is target traffic.
import { spawn, execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerReady } from "./reach-confine.mjs";
import { startShim } from "./llm-shim.mjs";

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
  const version = await new Promise((resolve) => {
    execFile("strix", ["--version"], { timeout: 20_000 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
  if (!version) return { ok: false, reason: "the strix CLI is not installed (uv tool install strix-agent)" };
  const docker = await dockerReady();
  if (!docker.ok) return { ok: false, reason: docker.reason };
  return { ok: true, version };
}

const cap = (s, n = 300) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const pathOf = (uri) => {
  if (!uri) return "/";
  try { return new URL(uri).pathname ?? "/"; } catch { return String(uri); }
};

// SARIF results → our lead shape. Exported for the unit test: no Docker.
export function parseSarif(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { return []; }
  const results = doc?.runs?.[0]?.results ?? [];
  return results.flatMap((r) => {
    const uri = r?.locations?.[0]?.physicalLocation?.artifactLocation?.uri;
    if (!r?.ruleId) return [];
    const text = cap(r.message?.text);
    // A DAST finding is anchored to SECURITY.md, which says nothing about where
    // in the site it is. Prefer a URL or a path the write-up names; the path is
    // what the run view and the agent need.
    const hit = /https?:\/\/[^\s"`')]+/.exec(text)?.[0] ?? /(?<![:\w])\/[A-Za-z0-9._~%/-]{2,}/.exec(text)?.[0];
    const where = hit ?? (uri && !/SECURITY\.md$/i.test(uri) ? pathOf(uri) : "/");
    return [{
      engine: "strix",
      check: String(r.ruleId),
      impact: IMPACT[r?.properties?.strix?.severity] ?? LEVEL[r.level] ?? "Informational",
      where,
      description: text,
      corroborated: false,
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
  const shim = await startShim({ baseUrl: provider.baseUrl, key: provider.key });
  const cwd = mkdtempSync(join(tmpdir(), "strix-run-"));
  const args = [
    "-n",
    "--target", baseUrl,
    "--scan-mode", "quick",
    "--max-budget", String(budgetUsd),
    "--max-turns", String(DEFAULT_TURNS),
    "--instruction",
    `Black-box audit of ${baseUrl}. Report only vulnerabilities with a working PoC. It may not be a SIWE dApp: follow the site's actual surface.`,
  ];
  emit({ ev: "web-strix-started", baseUrl, budgetUsd });

  let timedOut = false;
  const child = spawn("strix", args, {
    cwd,
    env: {
      ...process.env,
      STRIX_LLM: provider.model,
      LLM_API_KEY: "shim", // the shim adds the real one
      LLM_API_BASE: shim.url,
      STRIX_API_TYPE: "chat_completions",
      STRIX_TELEMETRY: "0",
      ...(provider.inputCost != null ? { STRIX_LLM_INPUT_COST_PER_MTOK: String(provider.inputCost) } : {}),
      ...(provider.outputCost != null ? { STRIX_LLM_OUTPUT_COST_PER_MTOK: String(provider.outputCost) } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
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
  child.stdout.on("data", onLine);
  child.stderr.on("data", onLine);
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.on("exit", (c) => { clearTimeout(timer); resolve(c); });
    child.on("error", () => { clearTimeout(timer); resolve(1); });
  });

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
    await shim.stop();
    if (process.env.STRIX_KEEP !== "1") rmSync(cwd, { recursive: true, force: true });
    else tail.push(`kept ${cwd}`);
  }
  const status = timedOut ? "timed-out" : code === 0 || code === 2 ? "ran" : "unavailable";
  const reason = status === "unavailable" ? tail.slice(-3).join(" | ") : undefined;
  emit({ ev: "web-strix-done", status, leads: leads.length, costUsd: Number(costUsd.toFixed(4)) });
  return { status, leads, reason, timedOut, costUsd, coverage: { engine: "strix", status, leads: leads.length, ...(reason ? { reason } : {}), ...(costUsd ? { costUsd: Number(costUsd.toFixed(4)) } : {}) } };
}
