// Phishing pack: offline replay of the pinned lab capture and the vendored MetaMask slice.
// runTool is mocked with real dnstwist `--format list` output recorded in packs/phishing/validation/.
// No test here resolves a name or opens a network: the mock refuses any call that is not offline generation.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const PACK = fileURLToPath(new URL('../packs/phishing/', import.meta.url));
const LAB = join(PACK, 'lab');
const recorded = domain => readFileSync(join(PACK, 'validation', 'dnstwist-list-' + domain + '.txt'), 'utf8');
// Keep the real helpers other packs import. Replace only runTool and runDocker.
const real = await import('../lib/wrap.mjs?real');
const calls = [];
mock.module('../lib/wrap.mjs', { exports: {
  ...real,
  runTool: async (opts) => {
    calls.push(opts);
    if (opts.network !== 'none' || opts.cmd[0] !== '--format' || opts.cmd[1] !== 'list') throw new Error('Test path must stay offline: ' + JSON.stringify(opts.cmd));
    return { code: 0, stdout: recorded(opts.cmd.at(-1)), stderr: '', timedOut: false };
  },
  runDocker: async () => { throw new Error('runDocker is not allowed in tests'); },
} });
// Any DNS lookup in the test path is a failure.
const dnsCalls = [];
for (const fn of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveMx', 'resolveNs', 'resolveAny']) {
  mock.method(dns, fn, (...args) => { dnsCalls.push([fn, args[0]]); throw new Error('DNS is not allowed in tests'); });
  mock.method(dns.promises, fn, async (...args) => { dnsCalls.push([fn, args[0]]); throw new Error('DNS is not allowed in tests'); });
}

const { scanSnapshot, phishingLeads, detectors, METAMASK, regenerate, fingerprint } = await import('../packs/phishing/checks.mjs');
const { replayEvidence, pinSnapshot } = await import('../lib/proof-evidence.mjs');
const { default: pack } = await import('../packs/phishing/pack.mjs');
const { PACKS, packList } = await import('../packs/index.mjs');

const scan = await scanSnapshot(LAB);
const lead = (check, domain) => scan.leads.find(l => l.check === check && l.where.domain === domain);
const replay = (check, where, ws = LAB, hash = scan.snapshotHash) => replayEvidence(ws, { check, where, snapshotHash: hash }, { detectors });

after(() => {
  assert.deepEqual(dnsCalls, [], 'no test may resolve a name');
  assert.ok(calls.length > 0);
  assert.ok(calls.every(c => c.network === 'none'), 'every tool call ran with --network none');
});

test('a registered, resolving lookalike is confirmed with its captured records', async () => {
  const l = lead('registered-lookalike', 'tldekeep.test');
  assert.ok(l, 'tldekeep.test lead');
  assert.deepEqual(l.where, { domain: 'tldekeep.test', fuzzer: 'homoglyph', A: '192.0.2.10', MX: 'mail.tldekeep.test' });
  assert.equal(l.severity, 'medium');
  assert.equal(l.reviewOnly, undefined);
  assert.equal((await replay(l.check, l.where)).status, 'pass');
  // A changed record does not replay.
  assert.equal((await replay(l.check, { ...l.where, A: '192.0.2.99' })).status, 'fail');
});

test('a blocklisted lookalike is confirmed with the list and the line', async () => {
  const l = lead('known-scam-lookalike', 'tidekep.test');
  assert.ok(l, 'tidekep.test lead');
  const text = readFileSync(join(LAB, 'blocklists', 'touchstone-lab-blocklist.json'), 'utf8').split('\n');
  assert.equal(text[11].trim(), '"tidekep.test",');
  assert.equal(l.where.list, 'touchstone-lab-blocklist');
  assert.equal(l.where.line, '12');
  assert.match(l.where.pin, /^sha256:[0-9a-f]{64}$/);
  assert.match(l.description, /synthetic lab list/);
  assert.equal(l.severity, 'high');
  assert.equal((await replay(l.check, l.where)).status, 'pass');
  assert.equal((await replay(l.check, { ...l.where, line: '11' })).status, 'fail');
  // It is on the list but has no DNS record, so it is not a registered lookalike.
  assert.equal(lead('registered-lookalike', 'tidekep.test'), undefined);
});

