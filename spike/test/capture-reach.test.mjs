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
import "./helpers/isolated-env.mjs";
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
let zone, found, web, crawlOut, calls, caa, caaCalls, ws;
beforeEach(() => { zone = {}; found = []; web = {}; crawlOut = {}; calls = []; caa = {}; caaCalls = []; });
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
// Build one drill CAA answer. cfg: 'absent' | 'fail' | 'tc' | [rdata...] | { cname, records }.
const caaAnswer = (name, cfg) => {
  if (cfg === 'fail') return ';; ->>HEADER<<- rcode: SERVFAIL\n;; flags: qr rd ;\n';
  const tc = cfg === 'tc';
  const head = ';; ->>HEADER<<- rcode: NOERROR\n;; flags: qr' + (tc ? ' tc' : '') + ' rd ;\n;; ANSWER SECTION:\n';
  const lines = [];
  if (cfg && cfg.cname) { lines.push(name + '.\t60\tIN\tCNAME\t' + cfg.cname + '.'); for (const r of cfg.records ?? []) lines.push(cfg.cname + '.\t60\tIN\tCAA\t' + r); }
  else if (Array.isArray(cfg)) for (const r of cfg) lines.push(name + '.\t60\tIN\tCAA\t' + r);
  return head + lines.join('\n') + '\n';
};
mock.module('../lib/wrap.mjs', { exports: { ...realWrap, runTool: async opts => {
  // drill (the CAA query) runs through runTool with an entrypoint override, so it gets
  // runTool's guards; it is dispatched before the image check (its image is the testssl one).
  if (opts.entrypoint === 'drill') {
    const name = opts.cmd[opts.cmd.indexOf('CAA') + 1];
    caaCalls.push({ name, network: opts.network, cmd: opts.cmd, entrypoint: opts.entrypoint });
    const cfg = name in caa ? caa[name] : ['0 issue "letsencrypt.org"']; // default: a record is present
    return { code: 0, stderr: '', timedOut: false, stdout: caaAnswer(name, cfg) };
  }
  const deep = Object.keys(DEEP).find(n => opts.image.startsWith(DEEP[n]));
  if (deep) { calls.push({ name: deep, cmd: opts.cmd, network: opts.network, env: opts.env, addHosts: opts.addHosts, input: [] }); return { code: 1, stdout: '', stderr: 'not run in this test', timedOut: false }; }
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
const { caaLeads } = await import('../packs/domains/tls.mjs');
const { coverageOf } = await import('../packs/domains/pack.mjs');
const { prepassView } = await import('../lib/prepass-view.mjs');
const { addLiveScope } = await import('../lib/scopes-store.mjs');
const { addGrant, removeGrant } = await import('../lib/grant-store.mjs');
const { allowsPrivate } = await import('../lib/reach.mjs');
const { prepareWorkspace } = await import('../lib/targets.mjs');
// The capture checks its tools image once. Mark it ready, so no Docker call is made.
ensureImage(() => {});

const live = (scope, more = {}) => ({ network: 'bridge', granted: true, scope, ...more });
// The run's reach boundary, as lib/reach-confine.mjs hands it over. Nothing runs here: only the names are read.
const CONFINE = { netClient: 'touchstone-reach-client-test', gateUrl: 'http://scope-gate:8080' };
async function capture(domain, reach, options = {}) {
  ws = mkdtempSync(join(tmpdir(), 'capture-reach-ws-'));
  workspaces.push(ws);
  const snapshot = await captureDomain({ ws, domain, reach, confine: CONFINE, ...options });
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
  for (const c of calls) if (!['jsluice', 'katana'].includes(c.name)) assert.equal(c.network, 'bridge');
  assert.equal(call('katana').network, CONFINE.netClient, 'katana runs on the confined network');
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

// F1. katana looks each name up again by itself. A live crawl must go through the scope proxy,
// which checks the address and connects to that same address.
test('a live crawl goes through the run\'s scope proxy, on its confined network', async () => {
  zone = { 'example.com': { a: [PUBLIC] } };
  await capture('example.com', live(['example.com'], { resolver: '1.1.1.1' }), { crawl: true });
  for (const k of calls.filter(c => c.name === 'katana')) {
    assert.equal(k.network, CONFINE.netClient);
    assert.equal(k.cmd[k.cmd.indexOf('-proxy') + 1], CONFINE.gateUrl);
    // The proxy resolves the name. katana's own resolver would be unreachable on the confined network.
    assert.equal(k.cmd.includes('-r'), false);
    assert(k.cmd.includes('-dr'));
  }
  assert.equal(call('katana').cmd.includes('-proxy'), true);
});

test('a live crawl with no scope proxy does not run katana, and says why', async () => {
  zone = { 'example.com': { a: [PUBLIC] } };
  web = { 'https://example.com': { body: '<script src="/app.js"></script>' } };
  const snapshot = await capture('example.com', live(['example.com']), { crawl: true, confine: null });
  assert.equal(call('katana'), undefined, 'katana did not run');
  const row = snapshot.discovery.coverage.find(c => c.engine === 'katana');
  assert.equal(row.status, 'unavailable');
  assert.match(row.reason, /^Not run: this run has no scope proxy\. katana looks each name up again/);
  assert.equal(snapshot.discovery.crawl, undefined, 'no crawl is stored, so none reads as clean');
  // httpx still probed the checked name.
  assert.deepEqual(contacted(), ['example.com']);
  // A half-built boundary is no boundary.
  calls = [];
  await capture('example.com', live(['example.com']), { crawl: true, confine: { netClient: CONFINE.netClient } });
  assert.equal(call('katana'), undefined);
});

test('the lab crawl needs no scope proxy: its network has no route out', async () => {
  zone = { 'touchstone.test': { a: ['10.89.0.2'] } };
  await capture('touchstone.test', { network: 'touchstone-domains-test', granted: true, scope: ['touchstone.test'] }, { crawl: true, confine: null });
  assert.equal(call('katana').network, 'touchstone-domains-test');
  assert.equal(call('katana').cmd.includes('-proxy'), false);
});

// Item 1. The three Domains tools get only what passed the same checks.
test('checkdmarc gets the granted domain and the checked resolver, and makes no HTTP fetch', async () => {
  zone = { 'example.com': { a: [PUBLIC] } };
  await capture('example.com', live(['example.com'], { resolver: '1.1.1.1' }));
  const c = call('checkdmarc');
  assert.deepEqual(c.cmd.slice(0, 3), ['example.com', '-n', '1.1.1.1']);
  assert.equal(c.cmd.includes('--check-mx-tls'), false, 'no SMTP connection to an MX host');
  // MTA-STS and BIMI fetches go to a proxy address where nothing listens.
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) assert.equal(c.env[key], 'http://127.0.0.1:9', key);
  assert.equal(c.env.NO_PROXY, '');
  assert.equal(c.network, 'bridge');
});

test('no Domains tool runs for a domain the grant does not cover, or through a private resolver', async () => {
  zone = { 'example.com': { a: [PUBLIC] } };
  await assert.rejects(capture('example.com', live(['www.example.com'])), /grant that covers example\.com/);
  await assert.rejects(capture('example.com', live(['*.example.com'])), /grant that covers example\.com/);
  await assert.rejects(capture('example.com', live(['example.com'], { resolver: '10.0.0.53' })), /public resolver address/);
  await assert.rejects(capture('example.com', live(['example.com'], { resolver: '169.254.169.254' })), /public resolver address/);
  assert.deepEqual(calls, [], 'no tool ran');
  // The grant's opt-in lets the private resolver through to DNSViz and checkdmarc.
  await capture('lab.example.com', live(['lab.example.com'], { resolver: '10.0.0.53', allowPrivate: true }));
  assert.deepEqual(call('dnsviz').cmd.slice(0, 3), ['probe', '-s', '10.0.0.53']);
  assert.deepEqual(call('checkdmarc').cmd.slice(0, 3), ['lab.example.com', '-n', '10.0.0.53']);
});

test('DNSViz probes the granted domain through the resolver only, never a name server directly', async () => {
  zone = { 'example.com': { a: [PUBLIC] } };
  await capture('example.com', live(['example.com'], { resolver: '1.1.1.1' }));
  const probe = calls.filter(c => c.name === 'dnsviz');
  assert.equal(probe.length, 1, 'the stub fails the probe, so grok does not run');
  assert.deepEqual(probe[0].cmd, ['probe', '-s', '1.1.1.1', '-o', '/work/.live/dnssec-probe.json', 'example.com']);
  // -A, -x and -N would make the probe contact name servers whose addresses nobody checked.
  for (const flag of ['-A', '-x', '-N', '-u']) assert.equal(probe[0].cmd.includes(flag), false, flag);
});

test('testssl.sh gets only checked hosts, each with the address the capture checked', async () => {
  zone = { 'example.com': { a: [PUBLIC], aaaa: ['2606:2800:220:1::'] }, 'example.org': { a: ['93.184.216.35'] }, 'intranet.example.com': { a: ['10.0.0.1'] } };
  web = { 'https://example.com': { body: '<script src="https://example.org/a.js"></script><script src="https://intranet.example.com/b.js"></script>' } };
  const snapshot = await capture('example.com', live(['example.com', 'example.org', 'intranet.example.com']));
  const runs = calls.filter(c => c.name === 'testssl');
  const target = c => c.cmd.at(-1), ip = c => c.cmd[c.cmd.indexOf('--ip') + 1];
  assert.deepEqual(runs.map(target), ['example.com:443', 'example.org:443']);
  // Each endpoint gets its checked IPv4 address, so testssl.sh never looks the name up again.
  assert.deepEqual(runs.map(ip), [PUBLIC, '93.184.216.35']);
  assert.equal(snapshot.discovery.refused[0].host, 'intranet.example.com');
});

test('testssl.sh does not run for an endpoint with no checked address', async () => {
  // allowPrivate lifts the address rule, so a name with no address of its own is probed.
  zone = { 'example.com': { cname: ['gone.example.net'] } };
  const snapshot = await capture('example.com', live(['example.com'], { allowPrivate: true }));
  assert.equal(calls.some(c => c.name === 'testssl'), false, 'testssl.sh would look the name up itself');
  const row = snapshot.discovery.coverage.find(c => c.engine === 'testssl:example.com:443');
  assert.equal(row.status, 'unavailable');
  assert.match(row.reason, /^Not run: no checked address for example\.com\./);
  assert.match(snapshot.tls[0].error, /no checked address/);
});

test('a host with several checked addresses gets one testssl.sh run, pinned to one of them', async () => {
  zone = { 'example.com': { a: [PUBLIC, '93.184.216.36'], aaaa: ['2606:2800:220:1::'] }, 'v6.example.com': { aaaa: ['2606:2800:220:1::9'] } };
  await capture('example.com', live(['example.com', 'v6.example.com']));
  const runs = calls.filter(c => c.name === 'testssl');
  assert.deepEqual(runs.map(c => c.cmd.at(-1)), ['example.com:443', 'v6.example.com:443']);
  // The first checked IPv4 address, for --ip and for the name inside the container.
  assert.equal(runs[0].cmd[runs[0].cmd.indexOf('--ip') + 1], PUBLIC);
  assert.deepEqual(runs[0].addHosts, [['example.com', PUBLIC]]);
  // An IPv6-only host is pinned to its checked IPv6 address.
  assert.equal(runs[1].cmd[runs[1].cmd.indexOf('--ip') + 1], '2606:2800:220:1::9');
  assert.deepEqual(runs[1].addHosts, [['v6.example.com', '2606:2800:220:1::9']]);
  for (const r of runs) { assert.deepEqual(r.env, { PHONE_OUT: 'false' }); assert(r.cmd.includes('--nodns')); }
});

test('a live run with no resolver does not run checkdmarc or DNSViz, and says why', async () => {
  zone = { 'example.com': { a: [PUBLIC] } };
  const snapshot = await capture('example.com', live(['example.com']));
  // The two DNS tools did not run.
  assert.equal(call('checkdmarc'), undefined);
  assert.equal(call('dnsviz'), undefined);
  // Each shows a gap row with the reason, so the run view names the missing resolver.
  for (const engine of ['checkdmarc', 'dnsviz-probe', 'dnsviz-grok']) {
    const row = snapshot.discovery.coverage.find(c => c.engine === engine);
    assert.equal(row.status, 'unavailable', engine);
    assert.match(row.reason, /^Not run: a live run needs a resolver the grant names/);
  }
  // With a resolver, both run (the stub answers them as failed, so each is a gap with its own reason).
  calls = [];
  const withR = await capture('example.com', live(['example.com'], { resolver: '1.1.1.1' }));
  assert.deepEqual(call('checkdmarc').cmd.slice(0, 3), ['example.com', '-n', '1.1.1.1']);
  assert.deepEqual(call('dnsviz').cmd.slice(0, 3), ['probe', '-s', '1.1.1.1']);
  assert.doesNotMatch(withR.discovery.coverage.find(c => c.engine === 'checkdmarc').reason ?? '', /needs a resolver the grant names/);
  // A lab with no resolver still runs them: its network has its own internal resolver.
  calls = [];
  await capture('touchstone.test', { network: 'touchstone-domains-test', granted: true, scope: ['touchstone.test'] });
  assert(call('checkdmarc'), 'the lab runs checkdmarc');
  assert(call('dnsviz'), 'the lab runs DNSViz');
});

test('CAA is asked through the granted resolver with runTool, and no record is a LOW lead', async () => {
  zone = { 'example.com': { a: [PUBLIC] } };
  caa = { 'example.com': 'absent' };
  const snapshot = await capture('example.com', live(['example.com'], { resolver: '1.1.1.1' }));
  // drill ran through runTool (so it has runTool's guards), over TCP, to the granted resolver.
  assert.deepEqual(caaCalls.map(c => c.name), ['example.com']);
  const c = caaCalls[0];
  assert.equal(c.entrypoint, 'drill');
  assert.deepEqual(c.cmd, ['-t', '--', 'CAA', 'example.com', '@1.1.1.1']);
  assert.equal(c.network, 'bridge');
  // The drill output is stored, and the LOW lead replays from it.
  assert.match(snapshot.caa.raw, /^[0-9a-f]{64}$/);
  assert.deepEqual(caaLeads(snapshot).map(l => [l.check, l.severity, l.where]), [['tls-dns_caarecord', 'low', 'example.com']]);
  assert.equal(snapshot.discovery.coverage.find(c => c.engine === 'caa').leads, 1);

  // A CAA record present → no lead, the row still ran.
  caa = { 'example.com': ['0 issue "letsencrypt.org"'] };
  const ok = await capture('example.com', live(['example.com'], { resolver: '1.1.1.1' }));
  assert.deepEqual(caaLeads(ok), []);
  assert.deepEqual([ok.discovery.coverage.find(c => c.engine === 'caa').status, ok.discovery.coverage.find(c => c.engine === 'caa').leads], ['ran', 0]);

  // The query could not be asked (SERVFAIL) → a gap with the reason, never a lead.
  caa = { 'example.com': 'fail' };
  const gap = await capture('example.com', live(['example.com'], { resolver: '1.1.1.1' }));
  assert.equal(gap.caa, undefined);
  const row = gap.discovery.coverage.find(c => c.engine === 'caa');
  assert.equal(row.status, 'unavailable');
  assert.match(row.reason, /^CAA not checked:/);
  assert.deepEqual(caaLeads(gap), []);

  // No resolver → CAA is a gap and drill is never run.
  caaCalls = [];
  const noR = await capture('example.com', live(['example.com']));
  assert.equal(noR.discovery.coverage.find(c => c.engine === 'caa').status, 'unavailable');
  assert.equal(caaCalls.length, 0);
});

test('a truncated CAA answer is a gap, not a false "no record" lead, and replays as a gap', async () => {
  zone = { 'example.com': { a: [PUBLIC] } };
  caa = { 'example.com': 'tc' };          // the tc flag, 0 answers: a large answer drill did not fully read
  const snapshot = await capture('example.com', live(['example.com'], { resolver: '1.1.1.1' }));
  assert.equal(snapshot.caa, undefined, 'a truncated answer is not stored as evidence');
  const row = snapshot.discovery.coverage.find(c => c.engine === 'caa');
  assert.equal(row.status, 'unavailable');
  assert.match(row.reason, /full answer|truncated|not checked/);
  // Even a stored truncated block replays as incomplete, never "no record".
  const stored = ';; TOUCHSTONE-CAA example.com\n;; ->>HEADER<<- rcode: NOERROR\n;; flags: qr tc rd ;\n';
  const { sha256 } = await import('../lib/proof-evidence.mjs');
  assert.deepEqual(caaLeads({ root: 'example.com', caa: { domain: 'example.com', output: stored, raw: sha256(stored) } }), []);
});

test('CAA follows a CNAME: a target with CAA is no lead, a target without is a lead', async () => {
  zone = { 'www.example.com': { a: [PUBLIC] } };
  // www is a CNAME whose target publishes CAA inline: no lead.
  caa = { 'www.example.com': { cname: 'cdn.example.net', records: ['0 issue "ca.example"'] }, 'example.com': 'absent' };
  const ok = await capture('www.example.com', live(['www.example.com', '*.example.com'], { resolver: '1.1.1.1' }), { });
  assert.deepEqual(caaLeads(ok), []);
  // The CNAME target has no CAA, and the parent has none either: the LOW lead.
  caaCalls = [];
  caa = { 'www.example.com': { cname: 'cdn.example.net', records: [] }, 'cdn.example.net': 'absent', 'example.com': 'absent' };
  const miss = await capture('www.example.com', live(['www.example.com', '*.example.com'], { resolver: '1.1.1.1' }), { });
  // The target was asked at the same resolver, then the parent.
  assert(caaCalls.map(c => c.name).includes('cdn.example.net'));
  assert.deepEqual(caaLeads(miss).map(l => l.where), ['www.example.com']);
});

test('the CAA walk stops below a public suffix: example.co.uk is asked, co.uk is not', async () => {
  zone = { 'example.co.uk': { a: [PUBLIC] } };
  caa = { 'example.co.uk': 'absent' };
  await capture('example.co.uk', live(['example.co.uk'], { resolver: '1.1.1.1' }));
  assert.deepEqual(caaCalls.map(c => c.name), ['example.co.uk']);
  assert.equal(caaCalls.some(c => c.name === 'co.uk'), false);
});

test('a CNAME target that is not a plain domain name is never asked: a gap, not a lead', async () => {
  zone = { 'www.example.com': { a: [PUBLIC] } };
  // drill returns a CNAME whose "target" is an @server / a -option: it must not reach the argv.
  for (const bad of ['@ns.trap.test', '-T.trap.test']) {
    caaCalls = [];
    caa = { 'www.example.com': { cname: bad, records: [] }, 'example.com': 'absent' };
    const snap = await capture('www.example.com', live(['www.example.com', '*.example.com'], { resolver: '1.1.1.1' }));
    assert.deepEqual(caaCalls.map(c => c.name), ['www.example.com'], bad);
    assert.equal(snap.caa, undefined, bad);
    const row = snap.discovery.coverage.find(c => c.engine === 'caa');
    assert.equal(row.status, 'unavailable', bad);
    assert.match(row.reason, /not a plain domain name/, bad);
    assert.deepEqual(caaLeads(snap), [], bad);
  }
});

test('a CNAME loop is a gap, not a "no CAA" lead', async () => {
  zone = { 'loop.example.com': { a: [PUBLIC] } };
  caa = { 'loop.example.com': { cname: 'loop2.example.com', records: [] }, 'loop2.example.com': { cname: 'loop.example.com', records: [] } };
  const snap = await capture('loop.example.com', live(['loop.example.com', '*.example.com'], { resolver: '1.1.1.1' }));
  assert.equal(snap.caa, undefined);
  const row = snap.discovery.coverage.find(c => c.engine === 'caa');
  assert.equal(row.status, 'unavailable');
  assert.match(row.reason, /loops/);
  assert.deepEqual(caaLeads(snap), []);
});

// F2. An exact-host grant skips subdomain discovery. The run view says so.
test('an exact-host grant says that subdomain discovery was skipped, and names the "*." entry', async () => {
  zone = { 'example.com': { a: [PUBLIC] } };
  const snapshot = await capture('example.com', live(['example.com']));
  const row = snapshot.discovery.coverage.find(c => c.engine === 'subdomain-discovery');
  assert.equal(row.status, 'skipped');
  assert.match(row.reason, /has no \*\.example\.com entry/);
  const shown = prepassView({ pack: 'domains', leads: [], coverage: coverageOf(snapshot, []) }).tools.find(t => t.name === 'subdomain-discovery');
  assert.equal(shown.status, 'unavailable');
  assert.match(shown.reason, /Add \*\.example\.com to the grant/);
  // A "*." entry covers the subdomains, and the lab has its own rule: no row.
  calls = [];
  const wide = await capture('example.com', live(['example.com', '*.example.com']));
  assert.equal(wide.discovery.coverage.some(c => c.engine === 'subdomain-discovery'), false);
  const lab = await capture('touchstone.test', { network: 'touchstone-domains-test', granted: true, scope: ['touchstone.test'] });
  assert.equal(lab.discovery.coverage.some(c => c.engine === 'subdomain-discovery'), false);
});
