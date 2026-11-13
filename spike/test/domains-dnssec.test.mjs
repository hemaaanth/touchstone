import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTool } from '../lib/wrap.mjs';
import { pinSnapshot, replayEvidence, sha256 } from '../lib/proof-evidence.mjs';
import { detectorsFor } from '../packs/domains/checks.mjs';
import { assessmentCoverage, captureDnssec, dnssecLeads, parseDnssec, DNSVIZ } from '../packs/domains/dnssec.mjs';
const secure = readFileSync(new URL('../packs/domains/fixtures/dnsviz-example.com.json', import.meta.url), 'utf8');
const insecure = readFileSync(new URL('../packs/domains/fixtures/dnsviz-unsigned.json', import.meta.url), 'utf8');
const bogus = readFileSync(new URL('../packs/domains/fixtures/dnsviz-bogus.json', import.meta.url), 'utf8');
const root = 'example.com';
const evidence = () => parseDnssec(secure, root);
// The snapshot stores the grok file text and its hash. Tests change the tool
// JSON, never a derived field, because leads re-parse the file.
const stored = (output, domain = root) => ({ domain, raw: sha256(output), output });
const edited = change => { const doc = JSON.parse(secure); change(doc['example.com.']); return stored(JSON.stringify(doc)); };

test('a secure chain is read as validated and raises no lead', () => {
  const dnssec = evidence();
  assert.equal(dnssec.delegation, 'SECURE');
  assert.equal(dnssec.signed, true);
  assert.equal(dnssec.complete, true);
  assert.equal(dnssec.validatedChain, true);
  assert.equal(dnssec.raw, sha256(secure));
  assert.deepEqual(dnssecLeads({ root, dnssec: stored(secure) }), []);
});

test('an unsigned zone is read as insecure, not as unread', () => {
  const dnssec = parseDnssec(insecure, 'touchstone.test');
  assert.equal(dnssec.delegation, 'INSECURE');
  assert.equal(dnssec.signed, false);
  const [lead] = dnssecLeads({ root: 'touchstone.test', dnssec: stored(insecure, 'touchstone.test') });
  assert.equal(lead.check, 'dnssec-unsigned');
  assert.equal(lead.severity, 'low');
  assert.match(lead.description, /not signed/);
});

test('the recorded signed-then-broken answer is a high broken-chain lead', () => {
  const dnssec = parseDnssec(bogus, 'touchstone.test');
  assert.equal(dnssec.complete, true);
  assert.equal(dnssec.delegation, 'SECURE');
  assert.equal(dnssec.validatedChain, false);
  assert(dnssec.errors.some(e => e.code === 'SIGNATURE_INVALID'));
  const [lead] = dnssecLeads({ root: 'touchstone.test', dnssec: stored(bogus, 'touchstone.test') });
  assert.equal(lead.check, 'dnssec-broken-chain');
  assert.equal(lead.severity, 'high');
  assert.match(lead.description, /signature/);
});

test('a bogus delegation is broken even with no DNSKEY and no error text', () => {
  const output = JSON.stringify({ 'example.com.': { status: 'NOERROR', delegation: { status: 'BOGUS' }, queries: {} } });
  const dnssec = parseDnssec(output, root);
  assert.equal(dnssec.complete, true);
  assert.equal(dnssec.signed, false);
  assert.equal(dnssecLeads({ root, dnssec: stored(output) })[0].check, 'dnssec-broken-chain');
});

test('an incomplete assessment is missing evidence, not a verdict', () => {
  const incomplete = [
    { 'example.com.': {} },
    { 'example.com.': { dnskey: [{}], delegation: { status: 'SECURE' } } },
    { 'example.com.': { delegation: { status: 'SECURE' } } },
    { 'example.com.': { delegation: { status: 'INSECURE' } } },
  ];
  for (const doc of incomplete) {
    const dnssec = parseDnssec(JSON.stringify(doc), root);
    assert.equal(dnssec.complete, false, JSON.stringify(doc));
    const [lead] = dnssecLeads({ root, dnssec: stored(JSON.stringify(doc)) });
    assert.equal(lead.check, 'dnssec-evidence-missing', JSON.stringify(doc));
    assert.match(lead.description, /incomplete/);
  }
  const unsignedText = JSON.stringify({ 'example.com.': { delegation: { status: 'INSECURE' }, queries: { 'example.com./IN/DNSKEY': { nodata: [{}] } } } });
  assert.equal(parseDnssec(unsignedText, root).complete, true);
  assert.equal(dnssecLeads({ root, dnssec: stored(unsignedText) })[0].check, 'dnssec-unsigned');
  const emptyAnswer = parseDnssec(JSON.stringify({ 'example.com.': { delegation: { status: 'INSECURE' }, queries: { 'example.com./IN/DNSKEY': { nodata: [] } } } }), root);
  assert.equal(emptyAnswer.complete, false);
});

