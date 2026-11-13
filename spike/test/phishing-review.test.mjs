// Phishing pack: the review findings on 9969ab3 (REVIEW-FINDINGS.md), one test each.
// Every snapshot here is built in memory from the real dnstwist list recorded in
// packs/phishing/validation/. runTool is mocked to serve that list and refuses any
// call that is not offline generation. No name is resolved.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACK = fileURLToPath(new URL('../packs/phishing/', import.meta.url));
const recorded = domain => readFileSync(join(PACK, 'validation', 'dnstwist-list-' + domain + '.txt'), 'utf8');
const real = await import('../lib/wrap.mjs?real');
const calls = [];
// The live-capture test replays the real lab capture. The main run gets the pinned
// lab rows. A control run gets the single bare row dnstwist printed for the quiet
// lab controls, with the random probe name. No resolver is contacted.
let captured = null;
const liveCalls = [];
mock.module('../lib/wrap.mjs', { exports: {
  ...real,
  runTool: async (opts) => {
    if (captured && opts.cmd[1] === 'json') {
      liveCalls.push(opts);
      const probe = opts.cmd.at(-1);
      const rows = opts.cmd.includes('*original') ? [{ domain: probe, fuzzer: '*original' }] : captured.rows;
      return { code: 0, stdout: JSON.stringify(rows), stderr: '', timedOut: false };
    }
    calls.push(opts);
    if (opts.network !== 'none' || opts.cmd[0] !== '--format' || opts.cmd[1] !== 'list') throw new Error('Test path must stay offline: ' + JSON.stringify(opts.cmd));
    return { code: 0, stdout: recorded(opts.cmd.at(-1)), stderr: '', timedOut: false };
  },
  runDocker: async () => { throw new Error('runDocker is not allowed in tests'); },
} });
const dnsCalls = [];
for (const fn of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveMx', 'resolveNs', 'resolveAny']) {
  mock.method(dns, fn, (...args) => { dnsCalls.push([fn, args[0]]); throw new Error('DNS is not allowed in tests'); });
  mock.method(dns.promises, fn, async (...args) => { dnsCalls.push([fn, args[0]]); throw new Error('DNS is not allowed in tests'); });
}
after(() => {
  assert.deepEqual(dnsCalls, [], 'no test may resolve a name');
  assert.ok(calls.every(c => c.network === 'none'), 'every tool call ran with --network none');
});

const { phishingLeads, detectors, METAMASK } = await import('../packs/phishing/checks.mjs');
const { captureLookalikes } = await import('../packs/phishing/live.mjs');
const { loadSnapshot } = await import('../lib/proof-evidence.mjs');

const sha = text => createHash('sha256').update(text).digest('hex');
const NAMES = recorded('tidekeep.test').split('\n').filter(Boolean);
const GENERATOR = { sha256: sha([...new Set(NAMES)].sort().join('\n')), count: new Set(NAMES).size };
const LIST_TEXT = readFileSync(join(PACK, 'lab', 'blocklists', 'touchstone-lab-blocklist.json'), 'utf8');
const LAB_LIST = { name: 'touchstone-lab-blocklist', format: 'metamask-config', file: 'blocklists/touchstone-lab-blocklist.json', synthetic: true, sha256: sha(LIST_TEXT), text: LIST_TEXT };
const SLICE_TEXT = readFileSync(join(PACK, METAMASK.file), 'utf8');
// One control row. `i` picks the random label, so a zone can hold 3 distinct controls.
const ctl = (zone, extra = {}, i = 0) => { const domain = 'ts-ctl-0123456789a' + 'bcd'[i] + '.' + zone; return { zone, domain, code: 0, rows: [{ domain, fuzzer: '*original', ...extra }] }; };
const ctl3 = (zone, extra = {}) => [0, 1, 2].map(i => ctl(zone, extra, i));
const QUIET = [...ctl3('test'), ...ctl3('com')];