test('a bare generated permutation is not confirmed (vacuity guard)', async () => {
  assert.ok(recorded('tidekeep.test').split('\n').includes('tidekeap.test'), 'dnstwist does generate tidekeap.test');
  assert.equal(scan.leads.filter(l => l.where.domain === 'tidekeap.test').length, 0);
  assert.equal((await replay('registered-lookalike', { domain: 'tidekeap.test', fuzzer: 'vowel-swap', A: '192.0.2.10' })).status, 'fail');
  assert.equal((await replay('known-scam-lookalike', { domain: 'tidekeap.test', list: 'touchstone-lab-blocklist', line: '12', pin: lead('known-scam-lookalike', 'tidekep.test').where.pin })).status, 'fail');
  // ServFail answers are not records.
  assert.equal(scan.leads.filter(l => l.where.domain === 'tidekeep-test.com').length, 0);
  assert.ok(scan.stats.bare > 4000, 'thousands of bare permutations, none confirmed');
  assert.equal(scan.stats.resolving, 1);
});

test('owned, parked and brand-only names never become confirmable findings', async () => {
  assert.equal(scan.leads.filter(l => l.where.domain === 'tide-keep.test').length, 0, 'owned defensive domain');
  const parked = lead('parked-lookalike', 'tidekeeep.test');
  assert.equal(parked.reviewOnly, true);
  assert.equal((await replay('parked-lookalike', parked.where)).status, 'fail');
  const brand = lead('brand-on-blocklist', 'tidekeep-airdrop.test');
  assert.equal(brand.reviewOnly, true);
  assert.equal(scan.leads.filter(l => l.where.domain === 'unrelated-drainer.test').length, 0);
  assert.equal(scan.leads.filter(l => !l.reviewOnly).length, 2, 'exactly the two planted findings');
});

