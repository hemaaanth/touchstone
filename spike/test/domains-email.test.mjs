import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTool } from '../lib/wrap.mjs';
import { pinSnapshot, replayEvidence } from '../lib/proof-evidence.mjs';
import { analyzeSnapshot, detectorsFor, domainLeads } from '../packs/domains/checks.mjs';
import { CHECKDMARC, checkEmail, emailLeads, parseCheckdmarc } from '../packs/domains/email.mjs';
import { captureDomain } from '../packs/domains/live.mjs';
const fixture = readFileSync(new URL('../packs/domains/fixtures/checkdmarc-example.com.json', import.meta.url), 'utf8');
const root = 'example.com';
const evidence = () => parseCheckdmarc(fixture, root);

test('the recorded example.com answer keeps the published records', () => {
  const email = evidence();
  assert.equal(email.domain, root);
  assert.equal(email.spf.record, 'v=spf1 -all');
  assert.equal(email.spf.valid, true);
  assert.equal(email.spf.all, '-all');
  assert.equal(email.dmarc.record, 'v=DMARC1;p=reject;sp=reject;adkim=s;aspf=s');
  assert.equal(email.dmarc.policy, 'reject');
  assert.equal(email.dmarc.reports, false);
  assert.equal(email.mx.nullMx, true);
  assert.equal(email.dnssec, true);
});

test('the parser accepts a list and refuses another domain and non-JSON', () => {
  assert.equal(parseCheckdmarc('[' + fixture + ']', root).dmarc.policy, 'reject');
  assert.throws(() => parseCheckdmarc(fixture, 'other.test'), /no result for other\.test/);
  assert.throws(() => parseCheckdmarc('not json', root));
});

test('a parsed record is marked present and a listed absence is marked absent', () => {
  assert.equal(evidence().spf.state, 'present');
  assert.equal(evidence().dmarc.state, 'present');
  const absent = JSON.stringify({ domain: root, spf: { record: null, valid: false, error: 'An SPF record does not exist.', warnings: [] }, dmarc: { record: null, valid: false, error: 'A DMARC record does not exist.', warnings: [] } });
  const email = parseCheckdmarc(absent, root);
  assert.equal(email.spf.state, 'absent');
  assert.equal(email.dmarc.state, 'absent');
  assert.deepEqual(emailLeads({ root, email }).map(l => l.check), ['email-dmarc-missing', 'email-spf-missing']);
});

test('a timeout text is unread, only the tool\'s exact absence text is absent', () => {
  const email = parseCheckdmarc(JSON.stringify({ domain: root, spf: { record: null, valid: false, error: 'Timed out: no answer from 1.1.1.1 for the TXT record' }, dmarc: { record: null, valid: false, error: 'A DMARC record does not exist.' } }), root);
  assert.equal(email.spf.state, 'unread');
  assert.equal(email.dmarc.state, 'absent');
  const checks = emailLeads({ root, email }).map(l => l.check);
  assert.deepEqual(checks, ['email-auth-evidence-missing', 'email-dmarc-missing']);
});

// M-B: checkdmarc 6.0.3 (dmarc.py) adds " for this domain or its parent
// domains." when the name has three or more labels.
test('the parent-domains absence text for a three-label name is absent', () => {
  const name = 'shop.example.co.uk';
  const email = parseCheckdmarc(JSON.stringify({ domain: name, spf: { record: 'v=spf1 -all', valid: true, parsed: { all: 'fail' }, warnings: [] }, dmarc: { record: null, valid: false, error: 'A DMARC record does not exist for this domain or its parent domains.' } }), name);
  assert.equal(email.dmarc.state, 'absent');
  assert.deepEqual(emailLeads({ root: name, email }).map(l => l.check), ['email-dmarc-missing']);
  // Another tail is still not an absence.
  assert.equal(parseCheckdmarc(JSON.stringify({ domain: name, dmarc: { error: 'A DMARC record does not exist for some other reason.' } }), name).dmarc.state, 'unread');
});

test('an answer with no record field is unread, not absent', () => {
  const email = parseCheckdmarc(JSON.stringify({ domain: root }), root);
  assert.equal(email.spf.state, 'unread');
  assert.equal(email.dmarc.state, 'unread');
  const leads = emailLeads({ root, email });
  assert.deepEqual(leads.map(l => l.check), ['email-auth-evidence-missing']);
  assert.match(leads[0].description, /SPF and DMARC/);
  const partial = emailLeads({ root, email: { ...evidence(), spf: { ...evidence().spf, state: 'unread' } } });
  assert(partial[0].check === 'email-auth-evidence-missing');
  assert.match(partial[0].description, /SPF/);
});