// One snapshot: every generated name has a bare row, the official name answers,
// and `rows` overrides or adds rows by domain.
function snap({ rows = {}, controls = QUIET, lab = false, owned = [], blocklists = [LAB_LIST], only = null, generator = GENERATOR } = {}) {
  const base = { 'tidekeep.test': { domain: 'tidekeep.test', fuzzer: '*original', dns_ns: ['ns.test'], dns_a: ['192.0.2.1'], dns_mx: ['mail.tidekeep.test'] } };
  const list = (only ?? NAMES).map(d => ({ domain: d, fuzzer: 'test', ...(base[d] ?? {}), ...(rows[d] ?? {}) }));
  for (const [d, r] of Object.entries(rows)) if (!(only ?? NAMES).includes(d)) list.push({ domain: d, fuzzer: 'test', ...r });
  return { schema: 1, kind: 'phishing', ...(lab ? { lab: true } : {}), official: ['tidekeep.test'], owned,
    dnstwist: { image: 'touchstone-phishing-dnstwist:20250130', code: 0, rows: list, ...(controls ? { controls } : {}), ...(generator ? { generator } : {}) },
    blocklists, coverage: [{ engine: 'dnstwist-capture', status: 'ran', leads: list.length }] };
}
const confirmed = scan => scan.leads.filter(l => !l.reviewOnly && (l.check === 'registered-lookalike' || l.check === 'known-scam-lookalike'));
const registered = (scan, domain) => scan.leads.find(l => l.check === 'registered-lookalike' && !l.reviewOnly && l.where.domain === domain);
const gap = (scan, where) => scan.leads.find(l => l.check === 'lookalike-evidence-missing' && JSON.stringify(l.where) === JSON.stringify(where));
const HIT = { dns_ns: ['ns.test'], dns_a: ['192.0.2.10'], dns_mx: ['mail.tldekeep.test'] };

test('positive control: a normal snapshot with quiet controls confirms the real lookalike', async () => {
  const scan = await phishingLeads(snap({ rows: { 'tldekeep.test': HIT } }));
  const l = registered(scan, 'tldekeep.test');
  assert.ok(l);
  assert.equal((await detectors['registered-lookalike'](snap({ rows: { 'tldekeep.test': HIT } }), l.where)).ok, true);
});

test('M1: a wildcard resolver gives no confirmed lookalike and raises "resolver wildcards"', async () => {
  const every = Object.fromEntries(NAMES.map(d => [d, { dns_a: ['192.0.2.1'] }]));
  const s = snap({ rows: every, controls: [...ctl3('test', { dns_a: ['192.0.2.1'] }), ...ctl3('com', { dns_a: ['192.0.2.1'] })] });
  const scan = await phishingLeads(s);
  assert.equal(confirmed(scan).length, 0, 'no wildcard answer is confirmed');
  assert.ok(gap(scan, 'resolver wildcards'), 'resolver wildcards gap lead');
  assert.equal((await detectors['registered-lookalike'](s, { domain: 'tldekeep.test', fuzzer: 'test', A: '192.0.2.1' })).ok, false);
});

test('M1: a row whose answer equals a control answer is review-only, even in another zone', async () => {
  // An ISP that rewrites NXDOMAIN answers the com control. The test control is quiet.
  const s = snap({ rows: { 'tldekeep.test': HIT, 'tidekeap.test': { dns_a: ['198.51.100.7'] } }, controls: [...ctl3('test'), ...ctl3('com', { dns_a: ['198.51.100.7'] })] });
  const scan = await phishingLeads(s);
  assert.equal(registered(scan, 'tidekeap.test'), undefined);
  assert.ok(gap(scan, 'resolver wildcards'));
  assert.ok(scan.leads.some(l => l.where.domain === 'tidekeap.test' && l.reviewOnly));
});

test('M1: a snapshot with no control rows confirms nothing and raises the gap lead', async () => {
  const scan = await phishingLeads(snap({ rows: { 'tldekeep.test': HIT }, controls: null }));
  assert.equal(registered(scan, 'tldekeep.test'), undefined);
  assert.ok(gap(scan, 'no control rows'));
});

test('M-A: field-less controls but mass answers: the zone is a wildcard, nothing confirmed, a gap lead', async () => {
  // dnstwist writes the same field-less row for a timeout and for NXDOMAIN. Here all
  // three .test controls are field-less, but every generated .test name answers with
  // its own address. That is a wildcard, not 4857 registrations.
  const every = Object.fromEntries(NAMES.filter(d => d.endsWith('.test') && d !== 'tidekeep.test').map((d, i) => [d, { dns_a: ['203.0.' + (i >> 8) + '.' + (i & 255)] }]));
  const scan = await phishingLeads(snap({ rows: every }));
  assert.equal(confirmed(scan).length, 0, 'no mass answer is confirmed');
  assert.ok(gap(scan, { wildcard: 'ratio', zones: 'test' }), 'ratio gap lead names the zone');
  assert.equal(scan.leads.find(l => l.where.domain === 'tldekeep.test').where.reason, 'wildcard');
  // Below the ratio, the same quiet controls still confirm a real lookalike.
  assert.ok(registered(await phishingLeads(snap({ rows: { 'tldekeep.test': HIT } })), 'tldekeep.test'));
});

