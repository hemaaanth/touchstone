import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTool } from '../lib/wrap.mjs';
import { pinSnapshot, replayEvidence } from '../lib/proof-evidence.mjs';
import { detectorsFor } from '../packs/domains/checks.mjs';
import { captureTls, parseTestssl, testsslTargets, tlsLeads, TESTSSL } from '../packs/domains/tls.mjs';
const real = readFileSync(new URL('../packs/domains/fixtures/testssl-example.com.json', import.meta.url), 'utf8');
const lab = readFileSync(new URL('../packs/domains/fixtures/testssl-lab.json', import.meta.url), 'utf8');
const endpoint = { origin: 'https://example.com', host: 'example.com', port: 443 };
const labEndpoint = { origin: 'https://www.touchstone.test:8443', host: 'www.touchstone.test', port: 8443 };

test('the recorded example.com answer keeps the graded findings', () => {
  const report = parseTestssl(real, endpoint);
  assert.equal(report.url, 'https://example.com');
  assert.equal(report.grade, 'B');
  assert.equal(report.scans.length, 2);
  const ids = report.scans.flatMap(scan => scan.findings.map(f => f.id));
  assert(ids.some(id => id.startsWith('cert_keyUsage')));
  assert(ids.includes('TLS1'));
  assert.equal(ids.includes('overall_grade'), true);
  assert.equal(report.problems.length, 1);
});

test('the lab self-signed answer grades the chain as critical', () => {
  const report = parseTestssl(lab, labEndpoint);
  assert.equal(report.grade, 'T');
  assert.deepEqual(report.scans[0].findings.map(f => f.id).filter(id => id.startsWith('cert_chain')), ['cert_chain_of_trust']);
});

test('the parser refuses an answer with no measured scan or no grade', () => {
  assert.throws(() => parseTestssl('{"scanResult":[]}', endpoint), /scanned no address/);
  assert.throws(() => parseTestssl('{"scanResult":[{}]}', endpoint), /no measured address/);
  const noGrade = JSON.parse(real);
  delete noGrade.scanResult[0].rating;
  assert.throws(() => parseTestssl(JSON.stringify(noGrade), endpoint), /no grade/);
  const emptyGrade = JSON.parse(real);
  for (const scan of emptyGrade.scanResult) scan.rating[0].finding = '';
  assert.throws(() => parseTestssl(JSON.stringify(emptyGrade), endpoint), /no grade/);
  const fatal = JSON.parse(real);
  fatal.scanResult[0].scanProblem = { severity: 'FATAL', code: 'CONNECT_FAILED', finding: 'cannot connect' };
  assert.throws(() => parseTestssl(JSON.stringify(fatal), endpoint), /FATAL/);
  assert.throws(() => parseTestssl('not json', endpoint));
});

test('a failed endpoint of two keeps its own missing-evidence lead', () => {
  const good = parseTestssl(real, endpoint);
  const leads = tlsLeads({ root: 'example.com', tls: [good, { url: 'https://b.example.com', host: 'b.example.com', port: 443, error: 'exit code 124' }] });
  const gap = leads.filter(l => l.check === 'tls-evidence-missing');
  assert.deepEqual(gap.map(l => l.where), ['https://b.example.com']);
  assert.match(gap[0].description, /exit code 124/);
  assert(leads.some(l => l.where === 'https://example.com'));
  const both = tlsLeads({ root: 'example.com', tls: [{ url: 'https://a.test', error: 'timed out' }, { url: 'https://b.test', error: 'exit code 1' }] });
  assert.deepEqual(both.map(l => l.where).sort(), ['https://a.test', 'https://b.test']);
  assert(both.every(l => l.check === 'tls-evidence-missing'));
});

test('leads keep one row per check and drop OK and INFO', () => {
  const snapshot = { root: 'example.com', tls: [parseTestssl(real, endpoint)] };
  const leads = tlsLeads(snapshot);
  const checks = leads.map(l => l.check);
  assert.equal(new Set(checks).size, checks.length);
  assert(leads.some(l => l.check === 'tls-cert_keyusage' && l.severity === 'high' && l.where === 'https://example.com'));
  assert(leads.some(l => l.check === 'tls-tls1' && l.severity === 'low'));
  assert(checks.every(check => check.startsWith('tls-')));
});

test('a self-signed chain is a critical lead and the grade is cited', () => {
  const [lead] = tlsLeads({ root: 'www.touchstone.test', tls: [parseTestssl(lab, labEndpoint)] }).filter(l => l.check === 'tls-cert_chain_of_trust');
  assert.equal(lead.severity, 'critical');
  assert.match(lead.description, /self signed/);
  assert.match(lead.description, /grade is T/);
});

