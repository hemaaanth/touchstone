// katana and jsluice in the live surface path: capture -> pinned snapshot -> inventory leads -> run view.
// The capture tools are faked with recorded output. No request leaves the machine.
// The snapshot analyzer is real: it runs in the domains tools image, offline.
import { test, mock, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as real from '../lib/wrap.mjs';

const fixture = name => readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8');
const recorded = fixture('katana-spa.jsonl');
const recordedUrls = fixture('jsluice-urls.jsonl');
const recordedSecrets = fixture('jsluice-secrets.jsonl');
const calls = [];
let katana, jsluice;
const page = '<!doctype html><html><head><title>Vault</title><script type="module" src="/assets/app.js"></script></head><body></body></html>';
const answers = {
  subfinder: () => ({ code: 0, stdout: '' }),
  dnsx: ({ cmd }) => ({ code: 0, stdout: cmd.includes('/work/.live/hosts.txt') ? JSON.stringify({ host: 'touchstone.test', status_code: 'NOERROR', a: ['127.0.0.1'] }) + '\n' : '' }),
  // The first probe asks for the origin. The second asks for the script the page loads.
  httpx: ({ cmd }) => {
    const urls = readFileSync(join(current, cmd[cmd.indexOf('-l') + 1].replace('/work/', '')), 'utf8').split('\n');
    const rows = [];
    if (urls.includes('http://touchstone.test')) rows.push({ url: 'http://touchstone.test', status_code: 200, raw_header: 'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n', body: page });
    if (urls.includes('http://touchstone.test/assets/app.js')) rows.push({ url: 'http://touchstone.test/assets/app.js', status_code: 200, raw_header: 'HTTP/1.1 200 OK\r\nContent-Type: text/javascript\r\n\r\n', body: 'export {};' });
    return { code: 0, stdout: rows.map(r => JSON.stringify(r) + '\n').join('') };
  },
  nuclei: () => ({ code: 0, stdout: '' }),
  katana: () => katana,
  // jsluice answers with the recorded rows for each file whose body is a recorded script.
  jsluice: ({ cmd }) => {
    const answer = jsluice[cmd[0]];
    if (answer !== 'recorded') return answer;
    const out = cmd.filter(a => a.startsWith('/work/')).flatMap(file => {
      const i = labScripts.findIndex(s => s.body === readFileSync(join(current, file.replace('/work/', '')), 'utf8'));
      return i < 0 ? [] : (cmd[0] === 'urls' ? recordedUrls : recordedSecrets).split('\n').filter(l => l.includes('"filename":"' + jsluiceFile(i) + '"')).map(l => l.replace(jsluiceFile(i), file));
    });
    return { code: 0, stdout: out.map(l => l + '\n').join('') };
  },
};
let current;
// The domains-only tools are never run for real here. Each call is recorded and
// answered with a refusal, so no request leaves the machine.
let deepAnswers = {};
const DEEP = { checkdmarc: 'letiemble/checkdmarc:', testssl: 'drwetter/testssl.sh:', dnsviz: 'dnsviz/dnsviz@' };
mock.module('../lib/wrap.mjs', { exports: { ...real, runTool: async opts => {
  const deep = Object.keys(DEEP).find(n => opts.image.startsWith(DEEP[n]));
  if (deep) { calls.push({ name: deep, ...opts }); return { code: 125, stdout: '', stderr: 'not run in this test', timedOut: false, ...deepAnswers[deep]?.(opts) }; }
  const name = Object.keys(answers).find(n => opts.image.startsWith('projectdiscovery/' + n + ':') || opts.image.startsWith('touchstone-' + n + ':'));
  if (!name) return real.runTool(opts);
  calls.push({ name, ...opts });
  return { stderr: '', timedOut: false, ...answers[name](opts) };
} } });
// The capture loads grant-store, which reads the console token when it loads. Point it at
// test values first, so no real token, grant or scope file is read (1h review F4).
const store = mkdtempSync(join(tmpdir(), 'surface-wiring-store-'));
process.env.TOUCHSTONE_GRANT_TOKEN = 'test-token-not-real';
process.env.TOUCHSTONE_GRANTS_FILE = join(store, 'grants.json');
process.env.TOUCHSTONE_SCOPES_FILE = join(store, 'scopes.json');
after(() => rmSync(store, { recursive: true, force: true }));
const { default: surface } = await import('../packs/surface/pack.mjs');
const { default: domains } = await import('../packs/domains/pack.mjs');
const { detectorsFor } = await import('../packs/domains/checks.mjs');
const { crawlScope, ensureJsluice, jsluiceFile, scriptBodies } = await import('../packs/domains/live.mjs');
const { replayEvidence } = await import('../lib/proof-evidence.mjs');
const { prepassView } = await import('../lib/prepass-view.mjs');

// The fixture was recorded against the 127.0.0.1 lab, so the grant names that host and the lab port.
const labPort = Number(new URL(JSON.parse(recorded.split('\n')[0]).request.endpoint).port);
// allowPrivate: the lab host is a loopback address. The capture refuses one without the grant's opt-in.
// A resolver the grant names: a live run needs one for checkdmarc and DNSViz (G1 repair item 6).
// allowPrivate lets this loopback resolver pass the reach check, as the lab host is loopback.
const reach = { network: 'bridge', granted: true, allowPrivate: true, resolver: '127.0.0.1', scope: ['touchstone.test', '127.0.0.1'], ports: [{ scheme: 'http', port: 80 }, { scheme: 'http', port: labPort }] };
// The scripts the jsluice fixtures were recorded from, in the recorded file order.
const labScripts = scriptBodies(recorded, [], ['127.0.0.1'], [{ scheme: 'http', port: labPort }]);
// The run's reach as app/server/runs.mjs hands it to the prepass: openReach's confine boundary.
// Nothing runs here: the capture only reads the two names.
const CONFINE = { netClient: 'touchstone-reach-client-test', gateUrl: 'http://scope-gate:8080' };
async function prepass(pack, runReach = { confine: CONFINE }) {
  current = mkdtempSync(join(tmpdir(), 'surface-katana-wiring-'));
  writeFileSync(join(current, '.touchstone.json'), JSON.stringify({ kind: 'live', pack: pack.id, domain: 'touchstone.test', reach }));
  return { ws: current, ...(await pack.prepass(current, { emit: () => {}, reach: runReach })) };
}
beforeEach(() => {
  calls.length = 0;
  deepAnswers = {};
  katana = { code: 0, stdout: recorded };
  jsluice = { urls: 'recorded', secrets: 'recorded' };
});
// The capture checks that the jsluice image exists before it runs it.
assert.equal(ensureJsluice(), null, 'the jsluice image is ready');

test('a live surface run crawls with katana and shows the endpoints as leads', async () => {
  jsluice = { urls: { code: 0, stdout: '' }, secrets: { code: 0, stdout: '' } };
  const { ws, record } = await prepass(surface);
  try {
    const crawl = calls.find(c => c.name === 'katana');
    assert(crawl, 'katana ran');
    // katana looks each name up again, so it runs where the scope proxy is its only way out.
    assert.equal(crawl.network, CONFINE.netClient, 'katana uses the confined network');
    assert.equal(crawl.cmd[crawl.cmd.indexOf('-proxy') + 1], CONFINE.gateUrl, 'katana sends every request through the scope proxy');
    assert.equal(crawl.timeoutMs, 180000);
    assert.equal(crawl.cmd[crawl.cmd.indexOf('-cs') + 1], crawlScope(reach.scope, reach.ports, true), 'katana gets the grant hosts and ports, each host exact');
    assert(crawl.cmd.includes('-dr'), 'a live crawl follows no redirect');
    assert.equal(readFileSync(join(ws, 'snapshot.json'), 'utf8').includes('"crawl"'), true, 'the crawl is pinned with the snapshot');
    const endpoints = record.leads.filter(l => l.check === 'discovered-endpoint');
    assert.equal(endpoints.length, 8);
    for (const lead of endpoints) {
      assert.equal(lead.engine, 'katana');
      assert.equal(lead.foundBy, 'katana');
      assert.equal(lead.nextPack, 'web');
      assert.equal(lead.severity, 'informational');
      assert.equal(lead.scope, 'live');
    }
    const users = endpoints.find(l => l.where.endsWith('/admin/users'));
    assert.equal(users.kind, 'route');
    assert.match(users.description, /found it in JavaScript at http:\/\/127\.0\.0\.1:\d+\/assets\/app\.js\. katana kept no status/);
    assert.match(endpoints.find(l => l.where.endsWith('/api/v1/session')).description, /answered HTTP 200/);
    // The host and service leads are still there.
    assert(record.leads.some(l => l.check === 'discovered-service' && l.where === 'http://touchstone.test'));
    assert.deepEqual(record.coverage.find(c => c.engine === 'katana'), { engine: 'katana', status: 'ran', leads: 8 });
    // The run view the app shows lists katana and its leads.
    const view = prepassView(record);
    assert.deepEqual(view.tools.find(t => t.name === 'katana'), { name: 'katana', status: 'ran', reason: null, leads: 8 });
    assert(view.leads.some(l => l.check === 'discovered-endpoint' && l.tools.includes('katana') && l.where.endsWith('/api/v1/admin/export')));
    // The evidence replay confirms a crawled endpoint and rejects one katana did not find.
    const options = { detectors: detectorsFor('surface') };
    const evidence = { check: 'discovered-endpoint', where: users.where, snapshotHash: record.snapshotHash };
    assert.equal((await replayEvidence(ws, evidence, options)).status, 'pass');
    assert.equal((await replayEvidence(ws, { ...evidence, where: users.where.replace('/admin/users', '/dashboard') }, options)).status, 'fail');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('a missing katana image is a coverage error, not a clean crawl', async () => {
  katana = { code: 125, stdout: '', stderr: "Unable to find image 'projectdiscovery/katana@sha256:5dc4' locally\ndocker: Error response from daemon: pull access denied for projectdiscovery/katana." };
  const { ws, record } = await prepass(surface);
  try {
    const cov = record.coverage.find(c => c.engine === 'katana');
    assert.equal(cov.status, 'unavailable');
    assert.match(cov.reason, /^Docker could not run the image projectdiscovery\/katana:v1\.2\.2@sha256:[0-9a-f]{64}\. .*pull access denied/s);
    assert.equal(record.leads.some(l => l.check === 'discovered-endpoint'), false);
    assert(record.leads.some(l => l.check === 'discovered-service'), 'the rest of the inventory still stands');
    assert.equal(prepassView(record).tools.find(t => t.name === 'katana').status, 'unavailable');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('a katana error or timeout is a coverage error with its cause', async () => {
  katana = { code: 1, stdout: '', stderr: '[FTL] Could not read flags' };
  let { ws, record } = await prepass(surface);
  rmSync(ws, { recursive: true, force: true });
  assert.deepEqual(record.coverage.find(c => c.engine === 'katana'), { engine: 'katana', status: 'unavailable', reason: 'Exited with code 1. [FTL] Could not read flags', leads: 0 });
  katana = { code: 1, stdout: '', stderr: '', timedOut: true };
  ({ ws, record } = await prepass(surface));
  rmSync(ws, { recursive: true, force: true });
  assert.match(record.coverage.find(c => c.engine === 'katana').reason, /^Timed out/);
});

test('endpoints on a port the grant does not name are dropped', async () => {
  const saved = reach.ports;
  reach.ports = [{ scheme: 'http', port: 80 }];
  try {
    const { ws, record } = await prepass(surface);
    rmSync(ws, { recursive: true, force: true });
    assert.equal(record.leads.some(l => l.check === 'discovered-endpoint'), false);
    assert.equal(record.coverage.find(c => c.engine === 'katana').leads, 0);
  } finally { reach.ports = saved; }
});

test('a live surface run with no scope proxy does not crawl, and the run view says why', async () => {
  for (const runReach of [null, { confine: null }]) {
    calls.length = 0;
    const { ws, record } = await prepass(surface, runReach);
    rmSync(ws, { recursive: true, force: true });
    assert.equal(calls.some(c => c.name === 'katana'), false, 'katana did not run');
    const shown = prepassView(record).tools.find(t => t.name === 'katana');
    assert.equal(shown.status, 'unavailable');
    assert.match(shown.reason, /no scope proxy/);
    // The script httpx fetched is still read, offline.
    assert.equal(calls.find(c => c.name === 'jsluice')?.network, 'none');
  }
});

test('a live domains run does not crawl', async () => {
  const { ws } = await prepass(domains);
  rmSync(ws, { recursive: true, force: true });
  assert(calls.some(c => c.name === 'httpx'));
  assert.equal(calls.some(c => c.name === 'katana'), false);
});

test('a live surface run reads the crawled JavaScript with jsluice, offline', async () => {
  const { ws, record } = await prepass(surface);
  try {
    const runs = calls.filter(c => c.name === 'jsluice');
    assert.deepEqual(runs.map(c => c.cmd[0]), ['urls', 'secrets']);
    for (const run of runs) {
      assert.equal(run.network, 'none', 'jsluice gets no network, even on a granted run');
      assert.equal(run.timeoutMs, 120000);
      // The katana scripts and the script httpx fetched. File paths only.
      assert.deepEqual(run.cmd.slice(1), ['-c', '2', jsluiceFile(0), jsluiceFile(1), jsluiceFile(2)]);
    }
    const snapshot = JSON.parse(readFileSync(join(ws, 'snapshot.json'), 'utf8'));
    assert.deepEqual(snapshot.discovery.jsluice.scripts.map(u => new URL(u).pathname), ['/assets/admin.js', '/assets/app.js', '/assets/app.js']);
    const endpoints = record.leads.filter(l => l.check === 'discovered-endpoint');
    // jsluice adds what katana missed. It joins what both found.
    const dashboard = endpoints.find(l => l.where.endsWith('/dashboard'));
    assert.deepEqual(dashboard.engines, ['jsluice']);
    assert.equal(dashboard.kind, 'route');
    assert.match(dashboard.description, /jsluice found it in JavaScript at http:\/\/127\.0\.0\.1:\d+\/assets\/app\.js \(stringLiteral\)\. jsluice reads code only/);
    const wallets = endpoints.find(l => l.where.endsWith('/api/v1/users/EXPR/wallets'));
    assert.equal(wallets.kind, 'api-endpoint');
    assert.match(wallets.description, /method GET\)\. EXPR is a part the script builds at run time/);
    const session = endpoints.find(l => l.where.endsWith('/api/v1/session'));
    assert.deepEqual(session.engines, ['katana', 'jsluice']);
    assert.equal(session.foundBy, 'katana, jsluice');
    assert.match(session.description, /^katana found it .* jsluice found it .* Kind: api-endpoint \(its path or answer looks like an API\)\. Found by: katana, jsluice\. Next pack: web\.$/);
    assert.equal(endpoints.filter(l => l.where === session.where).length, 1, 'one lead per endpoint');
    assert.equal(endpoints.length, 11, '8 from katana and 3 that only jsluice found');
    // The secret is a lead with no value in it, and the snapshot pins no value from jsluice.
    const [secret] = record.leads.filter(l => l.check === 'discovered-secret');
    assert.match(secret.where, /^http:\/\/127\.0\.0\.1:\d+\/assets\/app\.js#AWSAccessKey-[0-9a-f]{12}$/);
    assert.equal(secret.engine, 'jsluice-secrets');
    assert.equal(secret.severity, 'informational');
    assert.match(secret.description, /jsluice rates it high\. Fields: key \(20 chars\), secret \(40 chars\)\. .* The values are not kept\. A match does not prove/);
    for (const raw of ['AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI', 'vault-uploads']) {
      assert(!JSON.stringify(record).includes(raw), raw + ' is not in the result');
      assert(!JSON.stringify(snapshot.discovery).includes(raw), raw + ' is not in the pinned discovery');
    }
    assert.deepEqual(record.coverage.find(c => c.engine === 'jsluice'), { engine: 'jsluice', status: 'ran', leads: 10 });
    assert.deepEqual(record.coverage.find(c => c.engine === 'jsluice-secrets'), { engine: 'jsluice-secrets', status: 'ran', leads: 1 });
    const view = prepassView(record);
    assert.deepEqual(view.tools.find(t => t.name === 'jsluice'), { name: 'jsluice', status: 'ran', reason: null, leads: 10 });
    assert(view.leads.some(l => l.check === 'discovered-secret' && l.tools.includes('jsluice-secrets')));
    assert.deepEqual(view.leads.find(l => l.where === session.where).tools, ['katana', 'jsluice']);
    // The evidence replay confirms jsluice leads from the pin and rejects ones it did not find.
    const options = { detectors: detectorsFor('surface') };
    const ask = (check, where) => replayEvidence(ws, { check, where, snapshotHash: record.snapshotHash }, options).then(r => r.status);
    assert.equal(await ask('discovered-endpoint', dashboard.where), 'pass');
    assert.equal(await ask('discovered-secret', secret.where), 'pass');
    assert.equal(await ask('discovered-secret', secret.where.replace(/-[0-9a-f]{12}$/, '-000000000000')), 'fail');
    assert.equal(await ask('discovered-endpoint', dashboard.where.replace('/dashboard', '/billing')), 'fail');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('a missing jsluice image or a jsluice error is a coverage error, not a clean read', async () => {
  const cases = [
    [{ code: 125, stdout: '', stderr: "Unable to find image 'touchstone-jsluice:0ddfab1' locally" }, /^Docker could not run the image touchstone-jsluice:0ddfab1\. /],
    [{ code: 0, stdout: '', stderr: 'error: open /work/.live/js/0001.js: no such file or directory\n' }, /^jsluice could not read 1 of 3 scripts\. error: open \/work\/\.live\/js\/0001\.js/],
    [{ code: 1, stdout: '', stderr: '', timedOut: true }, /^Timed out/],
  ];
  for (const [answer, reason] of cases) {
    jsluice = { urls: answer, secrets: answer };
    const { ws, record } = await prepass(surface);
    rmSync(ws, { recursive: true, force: true });
    for (const engine of ['jsluice', 'jsluice-secrets']) {
      const cov = record.coverage.find(c => c.engine === engine);
      assert.equal(cov.status, 'unavailable', engine);
      assert.match(cov.reason, reason, engine);
      assert.equal(prepassView(record).tools.find(t => t.name === engine).status, 'unavailable');
    }
    assert.equal(record.leads.some(l => l.engines.includes('jsluice')), false);
    assert(record.leads.some(l => l.engine === 'katana'), 'the katana leads still stand');
  }
});

test('a domains run does not run jsluice', async () => {
  const { ws } = await prepass(domains);
  rmSync(ws, { recursive: true, force: true });
  assert.equal(calls.some(c => c.name === 'jsluice'), false);
});

// M-D: checkdmarc, testssl and DNSViz belong to the domains pack. A surface
// prepass must not run them, and its snapshot keeps the main-branch shape.
test('a live surface run does not run the domains-only tools; a domains run does', async () => {
  let { ws, record } = await prepass(surface);
  const snapshot = JSON.parse(readFileSync(join(ws, 'snapshot.json'), 'utf8'));
  rmSync(ws, { recursive: true, force: true });
  assert.deepEqual(calls.filter(c => DEEP[c.name]).map(c => c.name), []);
  for (const key of ['email', 'tls', 'dnssec']) assert.equal(key in snapshot, false, key);
  assert.equal(record.coverage.some(c => /^(checkdmarc|testssl|dnsviz)/.test(c.engine)), false);
  calls.length = 0;
  ({ ws, record } = await prepass(domains));
  rmSync(ws, { recursive: true, force: true });
  assert.deepEqual([...new Set(calls.filter(c => DEEP[c.name]).map(c => c.name))], ['checkdmarc', 'dnsviz']);
  assert.equal(record.coverage.find(c => c.engine === 'checkdmarc').status, 'unavailable');
});

// m3: an incomplete DNSViz assessment must mark the dnsviz rows unavailable in
// the live capture, not leave them as ran. The answer is the recorded lab
// assessment with its query answers removed, so the DNSKEY state is unread.
test('a domains prepass marks the DNSViz rows unavailable for an incomplete assessment', async () => {
  const doc = JSON.parse(readFileSync(new URL('../packs/domains/fixtures/dnsviz-unsigned.json', import.meta.url), 'utf8'));
  delete doc['touchstone.test.'].queries;
  deepAnswers.dnsviz = ({ cmd }) => {
    if (cmd[0] === 'grok') writeFileSync(join(current, cmd[cmd.indexOf('-o') + 1].replace('/work/', '')), JSON.stringify(doc));
    return { code: 0, stderr: '' };
  };
  const { ws, record } = await prepass(domains);
  rmSync(ws, { recursive: true, force: true });
  assert.deepEqual(calls.filter(c => c.name === 'dnsviz').map(c => c.cmd[0]), ['probe', 'grok']);
  for (const engine of ['dnsviz-probe', 'dnsviz-grok']) {
    const row = record.coverage.find(c => c.engine === engine);
    assert.equal(row.status, 'unavailable', engine);
    assert.equal(row.reason, 'incomplete assessment: no DNSKEY answer', engine);
  }
  assert(record.leads.some(l => l.check === 'dnssec-evidence-missing'));
});