test('M-A: one field-less control, or a timed-out control, does not make a zone quiet', async () => {
  // The old capture shape: one control per zone.
  const one = await phishingLeads(snap({ rows: { 'tldekeep.test': HIT }, controls: [ctl('test'), ctl('com')] }));
  assert.equal(registered(one, 'tldekeep.test'), undefined);
  assert.ok(gap(one, { controls: 'missing', zones: 'test' }));
  // Three controls, but one run timed out (no row, non-zero code).
  const timedOut = { ...ctl('test', {}, 2), code: 1, rows: [], reason: 'Timed out.' };
  const late = await phishingLeads(snap({ rows: { 'tldekeep.test': HIT }, controls: [ctl('test'), ctl('test', {}, 1), timedOut, ...ctl3('com')] }));
  assert.equal(registered(late, 'tldekeep.test'), undefined);
  assert.ok(gap(late, { controls: 'missing', zones: 'test' }));
  // The same label three times is one control, not three.
  const same = await phishingLeads(snap({ rows: { 'tldekeep.test': HIT }, controls: [ctl('test'), ctl('test'), ctl('test'), ...ctl3('com')] }));
  assert.equal(registered(same, 'tldekeep.test'), undefined);
});

test('M2: every row but the official one is !ServFail: coverage partial and a gap lead with both counts', async () => {
  const fail = Object.fromEntries(NAMES.filter(d => d !== 'tidekeep.test').map(d => [d, { dns_ns: ['!ServFail'], dns_a: ['!ServFail'], dns_aaaa: ['!ServFail'] }]));
  const scan = await phishingLeads(snap({ rows: fail }));
  assert.equal(scan.coverage.find(c => c.engine === 'dnstwist-capture').status, 'partial');
  const l = scan.leads.find(x => x.check === 'lookalike-evidence-missing' && x.where.capture === 'partial');
  assert.ok(l, 'partial capture lead');
  assert.equal(l.where.servfail, '4859');
  assert.equal(l.where.missing, '0');
  assert.match(l.description, /4859 .*!ServFail/);
});

test('M2: code 0 with only the official row: coverage partial and the missing count', async () => {
  const scan = await phishingLeads(snap({ only: ['tidekeep.test'] }));
  assert.equal(scan.coverage.find(c => c.engine === 'dnstwist-capture').status, 'partial');
  const l = scan.leads.find(x => x.check === 'lookalike-evidence-missing' && x.where.capture === 'partial');
  assert.ok(l);
  assert.equal(l.where.servfail, '0');
  assert.equal(l.where.missing, '4859');
});

test('M4: the owner\'s Unicode IDN domain is not reported as a lookalike', async () => {
  assert.ok(NAMES.includes('xn--1dekeep-2rb.test'), 'dnstwist generates the punycode form');
  const scan = await phishingLeads(snap({ owned: ['ŧ1dekeep.test'], rows: { 'xn--1dekeep-2rb.test': { dns_a: ['192.0.2.20'] }, 'tldekeep.test': HIT } }));
  assert.equal(scan.leads.filter(l => l.where.domain === 'xn--1dekeep-2rb.test').length, 0);
  assert.ok(registered(scan, 'tldekeep.test'), 'other lookalikes still confirm');
});