test('malformed and permissive records each raise one lead', () => {
  const checks = email => emailLeads({ root, email }).map(l => l.check);
  assert.deepEqual(checks(evidence()), ['email-dmarc-no-reporting']);
  assert.deepEqual(checks({ ...evidence(), dmarc: { ...evidence().dmarc, valid: false } }), ['email-dmarc-invalid']);
  assert.deepEqual(checks({ ...evidence(), dmarc: { ...evidence().dmarc, policy: 'none' } }), ['email-dmarc-policy-none', 'email-dmarc-no-reporting']);
  assert.deepEqual(checks({ ...evidence(), spf: { record: 'v=spf1 +all', valid: true, all: '+all', warnings: [], state: 'present' } }), ['email-dmarc-no-reporting', 'email-spf-allows-all']);
  assert.deepEqual(checks({ ...evidence(), spf: { record: 'v=spf1 include:x.test', valid: false, all: null, warnings: [], state: 'present' } }), ['email-dmarc-no-reporting', 'email-spf-invalid']);
});

test('evidence without a raw hash or a record state is a gap, not a lead', () => {
  const noRaw = { ...evidence() };
  delete noRaw.raw;
  assert.deepEqual(emailLeads({ root, email: noRaw }).map(l => l.check), ['email-auth-evidence-missing']);
  const noState = { ...evidence(), spf: { record: 'v=spf1 -all', valid: true, all: '-all', warnings: [] }, dmarc: { record: 'v=DMARC1;p=reject', valid: true, policy: 'reject', reports: true, warnings: [] } };
  assert.match(emailLeads({ root, email: noState })[0].description, /incomplete/);
  assert.match(evidence().raw, /^[0-9a-f]{64}$/);
});

test('no email evidence is a coverage gap that names the tool failure', () => {
  const [lead] = emailLeads({ root, discovery: { coverage: [{ engine: 'checkdmarc', status: 'unavailable', reason: 'manifest unknown' }] } });
  assert.equal(lead.check, 'email-auth-evidence-missing');
  assert.equal(lead.severity, 'informational');
  assert.match(lead.description, /manifest unknown/);
  assert.match(emailLeads({ root })[0].description, /without an email record scan/);
});

test('a tool error and an unparsable answer come back as an error', async () => {
  const failed = async () => ({ code: 125, stdout: '', stderr: 'docker: manifest unknown', timedOut: false });
  assert.match((await checkEmail(failed, root)).error, /manifest unknown/);
  const garbage = async () => ({ code: 0, stdout: 'garbage', stderr: '', timedOut: false });
  assert.match((await checkEmail(garbage, root)).error, /JSON/);
  const recorded = async () => ({ code: 0, stdout: fixture, stderr: '', timedOut: false });
  assert.equal((await checkEmail(recorded, root)).evidence.dmarc.policy, 'reject');
  const partial = async () => ({ code: 0, stdout: JSON.stringify({ domain: root }), stderr: '', timedOut: false });
  const half = await checkEmail(partial, root);
  assert.equal(half.partial, true);
  assert.match(half.error, /SPF and DMARC/);
});

test('email leads replay from the pinned snapshot', async () => {
  const snapshot = { schema: 1, root, zone: '$ORIGIN example.com.\n$TTL 60\n@ IN SOA ns.example.com. hostmaster.example.com. ( 1 60 60 3600 60 )\n', dns: [], http: [], email: evidence(), rdap: null, contenthash: null };
  const analysis = await analyzeSnapshot(snapshot);
  const lead = domainLeads(snapshot, analysis).find(l => l.check === 'email-dmarc-no-reporting');
  assert.equal(lead.where, root);
  const ws = mkdtempSync(join(tmpdir(), 'domain-email-'));
  try {
    const snapshotHash = pinSnapshot(ws, snapshot);
    const options = { detectors: detectorsFor() };
    const proof = { check: lead.check, where: lead.where, snapshotHash };
    assert.equal((await replayEvidence(ws, proof, options)).status, 'pass');
    writeFileSync(join(ws, 'snapshot.json'), JSON.stringify({ ...snapshot, email: { ...evidence(), dmarc: { ...evidence().dmarc, reports: true } } }));
    assert.equal((await replayEvidence(ws, proof, options)).status, 'fail');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('a real capture stores the email evidence and its lead (TOUCHSTONE_LIVE=1)', { skip: process.env.TOUCHSTONE_LIVE ? false : 'set TOUCHSTONE_LIVE=1 to scan example.com', timeout: 420000 }, async () => {
  const ws = mkdtempSync(join(tmpdir(), 'domain-email-live-'));
  try {
    const snapshot = await captureDomain({ ws, domain: root, reach: { network: 'bridge', granted: true, scope: [root], ports: [{ scheme: 'https', port: 443 }] } });
    const check = snapshot.discovery.coverage.find(c => c.engine === 'checkdmarc');
    assert.equal(check.status, 'ran', check.reason);
    assert.equal(snapshot.email.dmarc.policy, 'reject');
    assert.equal(snapshot.email.dmarc.valid, true);
    const leads = domainLeads(snapshot, await analyzeSnapshot(snapshot));
    assert(leads.some(l => l.check === 'email-dmarc-no-reporting' && l.engine === 'checkdmarc'));
    assert.equal(leads.some(l => l.check === 'email-auth-evidence-missing'), false);
    assert.match(CHECKDMARC, /@sha256:[0-9a-f]{64}$/);
    assert.equal(check.status, 'ran');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});
