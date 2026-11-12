// The Web pack's live scan. The request runner, transcript and proof replay are
// shared and live in lib/live.mjs; this file only aims the scanners at the real
// site and records their leads.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requireImage } from "../../lib/proof-http.mjs";
import { readTouchstone } from "../../lib/sandbox.mjs";
import { SCAN_NETWORK, bindLive } from "../../lib/live.mjs";
import { scanWeb, docQueryUrls, mergeLeads } from "./scan.mjs";
import { runStrix } from "../../lib/strix.mjs";
import { activeProvider, providerKey, readConfig } from "../../lib/providers.mjs";

const LEADS_FILE = ".web-leads.json";

// The live prepass: bind the boundary the platform opened, then scan the site
// for leads. No lab is started.
export async function livePrepass(ws, { emit = () => {}, reach } = {}) {
  const cfg = readTouchstone(ws);
  const baseUrl = cfg.baseUrl;
  if (!baseUrl) throw new Error("the live workspace has no base URL");
  if (!reach?.confine) throw new Error("the live run has no confinement boundary");
  const image = "touchstone/web-lab:dev";
  await requireImage(image, "web");
  bindLive(ws, { net: reach.confine.netClient, gate: reach.confine.gateUrl, baseUrl, image });
  emit({ ev: "web-live-target", baseUrl, hosts: reach.hosts });

  let scan = { coverage: [], leads: [] };
  try {
    emit({ ev: "web-scan-started", engines: ["zap", "nuclei", "dalfox"], target: baseUrl });
    const docs = ["BRIEF.md"].map((f) => { try { return readFileSync(join(ws, f), "utf8"); } catch { return ""; } }).join("\n");
    scan = await scanWeb({ net: SCAN_NETWORK, baseUrl, urls: docQueryUrls(docs, baseUrl) });
  } catch (err) {
    emit({ ev: "web-scan-failed", error: String(err?.message ?? err).slice(0, 200) });
  }
  // A second, broader engine: Strix brings a browser, a proxy and skills for the
  // classes our own oracles do not cover. Its results are leads; ours prove.
  // Strix is best-effort. Whatever stops it, the run keeps the other engines'
  // leads and records strix as "unavailable" with the reason.
  const strixGap = (reason) => scan.coverage.push({ engine: "strix", status: "unavailable", reason, leads: 0 });
  let strix = null;
  try {
    const p = activeProvider(readConfig());
    const key = providerKey(p);
    if (!key) strixGap("no provider key for strix's model calls");
    else {
      strix = await runStrix({
        baseUrl,
        provider: {
          baseUrl: p.baseUrl,
          key,
          model: Object.values(p.models)[0].id,
          inputCost: Object.values(p.models)[0].input,
          outputCost: Object.values(p.models)[0].output,
        },
        emit,
      });
      scan.coverage.push(strix.coverage);
      scan.leads = mergeLeads([...scan.leads, ...strix.leads]);
    }
  } catch (err) {
    const error = String(err?.message ?? err).slice(0, 200);
    emit({ ev: "web-strix-failed", error });
    strixGap(`strix failed: ${error}`);
  }
  const record = { pack: "web", live: true, baseUrl, coverage: scan.coverage, leads: scan.leads };
  writeFileSync(join(ws, LEADS_FILE), JSON.stringify(record, null, 2));
  emit({ ev: "web-scan-done", coverage: scan.coverage.map((c) => `${c.engine}:${c.status}:${c.leads}`), leads: scan.leads.length });
  return { env: { LEADS: JSON.stringify(scan.leads.map((l) => ({ check: l.check, impact: l.impact, where: l.where, engines: l.engines, corroborated: l.corroborated, note: l.description }))) }, record };
}