test('Minor 1: an owned entry that is not a domain name throws; it is never dropped', async () => {
  const bad = 'https://тіԁекеер.test/';
  await assert.rejects(phishingLeads(snap({ owned: [bad], rows: { 'tldekeep.test': HIT } })), /owned entry .* is not a domain name/);
  await assert.rejects(phishingLeads(snap({ owned: ['tide-keep.test', ''] })), /owned entry "" is not a domain name/);
  liveCalls.length = 0; calls.length = 0;
  const reach = { network: 'bridge', granted: true, scope: ['tidekeep.test'], resolver: '172.30.47.53' };
  await assert.rejects(captureLookalikes({ ws: join(PACK, 'lab'), domain: 'tidekeep.test', owned: [bad], reach }), /owned entry .* is not a domain name/);
  assert.equal(liveCalls.length + calls.length, 0, 'no tool runs');
  const ok = await phishingLeads(snap({ owned: ['Tide-Keep.test.'], rows: { 'tide-keep.test': HIT } }));
  assert.equal(ok.leads.filter(l => l.where.domain === 'tide-keep.test').length, 0, 'a bare owned name still works');
});

test('m1: non-routable and malformed answers are not confirmed; they go to review', async () => {
  const rows = {
    'tidekeap.test': { dns_a: ['0.0.0.0'] }, 'tidekeip.test': { dns_a: ['127.0.0.1'] },
    'tidekeop.test': { dns_aaaa: ['::'] }, 'tidekeup.test': { dns_aaaa: ['::1'] }, 'tidakeep.test': { dns_aaaa: [':::::'] },
    'tldekeep.test': HIT,
  };
  for (const d of Object.keys(rows)) assert.ok(NAMES.includes(d), d + ' is generated');
  const scan = await phishingLeads(snap({ rows }));
  for (const d of ['tidekeap.test', 'tidekeip.test', 'tidekeop.test', 'tidekeup.test', 'tidakeep.test']) assert.equal(registered(scan, d), undefined, d);
  for (const d of ['tidekeap.test', 'tidekeip.test', 'tidekeop.test', 'tidekeup.test']) assert.ok(scan.leads.some(l => l.where.domain === d && l.reviewOnly), d + ' review lead');
  assert.equal(scan.leads.filter(l => l.where.domain === 'tidakeep.test').length, 0, 'a malformed answer is not a record');
  assert.ok(registered(scan, 'tldekeep.test'));
});

test('m2: a changed MetaMask slice with a recomputed sha256 is refused; other commits are operator-stated', async () => {
  const changed = SLICE_TEXT.replace('"metamcsk.io",', '"tidekep.test",');
  assert.notEqual(changed, SLICE_TEXT);
  const forged = { ...METAMASK, text: changed, sha256: sha(changed) };
  const a = await phishingLeads(snap({ blocklists: [forged] }));
  assert.equal(a.coverage.find(c => c.engine === 'blocklist:' + METAMASK.name).status, 'unavailable');
  assert.equal(a.leads.filter(l => l.check === 'known-scam-lookalike').length, 0);
  const moved = await phishingLeads(snap({ blocklists: [{ ...METAMASK, text: SLICE_TEXT, firstLine: 77 }] }));
  assert.equal(moved.coverage.find(c => c.engine === 'blocklist:' + METAMASK.name).status, 'unavailable');
  const operator = await phishingLeads(snap({ blocklists: [{ ...LAB_LIST, name: 'operator-list', synthetic: false, commit: 'a'.repeat(40) }] }));
  const l = operator.leads.find(x => x.check === 'known-scam-lookalike' && x.where.domain === 'tidekep.test');
  assert.ok(l);
  assert.match(l.description, /operator-stated/);
  // An operator copy at the same upstream commit, under its own name, is allowed and still operator-stated.
  const sameCommit = await phishingLeads(snap({ blocklists: [{ ...LAB_LIST, name: 'operator-full-config', synthetic: false, commit: METAMASK.commit }] }));
  assert.equal(sameCommit.coverage.find(c => c.engine === 'blocklist:operator-full-config').status, 'ran');
  assert.match(sameCommit.leads.find(x => x.check === 'known-scam-lookalike' && x.where.domain === 'tidekep.test').description, /operator-stated/);
});

test('m3: the brand\'s own subdomain on a list is not called a lookalike', async () => {
  const text = JSON.stringify({ blacklist: ['docs.tidekeep.test', 'tidekeep-airdrop.test'] }, null, 2) + '\n';
  const scan = await phishingLeads(snap({ lab: true, blocklists: [{ ...LAB_LIST, text, sha256: sha(text) }] }));
  assert.equal(scan.leads.filter(l => l.check === 'brand-on-blocklist' && l.where.domain === 'docs.tidekeep.test').length, 0);
  const own = scan.leads.find(l => l.check === 'own-host-on-blocklist' && l.where.domain === 'docs.tidekeep.test');
  assert.ok(own && own.reviewOnly);
  assert.ok(scan.leads.some(l => l.check === 'brand-on-blocklist' && l.where.domain === 'tidekeep-airdrop.test'));
});

