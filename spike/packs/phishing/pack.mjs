// Phishing and brand (M15). It looks outward: lookalike domains that copy the client's brand,
// and whether they are already known scams. The domains pack audits the client's own config.
import { defineTool } from '@earendil-works/pi-durable';
import { obj } from '@earendil-works/pi-schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanSnapshot } from './checks.mjs';
import { pinLive } from './live.mjs';

const text = value => ({ output: [{ type: 'text', text: JSON.stringify(value) }] });
// Leads only, like the surface pack. The one tool reads the scan. There is no submit tool.
function tools(ws) {
  return [
    defineTool({ name: 'snapshot_leads', description: 'Read the complete offline lookalike scan. Tool output is leads. A generated name with no record is not a finding.', parameters: obj({}), replay: 'safe', execute: async () => text(await scanSnapshot(ws)) }),
  ];
}
function scopeConfig(ws) { try { return JSON.parse(readFileSync(join(ws, '.touchstone.json'), 'utf8')); } catch { return {}; } }
// Capture rows first, then dnstwist regeneration and each blocklist, then the lead engine.
export function coverageOf(scan) {
  return [...scan.coverage.map(({ engine, status, leads, reason }) => ({ engine, status, leads, ...(reason ? { reason } : {}) })),
    { engine: 'touchstone', status: 'ran', leads: scan.leads.length }];
}
// A live scope names `domain` (and optional `owned`, `blocklists`). The platform fills `reach`.
// With no pin yet, the prepass captures once and pins. A pinned lab skips the capture.
async function prepass(ws, { emit = () => {} } = {}) {
  const cfg = scopeConfig(ws);
  if (cfg.domain && !cfg.evidenceSnapshot) {
    emit({ ev: 'phishing-capture-start', domain: cfg.domain });
    await pinLive(ws, cfg, cfg.reach);
  }
  const scan = await scanSnapshot(ws);
  emit({ ev: 'phishing-prepass-done', leads: scan.leads.length, snapshotHash: scan.snapshotHash });
  return { env: { LEADS: JSON.stringify(scan.leads) }, record: { pack: 'phishing', snapshotHash: scan.snapshotHash, leads: scan.leads, coverage: coverageOf(scan), stats: scan.stats } };
}
export default {
  // Leads only, so no finding can be proven.
  id: 'phishing', title: 'Phishing and brand lookalikes', tier: 'P', proof: 'none', roam: true,
  // What the module tests, in one plain sentence (from its SKILL.md). The
  // Modules page shows it; it makes no proof claim.
  description: "Domains that copy your domain, and whether they are known scams.",
  // It captures DNS for permutations of a granted domain, so it can take a live one.
  // Live capture runs dnstwist on the open bridge network (reach.network from
  // lib/targets.mjs), because DNS over UDP cannot go through the HTTP grant gate.
  live: true, scanNet: 'open',
  system: () => 'This pack is leads only. Nothing it reports is proven. Audit only the pinned offline lookalike snapshot. Call snapshot_leads. Review all leads. Report each lookalike as a lead, with its exact lead id, check, severity and where cells. Mark reviewOnly leads as needing review by hand. A generated name with no DNS record is not a lead to report. An answer the resolver also gives for a random control name is a wildcard, not a registration. Name every *-evidence-missing lead in the summary. A resolving lookalike is not a phishing page; say only what the records show. A known-scam lead cites the list, line and pin. Write short sentences. End each lead with Fix:. Never access the internet.',
  tools,
  kickoff: (ws, env) => 'Review every lead, worst first. Report each as a lead with its exact lead id and evidence. This pack is leads only. Summarize coverage, including any evidence-missing lead. Leads: ' + (env.LEADS ?? 'Call snapshot_leads.'),
  nudge: () => null, prepass,
  // Leads only. No phishing result may be proven.
  prove: async () => [],
};