test('a signed zone whose parent has no DS is a distinct no-DS lead', () => {
  const output = JSON.stringify({ 'example.com.': { status: 'NOERROR', delegation: { status: 'INSECURE' }, dnskey: [{ key_tag: 1, algorithm: 13 }], queries: { 'example.com./IN/DNSKEY': { answer: [{}] } } } });
  const dnssec = parseDnssec(output, root);
  assert.equal(dnssec.complete, true);
  const [lead] = dnssecLeads({ root, dnssec: stored(output) });
  assert.equal(lead.check, 'dnssec-no-ds');
  // m1: DNSViz says INSECURE also when the parent is unsigned or the DS is
  // unusable. The text claims only what the verdict proves.
  assert.doesNotMatch(lead.description, /parent publishes no DS/);
  assert.match(lead.description, /not anchored/);
  assert.match(lead.description, /parent is unsigned/);
  assert.match(lead.description, /DS record is missing or unusable/);
  assert.equal(assessmentCoverage(dnssec), null);
});

test('an incomplete assessment marks the coverage rows unavailable', () => {
  assert.equal(assessmentCoverage({ complete: true }), null);
  assert.deepEqual(assessmentCoverage({ complete: false, reason: 'no DNSKEY answer' }), { status: 'unavailable', reason: 'incomplete assessment: no DNSKEY answer' });
});

test('a warning on a secure chain is a low lead', () => {
  const dnssec = edited(entry => { entry.warnings = [{ code: 'SOA_SERIAL', description: 'SOA serial is low' }]; });
  const [lead] = dnssecLeads({ root, dnssec });
  assert.equal(lead.check, 'dnssec-warning');
  assert.match(lead.description, /SOA serial is low/);
});

test('a record without raw or output, or with an unknown verdict, is a gap, never a crash', () => {
  const noRaw = stored(secure);
  delete noRaw.raw;
  const unknown = edited(entry => { entry.delegation.status = 'UNKNOWN'; });
  for (const [dnssec, why] of [[noRaw, /no tool output hash/], [evidence(), /no stored tool output/], [unknown, /no chain verdict/], [{}, /no tool output hash/]]) {
    const leads = dnssecLeads({ root, dnssec });
    assert.deepEqual(leads.map(l => l.check), ['dnssec-evidence-missing']);
    assert.match(leads[0].description, why);
  }
  // The file must be an assessment of the snapshot root.
  assert.match(dnssecLeads({ root: 'other.test', dnssec: stored(secure) })[0].description, /assessed no entry for other\.test/);
});

// M-C: a damaged warning or error element is a gap, never a crash.
test('a null warning or error element is a gap, not a crash', () => {
  for (const change of [d => { d.warnings = [null]; }, d => { d.errors = [null]; }, d => { d.warnings = [{ code: 'X' }]; }, d => { d.delegation.errors = [{ description: 'no code' }]; }]) {
    const dnssec = edited(change);
    assert.deepEqual(dnssecLeads({ root, dnssec }).map(l => l.check), ['dnssec-evidence-missing']);
    assert.match(dnssecLeads({ root, dnssec })[0].description, /with no code or description/);
  }
});

test('missing evidence is a coverage gap that names the failure', () => {
  const [lead] = dnssecLeads({ root, discovery: { coverage: [{ engine: 'dnsviz-probe', status: 'unavailable', reason: 'manifest unknown' }] } });
  assert.equal(lead.check, 'dnssec-evidence-missing');
  assert.match(lead.description, /manifest unknown/);
  assert.match(dnssecLeads({ root })[0].description, /without a DNSSEC probe/);
});

test('the parser refuses an assessment without the domain', () => {
  assert.throws(() => parseDnssec(secure, 'other.test'), /assessed no entry/);
  assert.throws(() => parseDnssec('not json', root));
});

