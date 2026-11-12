// katana: the real tool against the 127.0.0.1 SPA lab, and its parser on recorded output.
// Record the fixture again with: RECORD_KATANA=1 node --test test/surface-katana.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTool } from '../lib/wrap.mjs';
import { KATANA, PORTS, crawlScope, katanaArgs, parseKatana } from '../packs/domains/live.mjs';
import { classifyEndpoint } from '../packs/domains/checks.mjs';
import { startSpaLab } from '../packs/surface/spa-lab/server.mjs';

const FIXTURE = new URL('./fixtures/katana-spa.jsonl', import.meta.url);
const recorded = readFileSync(FIXTURE, 'utf8');
const LAB = ['127.0.0.1'];
// The fixture was recorded from the lab. Its first row is the seed page, so it names the port.
const AT = [{ scheme: 'http', port: Number(new URL(JSON.parse(recorded.split('\n')[0]).request.endpoint).port) }];
const paths = rows => rows.map(r => new URL(r.url).pathname);

test('katana runs pinned, in standard mode, with the pack limits', () => {
  assert.match(KATANA, /^projectdiscovery\/katana:v1\.2\.2@sha256:[0-9a-f]{64}$/);
  const args = katanaArgs('/work/x.txt', ['example.com'], '10.0.0.53');
  for (const flag of ['-hl', '-headless', '-sc', '-or', '-ob']) assert(!args.includes(flag), flag + ' must stay off');
  for (const [flag, value] of [['-rl', '5'], ['-c', '2'], ['-timeout', '10'], ['-retry', '1'], ['-d', '3'], ['-ct', '120s'], ['-r', 'udp:10.0.0.53:53']]) assert.equal(args[args.indexOf(flag) + 1], value, flag);
  assert(args.includes('-jc') && args.includes('-duc'));
  assert(!katanaArgs('/work/x.txt', ['example.com']).includes('-r'));
});

test('the crawl scope regex covers granted hosts, their subdomains and granted ports only', () => {
  const re = new RegExp(crawlScope(['example.com'], PORTS));
  for (const url of ['https://example.com/', 'https://a.example.com/x', 'http://example.com', 'https://example.com:443/', 'http://example.com:80/x']) assert(re.test(url), url);
  for (const url of ['https://badexample.com/', 'https://example.com.evil.net/', 'https://exampleXcom/', 'ftp://example.com/', 'https://example.com:8443/', 'http://example.com:8080/', 'https://example.com:80/']) assert(!re.test(url), url);
  const odd = new RegExp(crawlScope(['example.com'], [{ scheme: 'https', port: 8443 }]));
  assert(odd.test('https://example.com:8443/a') && !odd.test('https://example.com/') && !odd.test('http://example.com:8443/'));
});

test('recorded katana output becomes in-scope crawl rows', () => {
  const rows = parseKatana(recorded, LAB, AT);
  // The JavaScript regex finds two-segment routes, API calls and a lazy chunk.
  for (const p of ['/admin/users', '/settings/api-keys', '/api/v1/session', '/api/v1/withdrawals', '/api/v1/admin/export', '/assets/app.js', '/assets/admin.js']) assert(paths(rows).includes(p), p);
  // Known limit of standard mode: a one-segment route in an object key is not found.
  assert(!paths(rows).includes('/dashboard'));
  // The seed page is httpx's job. It has no source, so it is not a crawl row.
  assert(!paths(rows).includes('/'));
  const users = rows.find(r => r.url.endsWith('/admin/users'));
  assert.equal(users.status, null, 'katana kept no status for the SPA fallback page');
  assert.equal(users.tag, 'js');
  assert.match(users.source, /\/assets\/app\.js$/);
  assert.equal(rows.find(r => r.url.endsWith('/api/v1/session')).status, 200);
  assert.deepEqual(parseKatana(recorded, ['example.com'], AT), [], 'hosts outside the grant are dropped');
  assert.deepEqual(parseKatana(recorded, LAB, PORTS), [], 'ports outside the grant are dropped');
  assert.deepEqual(parseKatana('noise\n{"request":{}}\n', LAB, AT), []);
});

test('crawl rows are typed for the hand-off', () => {
  const kind = url => classifyEndpoint(parseKatana(recorded, LAB, AT).find(r => r.url.endsWith(url))).kind;
  assert.equal(kind('/assets/admin.js'), 'script');
  assert.equal(kind('/api/v1/session'), 'api-endpoint');
  assert.equal(kind('/admin/users'), 'route');
});

test('real katana crawls the 127.0.0.1 SPA lab and stays in scope', { timeout: 200000 }, async () => {
  const lab = await startSpaLab();
  const ws = mkdtempSync(join(tmpdir(), 'surface-katana-'));
  try {
    writeFileSync(join(ws, 'crawl.txt'), 'http://127.0.0.1:' + lab.port + '/\n');
    // Host network only so the container reaches 127.0.0.1. The scope regex keeps the crawl on it.
    const at = [{ scheme: 'http', port: lab.port }];
    const result = await runTool({ image: KATANA, ws, network: 'host', env: { HOME: '/tmp', XDG_CONFIG_HOME: '/tmp/.config' }, cmd: katanaArgs('/work/crawl.txt', LAB, undefined, at), timeoutMs: 180000 });
    assert.equal(result.code, 0, result.stderr);
    if (process.env.RECORD_KATANA) writeFileSync(FIXTURE, result.stdout);
    const rows = parseKatana(result.stdout, LAB, at);
    for (const p of ['/admin/users', '/api/v1/session', '/assets/admin.js', '/api/v1/admin/export']) assert(paths(rows).includes(p), p);
    // app.js links to http://localhost:<port>/status. Same server, other host name: never requested.
    assert(lab.hits.length > 3);
    assert(lab.hits.every(h => h.host.startsWith('127.0.0.1:')), JSON.stringify(lab.hits));
    assert(!lab.hits.some(h => h.path === '/status'));
  } finally { await lab.close(); rmSync(ws, { recursive: true, force: true }); }
});
