// katana in the live surface path: capture -> pinned snapshot -> inventory leads -> run view.
// The capture tools are faked with recorded output. No request leaves the machine.
// The snapshot analyzer is real: it runs in the domains tools image, offline.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as real from '../lib/wrap.mjs';

const recorded = readFileSync(new URL('./fixtures/katana-spa.jsonl', import.meta.url), 'utf8');
const calls = [];
let katana;
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
};
let current;
mock.module('../lib/wrap.mjs', { exports: { ...real, runTool: async opts => {
  const name = Object.keys(answers).find(n => opts.image.startsWith('projectdiscovery/' + n + ':'));
  if (!name) return real.runTool(opts);
  calls.push({ name, ...opts });
  return { stderr: '', timedOut: false, ...answers[name](opts) };
} } });
const { default: surface } = await import('../packs/surface/pack.mjs');
const { default: domains } = await import('../packs/domains/pack.mjs');
const { detectorsFor } = await import('../packs/domains/checks.mjs');
const { crawlScope } = await import('../packs/domains/live.mjs');
const { replayEvidence } = await import('../lib/proof-evidence.mjs');
const { prepassView } = await import('../lib/prepass-view.mjs');

// The fixture was recorded against the 127.0.0.1 lab on port 39051, so the grant names both.
const reach = { network: 'bridge', granted: true, scope: ['touchstone.test', '127.0.0.1'], ports: [{ scheme: 'http', port: 80 }, { scheme: 'http', port: 39051 }] };
async function prepass(pack) {
  current = mkdtempSync(join(tmpdir(), 'surface-katana-wiring-'));
  writeFileSync(join(current, '.touchstone.json'), JSON.stringify({ kind: 'live', pack: pack.id, domain: 'touchstone.test', reach }));
  return { ws: current, ...(await pack.prepass(current, { emit: () => {} })) };
}
beforeEach(() => { calls.length = 0; katana = { code: 0, stdout: recorded }; });

test('a live surface run crawls with katana and shows the endpoints as leads', async () => {
  const { ws, record } = await prepass(surface);
  try {
    const crawl = calls.find(c => c.name === 'katana');
    assert(crawl, 'katana ran');
    assert.equal(crawl.network, 'bridge', 'katana uses the grant network');
    assert.equal(crawl.timeoutMs, 180000);
    assert.equal(crawl.cmd[crawl.cmd.indexOf('-cs') + 1], crawlScope(reach.scope, reach.ports), 'katana gets the grant hosts and ports');
    assert.equal(readFileSync(join(ws, 'snapshot.json'), 'utf8').includes('"crawl"'), true, 'the crawl is pinned with the snapshot');
    const endpoints = record.leads.filter(l => l.check === 'discovered-endpoint');
    assert.equal(endpoints.length, 7);
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
    assert.deepEqual(record.coverage.find(c => c.engine === 'katana'), { engine: 'katana', status: 'ran', leads: 7 });
    // The run view the app shows lists katana and its leads.
    const view = prepassView(record);
    assert.deepEqual(view.tools.find(t => t.name === 'katana'), { name: 'katana', status: 'ran', reason: null, leads: 7 });
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

test('a live domains run does not crawl', async () => {
  const { ws } = await prepass(domains);
  rmSync(ws, { recursive: true, force: true });
  assert(calls.some(c => c.name === 'httpx'));
  assert.equal(calls.some(c => c.name === 'katana'), false);
});
