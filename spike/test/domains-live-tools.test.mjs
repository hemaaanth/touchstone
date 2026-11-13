// The live capture path, on the owned lab only. No public target is scanned.
// One capture carries all three new evidence types through to leads, the same
// way a real run does.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pinSnapshot, replayEvidence } from '../lib/proof-evidence.mjs';
import { analyzeSnapshot, detectorsFor, domainLeads } from '../packs/domains/checks.mjs';
import { startLab } from '../packs/domains/labctl.mjs';
// grant-store reads the console token when it loads (via live.mjs). Point it at test
// values first, so no real token, grant or scope file is read (1h review F4).
const tokenStore = mkdtempSync(join(tmpdir(), 'domains-live-tools-store-'));
process.env.TOUCHSTONE_GRANT_TOKEN = 'test-token-not-real';
process.env.TOUCHSTONE_GRANTS_FILE = join(tokenStore, 'grants.json');
process.env.TOUCHSTONE_SCOPES_FILE = join(tokenStore, 'scopes.json');
process.on('exit', () => rmSync(tokenStore, { recursive: true, force: true }));
const { captureDomain } = await import('../packs/domains/live.mjs');
let lab, ws, snapshot, leads, snapshotHash;
before(async () => {
  lab = await startLab();
  ws = mkdtempSync(join(tmpdir(), 'domains-live-tools-'));
  snapshot = await captureDomain({ ws, domain: 'touchstone.test', reach: { network: lab.network, resolver: lab.resolver, ports: [{ scheme: 'http', port: 8080 }, { scheme: 'https', port: 8443 }], granted: true, scope: lab.scope } });
  snapshotHash = pinSnapshot(ws, snapshot);
  leads = domainLeads(snapshot, await analyzeSnapshot(snapshot));
});
after(async () => {
  await lab?.stop();
  if (ws) rmSync(ws, { recursive: true, force: true });
});

test('every new tool reports a coverage row and no evidence gap', () => {
  const coverage = snapshot.discovery.coverage;
  for (const engine of ['checkdmarc', 'dnsviz-probe', 'dnsviz-grok']) {
    assert.equal(coverage.find(c => c.engine === engine)?.status, 'ran', engine + ': ' + JSON.stringify(coverage));
  }
  const tls = coverage.filter(c => String(c.engine).startsWith('testssl'));
  assert(tls.length > 0);
  assert(tls.every(c => c.status === 'ran'), JSON.stringify(tls));
  // CAA was asked through the lab resolver (drill), not testssl.
  assert.equal(coverage.find(c => c.engine === 'caa')?.status, 'ran', 'caa: ' + JSON.stringify(coverage));
  for (const check of ['email-auth-evidence-missing', 'tls-evidence-missing', 'dnssec-evidence-missing']) {
    assert.equal(leads.some(l => l.check === check), false, check);
  }
});

test('the lab gaps reach the lead list', () => {
  assert(leads.some(l => l.check === 'email-spf-missing' && l.where === 'touchstone.test'));
  assert(leads.some(l => l.check === 'email-dmarc-missing' && l.where === 'touchstone.test'));
  assert(leads.some(l => l.check === 'dnssec-unsigned' && l.where === 'touchstone.test'));
  const tls = leads.filter(l => l.check === 'tls-cert_chain_of_trust');
  assert(tls.length > 0);
  assert(tls.every(l => l.severity === 'critical' && l.where.endsWith(':8443')));
  // The lab zone publishes no CAA record, so the LOW lead is raised for the root.
  assert(leads.some(l => l.check === 'tls-dns_caarecord' && l.severity === 'low' && l.where === 'touchstone.test'), 'caa lead');
});

test('one lead from each tool replays from the pin', async () => {
  for (const check of ['email-spf-missing', 'dnssec-unsigned', 'tls-cert_chain_of_trust', 'tls-dns_caarecord']) {
    const lead = leads.find(l => l.check === check);
    const proof = await replayEvidence(ws, { check, where: lead.where, snapshotHash }, { detectors: detectorsFor('domains') });
    assert.equal(proof.status, 'pass', check);
  }
});