test('m4: lead text says "serve a page" only for A/AAAA and "receive mail" only for MX', async () => {
  const scan = await phishingLeads(snap({ rows: { 'tidekeap.test': { dns_ns: ['ns.test'], dns_mx: ['mx.tidekeap.test'] }, 'tidekeip.test': { dns_a: ['192.0.2.30'] } } }));
  const mx = registered(scan, 'tidekeap.test'), a = registered(scan, 'tidekeip.test');
  assert.ok(mx && a);
  assert.match(mx.description, /receive mail/);
  assert.doesNotMatch(mx.description, /page/);
  assert.match(a.description, /serve a page/);
  assert.doesNotMatch(a.description, /mail/);
});

test('m5: a generator that gives a different name set than at capture fails closed', async () => {
  const bad = await phishingLeads(snap({ rows: { 'tldekeep.test': HIT }, generator: { sha256: 'f'.repeat(64), count: 4860 } }));
  assert.equal(bad.coverage.find(c => c.engine === 'dnstwist').status, 'unavailable');
  assert.equal(confirmed(bad).length, 0);
  assert.ok(gap(bad, 'dnstwist'));
  const none = await phishingLeads(snap({ rows: { 'tldekeep.test': HIT }, generator: null }));
  assert.equal(confirmed(none).length, 0, 'no fingerprint, no proof');
});

test('m10: a list entry under a generated lookalike gets a review lead', async () => {
  const text = JSON.stringify({ blacklist: ['www.tidekep.test'] }, null, 2) + '\n';
  const scan = await phishingLeads(snap({ lab: true, blocklists: [{ ...LAB_LIST, text, sha256: sha(text) }] }));
  const l = scan.leads.find(x => x.where.domain === 'www.tidekep.test');
  assert.ok(l && l.reviewOnly);
  assert.equal(l.check, 'lookalike-host-on-blocklist');
});

test('M1/m5/M-A: live capture asks three controls per zone on the granted network, then fingerprints the generator offline', async () => {
  const lab = loadSnapshot(join(PACK, 'lab')).snapshot;
  captured = lab.dnstwist;
  calls.length = 0;
  try {
    const reach = { network: 'bridge', granted: true, scope: ['tidekeep.test'], resolver: '172.30.47.53' };
    const snapshot = await captureLookalikes({ ws: join(PACK, 'lab'), domain: 'tidekeep.test', owned: ['tide-keep.test'], reach });
    assert.equal(liveCalls.length, 7, 'one main run and three controls per zone');
    assert.deepEqual(liveCalls[0].cmd, ['--format', 'json', '--nameservers', '172.30.47.53', 'tidekeep.test']);
    assert.ok(liveCalls.every(c => c.network === 'bridge'));
    const probes = liveCalls.slice(1).map(c => c.cmd.at(-1));
    assert.deepEqual(liveCalls[1].cmd.slice(0, 6), ['--format', 'json', '--fuzzers', '*original', '--nameservers', '172.30.47.53']);
    for (const p of probes.slice(0, 3)) assert.match(p, /^ts-ctl-[0-9a-f]{12}\.com$/);
    for (const p of probes.slice(3)) assert.match(p, /^ts-ctl-[0-9a-f]{12}\.test$/);
    assert.equal(new Set(probes).size, 6, 'each control is a new random name');
    assert.deepEqual(snapshot.dnstwist.controls.map(c => c.zone), ['com', 'com', 'com', 'test', 'test', 'test']);
    assert.deepEqual(calls.map(c => [c.network, c.cmd]), [['none', ['--format', 'list', 'tidekeep.test']]]);
    assert.equal(snapshot.dnstwist.generator.sha256, GENERATOR.sha256);
    assert.equal(snapshot.dnstwist.generator.count, GENERATOR.count);
    const scan = await phishingLeads(snapshot);
    assert.ok(registered(scan, 'tldekeep.test'));
    assert.equal(scan.leads.filter(l => l.check === 'lookalike-evidence-missing').length, 0);
  } finally { captured = null; }
});
