// Phishing pack: a tool failure is `unavailable` plus a *-evidence-missing lead, never a pass.
// runTool is mocked to fail the way Docker fails when the image is missing (--pull=never, exit 125).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// prepareWorkspace reads the scope and grant stores. Point them at a temp dir.
const STORE = mkdtempSync(join(tmpdir(), 'phishing-store-'));
process.env.TOUCHSTONE_SCOPES_FILE = join(STORE, 'scopes.json');
process.env.TOUCHSTONE_GRANTS_FILE = join(STORE, 'grants.json');
const LAB = fileURLToPath(new URL('../packs/phishing/lab/', import.meta.url));
const STDERR = "Unable to find image 'touchstone-phishing-dnstwist:20250130' locally\ndocker: Error response from daemon: No such image.";
// Keep the real helpers other packs import. Replace only runTool and runDocker.
const real = await import('../lib/wrap.mjs?real');
const calls = [];
mock.module('../lib/wrap.mjs', { exports: {
  ...real,
  runTool: async (opts) => { calls.push(opts); return { code: 125, stdout: '', stderr: STDERR, timedOut: false }; },
  runDocker: async () => { throw new Error('runDocker is not allowed in tests'); },
} });

const { scanSnapshot, detectors } = await import('../packs/phishing/checks.mjs');
const { captureLookalikes, assertReach } = await import('../packs/phishing/live.mjs');
const { replayEvidence } = await import('../lib/proof-evidence.mjs');
const { coverageOf, default: pack } = await import('../packs/phishing/pack.mjs');
const { prepareWorkspace } = await import('../lib/targets.mjs');

test('dnstwist failure marks coverage unavailable with the stderr reason and raises lookalike-evidence-missing', async () => {
  const scan = await scanSnapshot(LAB);
  const row = scan.coverage.find(c => c.engine === 'dnstwist');
  assert.equal(row.status, 'unavailable');
  assert.match(row.reason, /Docker could not run the image/);
  assert.match(row.reason, /No such image/);
  assert.match(row.reason, /docker build -t touchstone-phishing-dnstwist:20250130/);
  const miss = scan.leads.find(l => l.check === 'lookalike-evidence-missing' && l.where === 'dnstwist');
  assert.ok(miss);
  assert.equal(miss.reviewOnly, true);
  assert.equal(miss.severity, 'informational');
  assert.equal(scan.leads.filter(l => l.check === 'registered-lookalike' || l.check === 'known-scam-lookalike').length, 0);
  // Replay fails closed: the lab's real finding cannot pass without dnstwist.
  const proof = await replayEvidence(LAB, { check: 'registered-lookalike', where: { domain: 'tldekeep.test', fuzzer: 'homoglyph', A: '192.0.2.10', MX: 'mail.tldekeep.test' }, snapshotHash: scan.snapshotHash }, { detectors });
  assert.equal(proof.status, 'fail');
  assert.ok(coverageOf(scan).some(c => c.engine === 'dnstwist' && c.status === 'unavailable'));
});

test('a failed live capture is unavailable, and its snapshot raises lookalike-evidence-missing', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'phishing-cap-'));
  try {
    calls.length = 0;
    const snapshot = await captureLookalikes({ ws, domain: 'tidekeep.test', reach: { network: 'bridge', granted: true, scope: ['tidekeep.test'] } });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].cmd, ['--format', 'json', 'tidekeep.test']);
    assert.equal(snapshot.coverage[0].status, 'unavailable');
    assert.match(snapshot.coverage[0].reason, /No such image/);
    assert.equal(snapshot.dnstwist.code, 125);
    writeFileSync(join(ws, '.touchstone.json'), JSON.stringify({ pack: 'phishing' }));
    const { pinSnapshot } = await import('../lib/proof-evidence.mjs');
    pinSnapshot(ws, snapshot);
    const scan = await scanSnapshot(ws);
    assert.ok(scan.leads.some(l => l.check === 'lookalike-evidence-missing' && l.where === 'dnstwist-capture'));
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('live capture refuses to run without a grant that covers the domain', async () => {
  calls.length = 0;
  assert.throws(() => assertReach({ network: 'bridge', granted: false, scope: ['tidekeep.test'] }, 'tidekeep.test'), /grant/);
  assert.throws(() => assertReach({ network: 'bridge', granted: true, scope: ['other.test'] }, 'tidekeep.test'), /grant/);
  assert.throws(() => assertReach(undefined, 'tidekeep.test'), /reach.network/);
  await assert.rejects(captureLookalikes({ ws: LAB, domain: 'tidekeep.test', reach: { network: 'bridge', granted: false, scope: [] } }), /grant/);
  assert.equal(calls.length, 0, 'no tool ran');
});

test('M-B: a live phishing target must carry an explicit owned list; [] means none', () => {
  const base = { id: 'live-phishing', title: 't', kind: 'live', pack: 'phishing', hosts: ['brand.example'], origins: ['https://brand.example'] };
  assert.throws(() => prepareWorkspace(base, { modules: [] }), /needs an owned list/);
  assert.throws(() => prepareWorkspace({ ...base, owned: 'brand-app.example' }, { modules: [] }), /needs an owned list/);
  const ws = prepareWorkspace({ ...base, owned: [] }, { modules: [] });
  try { assert.deepEqual(JSON.parse(readFileSync(join(ws, '.touchstone.json'), 'utf8')).owned, []); }
  finally { rmSync(ws, { recursive: true, force: true }); }
});

test('M3: a live phishing target gets domain, reach and owned, and its prepass pins instead of throwing', async () => {
  const ws = prepareWorkspace({ id: 'live-phishing', title: 't', kind: 'live', pack: 'phishing', hosts: ['brand.example'], origins: ['https://brand.example'], owned: ['brand-app.example'] }, { modules: [] });
  try {
    calls.length = 0;
    // On 9969ab3 this threw "Missing snapshot SHA-256 pin": the config had no domain.
    const out = await pack.prepass(ws);
    const cfg = JSON.parse(readFileSync(join(ws, '.touchstone.json'), 'utf8'));
    assert.equal(cfg.domain, 'brand.example');
    assert.deepEqual(cfg.reach, { network: 'bridge', granted: true, scope: ['brand.example'] });
    assert.deepEqual(cfg.owned, ['brand-app.example']);
    assert.equal(calls[0].network, 'bridge', 'capture used the granted network');
    assert.deepEqual(calls[0].cmd, ['--format', 'json', 'brand.example']);
    assert.ok(out.record.leads.some(l => l.check === 'lookalike-evidence-missing' && l.where === 'dnstwist-capture'));
    assert.ok(out.record.coverage.some(c => c.engine === 'dnstwist-capture' && c.status === 'unavailable'));
  } finally { rmSync(ws, { recursive: true, force: true }); rmSync(STORE, { recursive: true, force: true }); }
});
