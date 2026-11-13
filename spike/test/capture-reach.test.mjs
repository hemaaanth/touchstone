// A capture tool never contacts a host outside the scope (review finding 3).
//
// The Domains and Surface capture runs its tools on an open network. So the
// inputs each tool gets are the boundary. These tests read those inputs.
//   - a granted name that resolves to a private address is not probed
//   - a generated name the grant does not cover is not resolved and not probed
//   - a covered public host is probed
//
// The tool runner is a stub: no tool runs, no request leaves the machine, no
// Docker. The grant and scope stores are temp files.
//
//   node --experimental-test-module-mocks --test spike/test/capture-reach.test.mjs
import { test, mock, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realWrap from '../lib/wrap.mjs';
import * as realLab from '../packs/domains/labctl.mjs';

const store = mkdtempSync(join(tmpdir(), 'capture-reach-test-'));
process.env.TOUCHSTONE_SCOPES_FILE = join(store, 'scopes.json');
process.env.TOUCHSTONE_GRANTS_FILE = join(store, 'grants.json');
process.env.TOUCHSTONE_GRANT_TOKEN = 'test-token-not-real';
const workspaces = [];
after(() => { for (const d of [store, ...workspaces]) rmSync(d, { recursive: true, force: true }); });

// What the fake tools answer. Each test sets these.
let zone, found, web, crawlOut, calls, ws;
beforeEach(() => { zone = {}; found = []; web = {}; crawlOut = {}; calls = []; });
const PUBLIC = '93.184.216.34';
const rows = list => list.map(r => JSON.stringify(r) + '\n').join('');
const listOf = cmd => {
  const file = cmd[cmd.indexOf(cmd.includes('-l') ? '-l' : '-list') + 1];
  return readFileSync(join(ws, file.replace('/work/', '')), 'utf8').split('\n').filter(Boolean);
};
const answers = {
  subfinder: () => rows(found.map(host => ({ host }))),
  // A name with no zone entry does not exist.
  dnsx: (cmd, input) => rows(input.map(host => zone[host] ? { host, status_code: 'NOERROR', ...zone[host] } : { host, status_code: 'NXDOMAIN' })),
  // Every URL answers 200 with a page, unless the test names another answer.
  httpx: (cmd, input) => rows(input.map(url => {
    const w = web[url] ?? {};
    return { url, status_code: w.status ?? 200, raw_header: 'HTTP/1.1 ' + (w.status ?? 200) + ' X\r\nContent-Type: text/html\r\n' + (w.location ? 'Location: ' + w.location + '\r\n' : '') + '\r\n', body: w.body ?? '<html></html>' };
  })),
  katana: (cmd, input) => rows(input.flatMap(seed => crawlOut[seed] ?? [])),
  nuclei: () => '',
  jsluice: () => '',
};
// The Domains deep tools (checkdmarc, testssl.sh, DNSViz). Each call is recorded with its
// argv, network and env, and answered as a failed run, so no evidence is built from it.
const DEEP = { checkdmarc: 'letiemble/checkdmarc:', testssl: 'drwetter/testssl.sh:', dnsviz: 'dnsviz/dnsviz@' };
mock.module('../lib/wrap.mjs', { exports: { ...realWrap, runTool: async opts => {
  const deep = Object.keys(DEEP).find(n => opts.image.startsWith(DEEP[n]));
  if (deep) { calls.push({ name: deep, cmd: opts.cmd, network: opts.network, env: opts.env, input: [] }); return { code: 1, stdout: '', stderr: 'not run in this test', timedOut: false }; }
  const name = Object.keys(answers).find(n => opts.image.startsWith('projectdiscovery/' + n + ':') || opts.image.startsWith('touchstone-' + n + ':'));
  // No real tool may run in this file.
  if (!name) throw new Error('unexpected tool image ' + opts.image);
  const input = name === 'subfinder' || name === 'jsluice' ? [] : listOf(opts.cmd);
  calls.push({ name, cmd: opts.cmd, network: opts.network, input });
  return { code: 0, stderr: '', timedOut: false, stdout: answers[name](opts.cmd, input) };
} } });
// The lab test needs no Docker network: the --internal check is its own test (domains-live).
mock.module('../packs/domains/labctl.mjs', { exports: { ...realLab, assertInternal: () => {} } });

const { ensureImage } = await import('../packs/domains/checks.mjs');
const { assertReach, captureDomain, crawlScope, katanaArgs, PORTS, WORDLIST } = await import('../packs/domains/live.mjs');
const { coverageOf } = await import('../packs/domains/pack.mjs');
const { prepassView } = await import('../lib/prepass-view.mjs');
const { addLiveScope } = await import('../lib/scopes-store.mjs');
const { addGrant, removeGrant } = await import('../lib/grant-store.mjs');
const { allowsPrivate } = await import('../lib/reach.mjs');
const { prepareWorkspace } = await import('../lib/targets.mjs');
// The capture checks its tools image once. Mark it ready, so no Docker call is made.
ensureImage(() => {});

const live = (scope, more = {}) => ({ network: 'bridge', granted: true, scope, ...more });
async function capture(domain, reach, options = {}) {
  ws = mkdtempSync(join(tmpdir(), 'capture-reach-ws-'));
  workspaces.push(ws);
  const snapshot = await captureDomain({ ws, domain, reach, ...options });
  assert.equal(existsSync(join(ws, '.live')), false, 'the capture removes its input files');
  return snapshot;
}
const call = name => calls.find(c => c.name === name);
const hostOf = url => new URL(url).hostname;
// Every host an HTTP tool got as input: httpx (both passes), katana (both passes) and nuclei.
const contacted = () => [...new Set(calls.filter(c => ['httpx', 'katana', 'nuclei'].includes(c.name)).flatMap(c => c.input.map(hostOf)))].sort();
const crawlAllows = url => new RegExp(call('katana').cmd[call('katana').cmd.indexOf('-cs') + 1]).test(url);

test('a granted name that resolves to 10.0.0.1 is not probed', async () => {
  zone = { 'example.com': { a: [PUBLIC] }, 'intranet.example.com': { a: ['10.0.0.1'] } };
  const snapshot = await capture('example.com', live(['example.com', 'intranet.example.com']), { crawl: true });
  // The grant covers the name, so DNS is asked about it. That is where the private address shows.
  assert.deepEqual(call('dnsx').input, ['example.com', 'intranet.example.com']);
  assert.deepEqual(contacted(), ['example.com']);
  assert.deepEqual(call('httpx').input, ['https://example.com', 'http://example.com']);
  assert.equal(crawlAllows('http://intranet.example.com/'), false, 'the crawl scope leaves the name out');
  assert.equal(crawlAllows('https://example.com/'), true);
  // The refusal is in the snapshot and in the coverage the run view shows.
  assert.deepEqual(snapshot.discovery.refused, [{ host: 'intranet.example.com', reason: 'It resolves to 10.0.0.1, a private address. The grant does not allow private addresses.' }]);
  const row = snapshot.discovery.coverage.find(c => c.engine === 'address-check');
  assert.equal(row.status, 'refused');
  assert.match(row.reason, /^Not contacted: intranet\.example\.com\. It resolves to 10\.0\.0\.1, a private address\./);
  const shown = prepassView({ pack: 'domains', leads: [], coverage: coverageOf(snapshot, []) }).tools.find(t => t.name === 'address-check');
  assert.equal(shown.status, 'unavailable');
  assert.match(shown.reason, /intranet\.example\.com\. It resolves to 10\.0\.0\.1/);
  // The DNS evidence keeps the name: the checks still read its records.
  assert.deepEqual(snapshot.discovery.hosts, ['example.com', 'intranet.example.com']);
});

test('no kind of private address is probed, by any path to it', async () => {
  zone = {
    'example.com': { a: ['127.0.0.1'] },
    'six.example.com': { aaaa: ['::1'] },
    'ula.example.com': { aaaa: ['fd00::1'] },
    'meta.example.com': { a: ['169.254.169.254'] },
    // One public address does not make a name safe: the tool picks the address.
    'mixed.example.com': { a: [PUBLIC, '10.0.0.1'] },
    'mapped.example.com': { aaaa: ['::ffff:10.0.0.1'] },
    // The private address sits behind a CNAME to a name outside the grant.
    'alias.example.com': { cname: ['lb.internal.example.net'] },
    'lb.internal.example.net': { a: ['192.168.1.10'] },
    // A CNAME with no address behind it: nothing to check, nothing to contact.
    'old.example.com': { cname: ['gone.example.net'] },
  };
  const names = Object.keys(zone).filter(h => h.endsWith('example.com'));
  const snapshot = await capture('example.com', live(names), { crawl: true });
  assert.deepEqual(contacted(), [], 'no HTTP tool got any input');
  for (const name of ['httpx', 'katana', 'nuclei']) assert.equal(call(name), undefined, name + ' did not run');
  assert.deepEqual(snapshot.discovery.refused.map(r => r.host).sort(), names.filter(h => h !== 'old.example.com').sort());
  assert.match(snapshot.discovery.refused.find(r => r.host === 'alias.example.com').reason, /192\.168\.1\.10, a private address/);
  assert.match(snapshot.discovery.refused.find(r => r.host === 'example.com').reason, /127\.0\.0\.1, a loopback address/);
  // The dangling CNAME evidence is still captured.
  assert.deepEqual(snapshot.dns.find(r => r.host === 'gone.example.net' && r.type === 'A').status, 'ENOTFOUND');
});

test('a generated subdomain outside the grant is not resolved and not probed', async () => {
  // Every one of these names would answer, if a tool asked.
  zone = { 'example.com': { a: [PUBLIC] }, 'www.example.com': { a: [PUBLIC] }, 'api.example.com': { a: [PUBLIC] }, 'shop.example.com': { a: [PUBLIC] } };
  found = ['shop.example.com', 'www.example.com'];
  const snapshot = await capture('example.com', live(['example.com']), { crawl: true });
  // No wordlist name, no name from subfinder, and no wildcard test name.
  assert.deepEqual(call('dnsx').input, ['example.com']);
  assert.equal(call('subfinder').cmd.includes('-nW'), false, 'subfinder resolves no name it finds');
  assert.deepEqual(contacted(), ['example.com']);
  assert.deepEqual(snapshot.discovery.hosts, ['example.com']);
  for (const url of ['https://www.example.com/', 'https://shop.example.com/', 'https://example.com.evil.net/']) assert.equal(crawlAllows(url), false, url);
});

test('a covered host is probed, with the stops inside each tool', async () => {
  zone = { 'example.com': { a: [PUBLIC] }, 'www.example.com': { a: [PUBLIC] }, 'shop.example.com': { cname: ['example.com'] } };
  found = ['shop.example.com', 'evil.net'];
  const snapshot = await capture('example.com', live(['example.com', '*.example.com']), { crawl: true });
  // The wildcard entry covers the generated names: the wordlist, the subfinder names, the wildcard test name.
  const asked = call('dnsx').input;
  assert.equal(asked.length, 1 + WORDLIST.length + 1 + 1);
  assert(asked.includes('www.example.com') && asked.includes('shop.example.com') && asked.some(h => h.startsWith('touchstone-nx-')));
  assert.equal(asked.includes('evil.net'), false);
  assert(call('subfinder').cmd.includes('-nW'));
  assert.deepEqual(contacted(), ['example.com', 'shop.example.com', 'www.example.com']);
  assert.deepEqual(snapshot.discovery.hosts, ['example.com', 'shop.example.com', 'www.example.com']);
  assert.equal(snapshot.discovery.refused, undefined);
  assert.equal(snapshot.discovery.coverage.some(c => c.engine === 'address-check'), false);
  for (const c of calls) if (c.name !== 'jsluice') assert.equal(c.network, 'bridge');
  // httpx and nuclei refuse a private address by themselves. katana takes exact hosts and follows no redirect.
  const httpx = call('httpx').cmd, at = httpx.indexOf('-e');
  assert.equal(httpx[at + 1], 'private-ips');
  assert(call('nuclei').cmd.includes('-lna'));
  const katana = call('katana').cmd;
  assert(katana.includes('-dr'));
  assert.equal(katana[katana.indexOf('-cs') + 1], crawlScope(['example.com', 'www.example.com', 'shop.example.com'], PORTS, true));
  // The crawl scope holds the checked names only. A covered name that was not checked is out.
  assert.equal(crawlAllows('https://www.example.com/a'), true);
  assert.equal(crawlAllows('https://api.example.com/'), false);
});

test('a grant with allowPrivate lets a private address through, and still not an uncovered name', async () => {
  zone = { 'lab.example.com': { a: ['10.0.0.1'] }, 'www.lab.example.com': { a: ['10.0.0.2'] } };
  const snapshot = await capture('lab.example.com', live(['lab.example.com'], { allowPrivate: true, resolver: '10.0.0.53' }), { crawl: true });
  assert.deepEqual(call('dnsx').input, ['lab.example.com']);
  assert.deepEqual(contacted(), ['lab.example.com']);
  assert.equal(snapshot.discovery.refused, undefined);
  assert.equal(call('httpx').cmd.includes('private-ips'), false);
  assert.equal(call('nuclei').cmd.includes('-lna'), false);
  assert(call('katana').cmd.includes('-dr'));
  assert.equal(crawlAllows('http://www.lab.example.com/'), false);
});

test('a granted name outside the domain is resolved for the crawl only', async () => {
  zone = { 'example.com': { a: [PUBLIC] }, 'example.org': { a: [PUBLIC] }, 'example.net': { a: ['10.0.0.9'] } };
  web = { 'https://example.com': { body: '<script src="https://example.org/a.js"></script><script src="https://example.net/b.js"></script><script src="https://cdn.evil.net/c.js"></script>' } };
  await capture('example.com', live(['example.com', 'example.org', 'example.net']), { crawl: true });
  assert.deepEqual(call('dnsx').input, ['example.com', 'example.org', 'example.net']);
  // The first probe is for the domain's own names.
  assert.deepEqual(call('httpx').input, ['https://example.com', 'http://example.com']);
  // A script on a granted, public host is fetched. One on a granted private host or an uncovered host is not.
  assert.deepEqual(calls.filter(c => c.name === 'httpx')[1].input, ['https://example.org/a.js']);
  assert.equal(crawlAllows('https://example.org/'), true);
  assert.equal(crawlAllows('https://example.net/'), false);
});

test('a live crawl follows a redirect only to a checked host, as a new seed', async () => {
  zone = { 'example.com': { a: [PUBLIC] }, 'www.example.com': { a: [PUBLIC] }, 'intranet.example.com': { a: ['10.0.0.1'] } };
  web = {
    'https://example.com': { status: 301, location: 'https://www.example.com/start' },
    'http://example.com': { status: 302, location: 'https://evil.net/x' },
    'https://www.example.com': { status: 302, location: 'http://intranet.example.com/admin' },
    'http://www.example.com': { status: 302, location: 'https://example.com:8443/other-port' },
  };
  const hop = (endpoint, location) => ({ request: { endpoint, source: 'https://example.com/' }, response: { status_code: 302, headers: { location } } });
  crawlOut = {
    'https://example.com/': [hop('https://example.com/go', '/next'), hop('https://example.com/out', 'http://169.254.169.254/latest/meta-data'), hop('https://example.com/away', 'https://evil.net/y')],
    'https://example.com/next': [{ request: { endpoint: 'https://example.com/deep', source: 'https://example.com/next' }, response: { status_code: 200, headers: {} } }],
  };
  const snapshot = await capture('example.com', live(['example.com', 'www.example.com', 'intranet.example.com']), { crawl: true });
  const [first, second] = calls.filter(c => c.name === 'katana');
  assert.deepEqual(first.input, ['https://example.com/', 'http://example.com/', 'https://www.example.com/', 'http://www.example.com/', 'https://www.example.com/start']);
  assert.deepEqual(second.input, ['https://example.com/next']);
  assert(second.cmd.includes('-dr'));
  assert.deepEqual(contacted(), ['example.com', 'www.example.com']);
  assert(snapshot.discovery.crawl.some(r => r.url === 'https://example.com/deep'), 'the page behind the in-scope redirect is crawled');
  assert.deepEqual(snapshot.discovery.coverage.filter(c => c.engine.startsWith('katana')).map(c => [c.engine, c.status]), [['katana', 'ran'], ['katana-redirects', 'ran']]);
});

test('the lab capture is unchanged: its own scope rule, no address rule, the old arguments', async () => {
  zone = { 'touchstone.test': { a: ['10.89.0.2'] }, 'www.touchstone.test': { a: ['10.89.0.3'] } };
  const reach = { network: 'touchstone-domains-test', granted: true, scope: ['touchstone.test'], resolver: '10.89.0.53' };
  const snapshot = await capture('touchstone.test', reach, { crawl: true });
  assert.equal(call('dnsx').input.length, 1 + WORDLIST.length + 1);
  assert(call('subfinder').cmd.includes('-nW'));
  assert.deepEqual(contacted(), ['touchstone.test', 'www.touchstone.test']);
  assert.equal(snapshot.discovery.refused, undefined);
  assert.equal(call('httpx').cmd.includes('private-ips'), false);
  assert.equal(call('nuclei').cmd.includes('-lna'), false);
  assert.deepEqual(call('katana').cmd, katanaArgs('/work/.live/crawl.txt', ['touchstone.test'], '10.89.0.53', PORTS));
  assert.equal(call('katana').cmd.includes('-dr'), false);
  for (const c of calls) if (c.name !== 'jsluice') assert.equal(c.network, 'touchstone-domains-test');
});

test('a live crawl scope is exact: a "*." entry is the only way to a subdomain', () => {
  const allows = url => new RegExp(crawlScope(['example.com', '*.example.org', '203.0.113.7'], PORTS, true)).test(url);
  for (const url of ['https://example.com/', 'http://example.com', 'https://example.com:443/a', 'https://a.example.org/', 'https://a.b.example.org/x', 'http://203.0.113.7/']) assert.equal(allows(url), true, url);
  for (const url of ['https://a.example.com/', 'https://example.org/', 'https://example.com.evil.net/', 'https://evilexample.com/', 'http://example.com:8080/', 'https://203.0.113.70/', 'https://203x0.113.7/']) assert.equal(allows(url), false, url);
  // The lab form still takes a subdomain of a listed name.
  assert.equal(new RegExp(crawlScope(['example.com'], PORTS)).test('https://a.example.com/'), true);
});

test('the resolver is a public address, unless the grant allows private ones', () => {
  const reach = more => live(['example.com'], more);
  assert.throws(() => assertReach(reach({ resolver: '10.0.0.53' }), 'example.com'), /public resolver address/);
  assert.throws(() => assertReach(reach({ resolver: '127.0.0.1' }), 'example.com'), /public resolver address/);
  assert.throws(() => assertReach(reach({ resolver: 'ns.example.com' }), 'example.com'), /public resolver address/);
  assert.doesNotThrow(() => assertReach(reach({ resolver: '1.1.1.1' }), 'example.com'));
  assert.doesNotThrow(() => assertReach(reach({ resolver: '10.0.0.53', allowPrivate: true }), 'example.com'));
  assert.doesNotThrow(() => assertReach(reach(), 'example.com'));
});

test('the capture reach takes allowPrivate from the scope\'s own grant only', () => {
  const cfgOf = target => {
    const dir = prepareWorkspace(target, { modules: [] });
    workspaces.push(dir);
    return JSON.parse(readFileSync(join(dir, '.touchstone.json'), 'utf8'));
  };
  const site = addLiveScope({ hosts: ['app.example.com'], permission: true });
  for (const pack of ['domains', 'surface']) {
    const reach = cfgOf({ ...site, pack }).reach;
    assert.deepEqual(reach.scope, ['app.example.com']);
    assert.equal('allowPrivate' in reach, false, pack);
  }
  // Another scope's private opt-in for the same host is not lent.
  addGrant({ hosts: ['app.example.com'], kind: 'operator-owned', ownership: true, allowPrivate: true });
  assert.equal(allowsPrivate(site), false);
  // A scope record that claims the opt-in, while its grant does not hold it, gets none.
  const forged = { ...site, permission: { ...site.permission, allowPrivate: true } };
  assert.equal(allowsPrivate(forged), false);
  assert.equal('allowPrivate' in cfgOf({ ...forged, pack: 'domains' }).reach, false);
  // The operator's own opt-in holds, until its grant is removed.
  const lab = addLiveScope({ hosts: ['127.0.0.1'], permission: true, allowPrivate: true });
  assert.equal(allowsPrivate(lab), true);
  assert.equal(cfgOf({ ...lab, pack: 'surface' }).reach.allowPrivate, true);
  removeGrant(lab.permission.grantId);
  assert.equal(allowsPrivate(lab), false);
  // A direct target with no saved permission gets none.
  assert.equal(allowsPrivate({ kind: 'live', hosts: ['app.example.com'] }), false);
});