test('a probe error and an unreadable assessment both come back as an error', async () => {
  const failed = async () => ({ code: 125, stdout: '', stderr: 'docker: manifest unknown', timedOut: false });
  const result = await captureDnssec(failed, null, root, null);
  assert.equal(result.evidence, null);
  assert.match(result.error, /manifest unknown/);
  const ws = mkdtempSync(join(tmpdir(), 'dnssec-bad-'));
  mkdirSync(join(ws, '.live'));
  try {
    const seen = [];
    const grokSilent = async (engine, opts) => { seen.push([engine, opts.network]); return { code: 0, stderr: '', timedOut: false }; };
    const unreadable = await captureDnssec(grokSilent, ws, root, null);
    assert.equal(unreadable.evidence, null);
    assert.equal(unreadable.error, 'output file missing');
    assert.deepEqual(seen.find(([engine]) => engine === 'dnsviz-grok'), ['dnsviz-grok', 'none']);
    // grok can write a readable file and still fail; the exit status decides.
    const grokFailed = async engine => {
      if (engine === 'dnsviz-probe') return { code: 0, stderr: '', timedOut: false };
      writeFileSync(join(ws, '.live', 'dnssec.json'), secure);
      return { code: 3, stderr: 'dnsviz: assessment crashed', timedOut: false };
    };
    const failedGrok = await captureDnssec(grokFailed, ws, root, null);
    assert.equal(failedGrok.evidence, null);
    assert.match(failedGrok.error, /assessment crashed/);
    const grokTimeout = async engine => engine === 'dnsviz-probe'
      ? { code: 0, stderr: '', timedOut: false }
      : { code: 0, stderr: '', timedOut: true };
    assert.match((await captureDnssec(grokTimeout, ws, root, null)).error, /timed out/);
    // A good run stores the grok file text and the hash of its bytes.
    const grokOk = async engine => {
      if (engine === 'dnsviz-grok') writeFileSync(join(ws, '.live', 'dnssec.json'), secure);
      return { code: 0, stderr: '', timedOut: false };
    };
    const ok = await captureDnssec(grokOk, ws, root, null);
    assert.deepEqual(ok.record, stored(secure));
    assert.equal(ok.record.raw, sha256(readFileSync(join(ws, '.live', 'dnssec.json'))));
    assert.equal(ok.evidence.validatedChain, true);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('dnssec checks replay from the pinned snapshot', async () => {
  const snapshot = { schema: 1, root: 'touchstone.test', zone: '$ORIGIN touchstone.test.\n$TTL 60\n@ IN SOA ns.touchstone.test. hostmaster.touchstone.test. ( 1 60 60 3600 60 )\n', dns: [], http: [], dnssec: stored(insecure, 'touchstone.test'), rdap: null, contenthash: null };
  const ws = mkdtempSync(join(tmpdir(), 'dnssec-replay-'));
  try {
    const snapshotHash = pinSnapshot(ws, snapshot);
    const options = { detectors: detectorsFor() };
    const proof = { check: 'dnssec-unsigned', where: 'touchstone.test', snapshotHash };
    assert.equal((await replayEvidence(ws, proof, options)).status, 'pass');
    assert.equal((await replayEvidence(ws, { ...proof, where: 'other.test' }, options)).status, 'fail');
    writeFileSync(join(ws, 'snapshot.json'), JSON.stringify({ ...snapshot, dnssec: stored(secure.replaceAll('example.com.', 'touchstone.test.'), 'touchstone.test') }));
    assert.equal((await replayEvidence(ws, proof, options)).status, 'fail');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('the pinned image validates example.com through runTool (TOUCHSTONE_LIVE=1)', { skip: process.env.TOUCHSTONE_LIVE ? false : 'set TOUCHSTONE_LIVE=1 to scan example.com', timeout: 300000 }, async () => {
  const ws = mkdtempSync(join(tmpdir(), 'dnssec-live-'));
  mkdirSync(join(ws, '.live'));
  const ran = [];
  const run = async (engine, opts) => {
    const result = await runTool({ ws, network: 'bridge', ...opts });
    ran.push({ engine, code: result.code, reason: result.stderr.slice(-160) });
    return result;
  };
  try {
    const { evidence: dnssec, error } = await captureDnssec(run, ws, root, '1.1.1.1');
    assert.equal(error, null, JSON.stringify(ran));
    assert.equal(dnssec.validatedChain, true);
    assert.equal(dnssec.signed, true);
    assert.match(DNSVIZ, /@sha256:[0-9a-f]{64}$/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});