test('targets are https origins only, once each, capped', () => {
  const urls = ['http://a.test:8080/x', 'https://a.test/y', 'https://a.test/z', 'https://b.test', 'https://c.test', 'https://d.test'];
  assert.deepEqual(testsslTargets(urls).map(t => t.origin), ['https://a.test', 'https://b.test']);
  assert.deepEqual(testsslTargets([]), []);
});

test('a tool error and an unparsable answer are collected per endpoint', async () => {
  const failed = async () => ({ code: 125, stdout: '', stderr: 'docker: manifest unknown', timedOut: false });
  const empty = async () => ({ code: 0, stderr: '', timedOut: false });
  const result = await captureTls(failed, null, [endpoint], () => null);
  assert.deepEqual(result.evidence, []);
  assert.match(result.errors[0], /manifest unknown/);
  const unparsable = await captureTls(async () => ({ code: 0, stderr: '', timedOut: false }), null, [{ ...endpoint }], () => null);
  assert.equal(unparsable.errors.length, 1);
  assert.doesNotMatch(unparsable.errors[0], /\/tmp|\/home/);
  assert.match(unparsable.errors[0], /output file missing/);
  assert.equal(unparsable.entries[0].error, unparsable.errors[0]);
  assert.equal(unparsable.entries[0].url, 'https://example.com');
  assert.equal(typeof empty, 'function');
});

test('an entry without raw, grade or scans is a gap, not a clean result', () => {
  const good = parseTestssl(real, endpoint);
  assert.match(good.raw, /^[0-9a-f]{64}$/);
  const cases = [
    { url: 'https://a.test', host: 'a.test', port: 443, grade: 'B', scans: [] },
    { ...good, grade: '' },
    { ...good, scans: undefined },
  ];
  for (const entry of cases) {
    const leads = tlsLeads({ root: 'example.com', tls: [entry] });
    assert.deepEqual(leads.map(l => [l.check, l.where]), [['tls-evidence-missing', entry.url]], JSON.stringify(entry).slice(0, 120));
  }
  const noRaw = { ...good };
  delete noRaw.raw;
  assert.equal(tlsLeads({ root: 'example.com', tls: [noRaw] })[0].check, 'tls-evidence-missing');
  assert(tlsLeads({ root: 'example.com', tls: [{ url: 'https://x.test' }] }).length === 1);
});

test('tls checks replay from the pinned snapshot, unknown ones do not', async () => {
  const snapshot = { schema: 1, root: 'example.com', zone: '$ORIGIN example.com.\n$TTL 60\n@ IN SOA ns.example.com. hostmaster.example.com. ( 1 60 60 3600 60 )\n', dns: [], http: [], email: { dmarc: { valid: true, policy: 'reject', reports: false }, spf: { valid: true, all: '-all' } }, tls: [parseTestssl(real, endpoint)], rdap: null, contenthash: null };
  const ws = mkdtempSync(join(tmpdir(), 'domain-tls-live-'));
  mkdirSync(join(ws, '.live'));
  try {
    const snapshotHash = pinSnapshot(ws, snapshot);
    const options = { detectors: detectorsFor() };
    const proof = { check: 'tls-cert_keyusage', where: 'https://example.com', snapshotHash };
    assert.equal((await replayEvidence(ws, proof, options)).status, 'pass');
    assert.equal((await replayEvidence(ws, { ...proof, where: 'https://other.example.com' }, options)).status, 'fail');
    assert.equal((await replayEvidence(ws, { ...proof, check: 'tls-invented' }, options)).status, 'fail');
    writeFileSync(join(ws, 'snapshot.json'), JSON.stringify({ ...snapshot, tls: [] }));
    assert.equal((await replayEvidence(ws, proof, options)).status, 'fail');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('the pinned image scans example.com through runTool (TOUCHSTONE_LIVE=1)', { skip: process.env.TOUCHSTONE_LIVE ? false : 'set TOUCHSTONE_LIVE=1 to scan example.com', timeout: 400000 }, async () => {
  const ws = mkdtempSync(join(tmpdir(), 'domain-tls-live-'));
  mkdirSync(join(ws, '.live'));
  const coverage = [];
  const run = async (engine, opts) => {
    const result = await runTool({ ws, network: 'bridge', ...opts });
    coverage.push({ engine, code: result.code, reason: result.stderr.slice(-160) });
    return result;
  };
  try {
    const { evidence, errors } = await captureTls(run, ws, [{ ...endpoint }], () => null);
    assert.deepEqual(errors, []);
    assert.equal(coverage[0].code, 0, coverage[0].reason);
    assert.equal(evidence[0].url, 'https://example.com');
    assert(evidence[0].scans[0].findings.length > 0);
    assert.match(TESTSSL, /@sha256:[0-9a-f]{64}$/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});
