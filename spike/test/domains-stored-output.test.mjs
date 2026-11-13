// B1: replay re-parses the stored tool output. It never trusts a stored verdict.
// The three attack inputs come from review 3. Each one writes a matching pin,
// so only the stored-output check can stop it.
import "./helpers/isolated-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pinSnapshot, replayEvidence, sha256 } from '../lib/proof-evidence.mjs';
import { detectorsFor } from '../packs/domains/checks.mjs';
import { emailLeads, parseCheckdmarc } from '../packs/domains/email.mjs';
import { tlsLeads } from '../packs/domains/tls.mjs';
import { dnssecLeads } from '../packs/domains/dnssec.mjs';
const fixture = name => readFileSync(new URL('../packs/domains/fixtures/' + name, import.meta.url), 'utf8');
const checkdmarc = fixture('checkdmarc-example.com.json');
const root = 'example.com';
const checks = leads => leads.map(l => l.check);
const base = { schema: 1, root, zone: '$ORIGIN example.com.\n$TTL 60\n@ IN SOA ns.example.com. hostmaster.example.com. ( 1 60 60 3600 60 )\n', dns: [], http: [], rdap: null, contenthash: null };

test('attack 1: a stored dmarc state of absent with the honest hash is not a lead', async () => {
  // The real example.com output publishes DMARC. Only the derived field lies.
  const email = { ...parseCheckdmarc(checkdmarc, root), output: checkdmarc };
  assert.equal(email.raw, sha256(checkdmarc));
  email.dmarc = { ...email.dmarc, state: 'absent', record: null };
  assert.equal(checks(emailLeads({ root, email })).includes('email-dmarc-missing'), false);
  const ws = mkdtempSync(join(tmpdir(), 'stored-email-'));
  try {
    const snapshotHash = pinSnapshot(ws, { ...base, email });
    const proof = await replayEvidence(ws, { check: 'email-dmarc-missing', where: root, snapshotHash }, { detectors: detectorsFor('domains') });
    assert.equal(proof.status, 'fail');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('attack 2: a TLS entry with the hash of nothing and grade A+ is a gap, not clean', () => {
  const entry = { url: 'https://example.com', host: 'example.com', port: 443, raw: sha256(''), grade: 'A+', scans: [{ ip: '192.0.2.1', findings: [] }] };
  assert.deepEqual(tlsLeads({ root, tls: [entry] }).map(l => [l.check, l.where]), [['tls-evidence-missing', 'https://example.com']]);
});

test('attack 3: DNSSEC with an all-zero hash and SECURE is a gap, not clean', () => {
  const dnssec = { domain: root, raw: '0'.repeat(64), status: 'NOERROR', delegation: 'SECURE', signed: true, complete: true, reason: null, validatedChain: true, errors: [], warnings: [] };
  assert.deepEqual(checks(dnssecLeads({ root, dnssec })), ['dnssec-evidence-missing']);
});

test('a hash mismatch, an array hash or a missing output is a gap for every tool', () => {
  const tlsText = fixture('testssl-example.com.json');
  const dnsText = fixture('dnsviz-example.com.json');
  const stored = {
    email: { domain: root, raw: sha256(checkdmarc), output: checkdmarc },
    tls: { url: 'https://example.com', host: 'example.com', port: 443, raw: sha256(tlsText), output: tlsText },
    dnssec: { domain: root, raw: sha256(dnsText), output: dnsText },
  };
  const leadsOf = (key, entry) => key === 'email' ? emailLeads({ root, email: entry }) : key === 'tls' ? tlsLeads({ root, tls: [entry] }) : dnssecLeads({ root, dnssec: entry });
  const gap = { email: 'email-auth-evidence-missing', tls: 'tls-evidence-missing', dnssec: 'dnssec-evidence-missing' };
  for (const [key, entry] of Object.entries(stored)) {
    // The honest record gives real leads, not a gap.
    assert.equal(checks(leadsOf(key, entry)).includes(gap[key]), false, key);
    for (const [name, change] of [
      ['edited output', e => ({ ...e, output: e.output.replace('example.com', 'example.org') })],
      ['array raw', e => ({ ...e, raw: [e.raw] })],
      ['no output', e => { const { output, ...rest } = e; return rest; }],
      ['output not text', e => ({ ...e, output: JSON.parse(e.output) })],
    ]) {
      assert.deepEqual(checks(leadsOf(key, change(entry))), [gap[key]], key + ': ' + name);
    }
  }
});
