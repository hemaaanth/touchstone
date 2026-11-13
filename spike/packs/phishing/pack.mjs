// Phishing and brand (M15). It looks outward: lookalike domains that copy the client's brand,
// and whether they are already known scams. The domains pack audits the client's own config.
import { defineTool } from '@earendil-works/pi-durable';
import { obj, str } from '@earendil-works/pi-schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { event } from '../../lib/event.mjs';
import { replayEvidence, proveFindings } from '../../lib/proof-evidence.mjs';
import { scanSnapshot, detectors } from './checks.mjs';
import { pinLive } from './live.mjs';

const text = value => ({ output: [{ type: 'text', text: JSON.stringify(value) }] });
function tools(ws, state) {
  return [
    defineTool({ name: 'snapshot_leads', description: 'Read the complete offline lookalike scan. Tool output is leads. A generated name with no record is not a finding.', parameters: obj({}), replay: 'safe', execute: async () => text(await scanSnapshot(ws)) }),
    defineTool({ name: 'submit_finding', description: 'Replay one phishing lead against the pinned snapshot. Use its exact id. Never claim a site hosts phishing beyond the evidence. One finding per domain.', parameters: obj({ lead_id: str(), explanation: str({ description: 'Short evidence-based explanation. End with Fix: and the fix.' }) }), replay: 'safe', execute: async (args) => {
      const scan = await scanSnapshot(ws);
      const lead = scan.leads.find(l => l.id === args.lead_id);
      if (!lead || lead.reviewOnly || state.found.some(f => f.poc === lead.id)) return { ...text('Unknown, duplicate, or review-only lead. A bare permutation or a parked name is not proof.'), isError: true };
      const evidence = { check: lead.check, where: lead.where, snapshotHash: scan.snapshotHash };
      const proof = await replayEvidence(ws, evidence, { detectors });
      if (proof.status !== 'pass') return { ...text(proof), isError: true };
      const finding = { n: state.found.length + 1, title: lead.check, severity: lead.severity, poc: lead.id, explanation: args.explanation, evidence };
      state.found.push(finding);
      event('finding-submitted', { n: finding.n, title: finding.title, severity: finding.severity, poc: finding.poc });
      return text({ recorded: finding.n, proof });
    } }),
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
  id: 'phishing', title: 'Phishing and brand lookalikes', tier: 'P', proof: 'evidence',
  // It captures DNS for permutations of a granted domain, so it can take a live one.
  live: true,
  system: () => 'Audit only the pinned offline lookalike snapshot. Call snapshot_leads. Review all leads. Submit each confirmed lookalike with submit_finding. Never submit reviewOnly leads. A generated name with no DNS record is not a finding. A resolving lookalike is not proof of a phishing page; say only what the records show. A known-scam claim cites the list, line and pin. Use the exact severity and check from the lead. Write short sentences. End each explanation with Fix:. Never access the internet.',
  tools,
  kickoff: (ws, env) => 'Review every lead, worst first. Submit supported evidence with its exact lead id, then continue. Summarize coverage, including any evidence-missing lead. Leads: ' + (env.LEADS ?? 'Call snapshot_leads.'),
  nudge: () => null, prepass,
  prove: (ws, found, events, log) => proveFindings(ws, found, events, log, { detectors }),
};
