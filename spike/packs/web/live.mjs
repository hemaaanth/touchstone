// The Web pack's live scan. The request runner, transcript and proof replay are
// shared and live in lib/live.mjs; this file only aims the scanners at the real
// site and records their leads.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { requireImage } from "../../lib/proof-http.mjs";
import { readTouchstone } from "../../lib/sandbox.mjs";
import { SCAN_NETWORK, bindLive } from "../../lib/live.mjs";
import { scanWeb, mergeLeads } from "./scan.mjs";
import { DEFAULT_BUDGET_USD as STRIX_BUDGET_USD, runStrix, strixSettings } from "../../lib/strix.mjs";
import { FALLBACK_PRICE, activeProvider, providerKey, readConfig } from "../../lib/providers.mjs";
import { capGuard, ledgerCharge } from "../../lib/inference.mjs";

const LEADS_FILE = ".web-leads.json";

// The most one Strix scan can spend. Strix checks its budget only after each
// model response, so the last turn can start just under the budget and add one
// full turn: the model's whole context window read, its largest answer written.
// Prices are per 1M tokens. A model with no published window or answer size
// counts as 1M tokens in and 65536 out, so an unknown model is not cheap.
export function strixWorstUsd(model, budgetUsd = STRIX_BUDGET_USD) {
  const inTok = model.context ?? 1_000_000;
  const outTok = model.maxOut ?? 65_536;
  const { input, output } = strixPrices(model);
  return budgetUsd + (inTok * input + outTok * output) / 1e6;
}

// The prices Strix's spend is checked and charged at, per 1M tokens. A missing
// price is FALLBACK_PRICE, one price at a time; a price of 0 stays 0. The
// estimate and the charge must use the same prices: without a price, runStrix
// would charge the ledger $0 and every next scan would pass the cap check.
export function strixPrices(model) {
  return { input: model.input ?? FALLBACK_PRICE.input, output: model.output ?? FALLBACK_PRICE.output };
}

// The live prepass: bind the boundary the platform opened, then scan the site
// for leads. No lab is started.
//
// `budget` is the run's budget: { limitUsd, spentUsd }. Strix spends from it,
// like the agent does: its own budget is cut to what is left, and the result
// carries `spentUsd` so the caller can add it to the run's spend. With no
// `budget` (a smoke script) only the total spend cap applies.
export async function livePrepass(ws, { emit = () => {}, reach, budget } = {}) {
  const cfg = readTouchstone(ws);
  const baseUrl = cfg.baseUrl;
  if (!baseUrl) throw new Error("the live workspace has no base URL");
  if (!reach?.confine) throw new Error("the live run has no confinement boundary");
  const image = "touchstone/web-lab:dev";
  await requireImage(image, "web");
  bindLive(ws, { net: reach.confine.netClient, gate: reach.confine.gateUrl, baseUrl, image });
  emit({ ev: "web-live-target", baseUrl, hosts: reach.hosts });

  // The tool scan and Strix run at the same time. Strix does not read the
  // tool scan's results, so waiting for it only made the run start later.
  const [scan, strix] = await Promise.all([toolScan(baseUrl, emit), strixScan(baseUrl, emit, budget)]);
  scan.coverage.push(strix.coverage);
  scan.leads = mergeLeads([...scan.leads, ...strix.leads]);
  const record = { pack: "web", live: true, baseUrl, coverage: scan.coverage, leads: scan.leads };
  writeFileSync(join(ws, LEADS_FILE), JSON.stringify(record, null, 2));
  emit({ ev: "web-scan-done", coverage: scan.coverage.map((c) => `${c.engine}:${c.status}:${c.leads}`), leads: scan.leads.length });
  return {
    env: { LEADS: JSON.stringify(scan.leads.map((l) => ({ check: l.check, impact: l.impact, where: l.where, engines: l.engines, corroborated: l.corroborated, note: l.description }))) },
    record,
    spentUsd: strix.spentUsd,
  };
}

async function toolScan(baseUrl, emit) {
  try {
    emit({ ev: "web-scan-started", engines: ["zap", "nuclei", "dalfox"], target: baseUrl });
    // A live scope has no documents in its workspace. Its brief is operator
    // text for the model only, so it seeds no scanner URL.
    return await scanWeb({ net: SCAN_NETWORK, baseUrl, urls: [] });
  } catch (err) {
    emit({ ev: "web-scan-failed", error: String(err?.message ?? err).slice(0, 200) });
    return { coverage: [], leads: [] };
  }
}

// A second, broader engine: Strix brings a browser, a proxy and skills for the
// classes our own oracles do not cover. Its results are leads; ours prove.
// Strix is best-effort. Whatever stops it, the run keeps the other engines'
// leads and records strix as "unavailable" with the reason. Never throws.
async function strixScan(baseUrl, emit, budget) {
  const gap = (reason) => {
    emit({ ev: "web-strix-done", status: "unavailable", leads: 0, reason });
    return { coverage: { engine: "strix", status: "unavailable", reason, leads: 0 }, leads: [], spentUsd: 0 };
  };
  try {
    const conf = readConfig();
    const p = activeProvider(conf);
    const key = providerKey(p);
    if (!key) return gap("no provider key for strix's model calls");
    const limits = strixSettings(conf);
    // The run budget. Strix gets at most what is left of it. Like the agent's
    // own last call, its last turn can go past that by one turn.
    let budgetUsd = limits.budgetUsd;
    if (budget) {
      const left = Number(budget.limitUsd) - Number(budget.spentUsd ?? 0);
      if (!(left >= 0.01)) return gap("the run budget has no money left for strix");
      budgetUsd = Math.min(budgetUsd, Math.floor(left * 100 + 1e-6) / 100);
    }
    // Strix makes its own model calls with the provider key, so the total
    // spend cap applies too: check before, charge the ledger after.
    const m = Object.values(p.models)[0];
    const price = strixPrices(m);
    capGuard(strixWorstUsd(m, budgetUsd));
    const strix = await runStrix({
      baseUrl,
      provider: {
        baseUrl: p.baseUrl,
        key,
        model: m.id,
        inputCost: price.input,
        outputCost: price.output,
      },
      budgetUsd,
      turns: limits.turns,
      timeoutMs: limits.timeoutMin * 60_000,
      emit,
    });
    ledgerCharge(`${m.id} (strix)`, strix.costUsd);
    return { coverage: strix.coverage, leads: strix.leads, spentUsd: strix.costUsd > 0 ? strix.costUsd : 0 };
  } catch (err) {
    const error = String(err?.message ?? err).slice(0, 200);
    emit({ ev: "web-strix-failed", error });
    return { coverage: { engine: "strix", status: "unavailable", reason: `strix failed: ${error}`, leads: 0 }, leads: [], spentUsd: 0 };
  }
}