test('the real MetaMask slice confirms a real metamask.io lookalike at its upstream line', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'phishing-mm-'));
  try {
    const text = readFileSync(join(PACK, METAMASK.file), 'utf8');
    writeFileSync(join(ws, '.touchstone.json'), JSON.stringify({ pack: 'phishing' }));
    const hash = pinSnapshot(ws, { schema: 1, kind: 'phishing', official: ['metamask.io'], owned: [], dnstwist: { code: 0, rows: [], controls: [], generator: fingerprint((await regenerate(['metamask.io'])).names) }, blocklists: [{ ...METAMASK, text }] });
    const s = await scanSnapshot(ws);
    const l = s.leads.find(x => x.check === 'known-scam-lookalike' && x.where.domain === 'metamcsk.io');
    assert.deepEqual(l.where, { domain: 'metamcsk.io', list: 'metamask-eth-phishing-detect', line: '96', pin: '82d3512c593b6d85d24e885bfb19afa7f5e452fa' });
    assert.equal(text.split('\n')[96 - METAMASK.firstLine].trim(), '"metamcsk.io",');
    assert.equal((await replay(l.check, l.where, ws, hash)).status, 'pass');
    assert.equal(s.leads.filter(x => x.check === 'known-scam-lookalike').length, 16, 'every dnstwist permutation of metamask.io in the slice');
    // No captured rows, so the empty capture is flagged, not treated as "nothing registered".
    assert.ok(s.leads.some(x => x.check === 'lookalike-evidence-missing' && x.where === 'dnstwist-capture'));
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('empty, stub, changed or unpinned blocklists raise blocklist-evidence-missing, never a pass', async () => {
  const { snapshot } = (await import('../lib/proof-evidence.mjs')).loadSnapshot(LAB);
  const lab = snapshot.blocklists.find(b => b.synthetic);
  const variants = {
    empty: { ...lab, text: '' },
    stub: { ...lab, text: '{"version":2,"blacklist":[]}', sha256: (await import('node:crypto')).createHash('sha256').update('{"version":2,"blacklist":[]}').digest('hex') },
    changed: { ...lab, text: lab.text.replace('unrelated-drainer.test', 'unrelated-drainer.tesx') },
    unpinned: { ...METAMASK, text: readFileSync(join(PACK, METAMASK.file), 'utf8'), commit: 'main' },
  };
  for (const [kind, list] of Object.entries(variants)) {
    const out = await phishingLeads({ ...snapshot, blocklists: [list] });
    assert.ok(out.leads.some(l => l.check === 'blocklist-evidence-missing' && l.reviewOnly), kind);
    assert.equal(out.leads.filter(l => l.check === 'known-scam-lookalike').length, 0, kind);
    assert.ok(out.coverage.some(c => c.engine === 'blocklist:' + list.name && c.status === 'unavailable' && c.reason), kind);
  }
  // A synthetic list outside a lab snapshot is not evidence.
  const real = await phishingLeads({ ...snapshot, lab: false });
  assert.ok(real.leads.some(l => l.check === 'blocklist-evidence-missing' && l.where.list === 'touchstone-lab-blocklist'));
  // No list at all is flagged too.
  const none = await phishingLeads({ ...snapshot, blocklists: [] });
  assert.ok(none.leads.some(l => l.check === 'blocklist-evidence-missing' && l.where === 'no pinned blocklist'));
});

test('a captured row dnstwist did not generate is not confirmed', async () => {
  const { snapshot } = (await import('../lib/proof-evidence.mjs')).loadSnapshot(LAB);
  const forged = { ...snapshot, dnstwist: { ...snapshot.dnstwist, rows: [...snapshot.dnstwist.rows, { domain: 'evil-unrelated.test', fuzzer: 'homoglyph', dns_a: ['192.0.2.66'] }] } };
  const out = await phishingLeads(forged);
  assert.equal(out.leads.filter(l => l.where.domain === 'evil-unrelated.test').length, 0);
  assert.equal(out.stats.notGenerated, 1);
});

test('the pack is registered, live-capable, leads only, and its prepass reports coverage', async () => {
  assert.equal(PACKS.phishing, pack);
  assert.deepEqual(packList().find(p => p.id === 'phishing'), { id: 'phishing', title: pack.title, tier: 'P', proof: 'none', live: true, scanNet: 'open' });
  const { record } = await pack.prepass(LAB);
  assert.equal(record.snapshotHash, scan.snapshotHash);
  const engines = Object.fromEntries(record.coverage.map(c => [c.engine, c]));
  assert.equal(engines['dnstwist-capture'].status, 'ran');
  assert.equal(engines.dnstwist.status, 'ran');
  assert.equal(engines['blocklist:metamask-eth-phishing-detect'].status, 'ran');
  assert.equal(engines['blocklist:touchstone-lab-blocklist'].leads, 2);
  // Leads only: no phishing result may be proven, whatever is passed in.
  assert.deepEqual(pack.tools(LAB, { found: [] }).map(t => t.name), ['snapshot_leads']);
  const found = scan.leads.filter(l => !l.reviewOnly).map((l, i) => ({ n: i + 1, title: l.check, severity: l.severity, poc: l.id, evidence: { check: l.check, where: l.where, snapshotHash: scan.snapshotHash } }));
  assert.equal(found.length, 2);
  assert.deepEqual(await pack.prove(LAB, found, [], () => {}), []);
  assert.doesNotMatch(pack.system() + pack.kickoff(LAB, {}), /submit/i);
  assert.match(pack.system(), /leads only/i);
});
