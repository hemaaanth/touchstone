// jsluice: the real tool on the JavaScript katana fetched from the 127.0.0.1 SPA lab, and its parsers on recorded output.
// Record the fixtures again with: RECORD_JSLUICE=1 node --test test/surface-jsluice.test.mjs
// Record katana first if the lab changed, so both fixtures come from the same lab run.
import { test } from 'node:test';
import { skipUnlessImages } from './docker-skip.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTool } from '../lib/wrap.mjs';
import { JSLUICE, MAX_SCRIPTS, PORTS, ensureJsluice, jsluiceArgs, jsluiceErrors, jsluiceFile, parseJsluiceSecrets, parseJsluiceUrls, scriptBodies } from '../packs/domains/live.mjs';

const fixture = name => new URL('./fixtures/' + name, import.meta.url);
const katana = readFileSync(fixture('katana-spa.jsonl'), 'utf8');
const urlsOut = readFileSync(fixture('jsluice-urls.jsonl'), 'utf8');
const secretsOut = readFileSync(fixture('jsluice-secrets.jsonl'), 'utf8');
const LAB = ['127.0.0.1'];
const AT = [{ scheme: 'http', port: Number(new URL(JSON.parse(katana.split('\n')[0]).request.endpoint).port) }];
const scripts = scriptBodies(katana, [], LAB, AT);
const paths = rows => rows.map(r => new URL(r.url).pathname);

test('jsluice runs from our pinned build, offline, on file paths only', () => {
  assert.match(JSLUICE, /^touchstone-jsluice:0ddfab1$/);
  const dockerfile = readFileSync(new URL('../packs/surface/jsluice/Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /^FROM golang:[^\s]+@sha256:[0-9a-f]{64} AS build$/m);
  assert.match(dockerfile, /^FROM debian:[^\s]+@sha256:[0-9a-f]{64}$/m);
  assert.match(dockerfile, /jsluice@0ddfab153e060a9eeaded4d8669233f7c071e7e4/);
  assert.match(dockerfile, /[0-9a-f]{64} {2}\/go\/bin\/jsluice" \| sha256sum -c -/);
  const args = jsluiceArgs('urls', 3);
  assert.deepEqual(args, ['urls', '-c', '2', jsluiceFile(0), jsluiceFile(1), jsluiceFile(2)]);
  // jsluice fetches an argument that starts with http(s)://. It only ever gets files.
  assert(args.slice(3).every(a => a.startsWith('/work/.live/js/') && a.endsWith('.js')));
});

test('the scripts to read are the in-scope JavaScript answers, one per URL', () => {
  assert.deepEqual(paths(scripts), ['/assets/admin.js', '/assets/app.js']);
  assert(scripts.every(s => s.body.length > 0));
  assert.deepEqual(scriptBodies(katana, [], ['example.com'], AT), [], 'hosts outside the grant are dropped');
  assert.deepEqual(scriptBodies(katana, [], LAB, PORTS), [], 'ports outside the grant are dropped');
  // httpx script rows count too. A row that is not JavaScript or did not answer 200 does not.
  const http = [
    { url: 'http://127.0.0.1:' + AT[0].port + '/assets/app.js', status: 200, headers: { 'content-type': 'application/javascript' }, body: 'httpx copy' },
    { url: 'http://127.0.0.1:' + AT[0].port + '/x.js', status: 404, headers: {}, body: 'Not found' },
    { url: 'http://127.0.0.1:' + AT[0].port + '/page', status: 200, headers: { 'content-type': 'text/html' }, body: '<html>' },
  ];
  const both = scriptBodies(katana, http, LAB, AT);
  assert.deepEqual(paths(both), ['/assets/admin.js', '/assets/app.js']);
  assert.equal(both[1].body, 'httpx copy', 'one body per URL');
  const many = Array.from({ length: MAX_SCRIPTS + 5 }, (_, i) => ({ url: 'http://127.0.0.1:' + AT[0].port + '/s' + i + '.js', status: 200, headers: {}, body: 'x' }));
  assert.equal(scriptBodies('', many, LAB, AT).length, MAX_SCRIPTS);
});

test('recorded jsluice urls become in-scope endpoint rows', () => {
  const rows = parseJsluiceUrls(urlsOut, scripts, LAB, AT);
  // jsluice sees what katana's regex misses: a one-segment route and a path built at run time.
  for (const p of ['/dashboard', '/api/v1/users/EXPR/wallets', '/settings/api-keys', '/admin/users', '/api/v1/session', '/assets/admin.js', '/api/v1/admin/export']) assert(paths(rows).includes(p), p);
  const wallets = rows.find(r => r.url.endsWith('/api/v1/users/EXPR/wallets'));
  assert.deepEqual(wallets.methods, ['GET']);
  assert.match(wallets.source, /\/assets\/app\.js$/);
  assert.deepEqual(rows.find(r => r.url.endsWith('/api/v1/withdrawals')).methods, ['POST']);
  assert.match(rows.find(r => r.url.endsWith('/api/v1/admin/export')).source, /\/assets\/admin\.js$/, 'a URL is read against its own script');
  assert.equal(new Set(rows.map(r => r.url)).size, rows.length, 'one row per URL');
  assert.deepEqual(parseJsluiceUrls(urlsOut, scripts, ['example.com'], AT), [], 'hosts outside the grant are dropped');
  assert.deepEqual(parseJsluiceUrls(urlsOut, scripts, LAB, PORTS), [], 'ports outside the grant are dropped');
  // Absolute URLs to other hosts, unknown files and noise are dropped.
  const odd = [{ url: 'https://evil.example/x', filename: '/work/.live/js/0000.js' }, { url: '/x', filename: '/work/.live/js/0099.js' }, { url: 'javascript:void(0)', filename: '/work/.live/js/0000.js' }];
  assert.deepEqual(parseJsluiceUrls('noise\n' + odd.map(r => JSON.stringify(r)).join('\n'), scripts, LAB, AT), []);
});

test('recorded jsluice secrets keep no secret value', () => {
  const rows = parseJsluiceSecrets(secretsOut, scripts);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.kind, 'AWSAccessKey');
  assert.equal(row.severity, 'high');
  assert.match(row.source, /\/assets\/app\.js$/);
  assert.deepEqual(row.fields, { key: 20, secret: 40 });
  assert.match(row.fingerprint, /^[0-9a-f]{12}$/);
  // The recorded output holds the values and the context. The parsed row holds neither.
  assert(secretsOut.includes('AKIAIOSFODNN7EXAMPLE') && secretsOut.includes('vault-uploads'));
  for (const raw of ['AKIA', 'wJalrXUtnFEMI', 'EXAMPLE', 'vault-uploads', 'context']) assert(!JSON.stringify(rows).includes(raw), raw);
  assert.deepEqual(parseJsluiceSecrets(secretsOut, scripts), rows, 'the fingerprint is stable');
  assert.deepEqual(parseJsluiceSecrets('noise\n{"kind":"x","filename":"/work/.live/js/0000.js"}\n', scripts), []);
});

test('jsluice errors on stderr are found, and a failed image build has a reason', () => {
  assert.deepEqual(jsluiceErrors('error: open /work/.live/js/0001.js: no such file or directory\nother\n'), ['error: open /work/.live/js/0001.js: no such file or directory']);
  assert.deepEqual(jsluiceErrors(''), []);
  const fail = (cmd, args) => { throw new Error(args[0] === 'build' ? 'go: module lookup failed' : 'No such image'); };
  assert.match(ensureJsluice(fail), /^Could not build the image touchstone-jsluice:0ddfab1 from .*jsluice\/\. .*module lookup failed/);
});

test('real jsluice reads the lab JavaScript with no network', { skip: skipUnlessImages(JSLUICE), timeout: 700000 }, async () => {
  assert.equal(ensureJsluice(), null, 'the jsluice image is ready');
  const ws = mkdtempSync(join(tmpdir(), 'surface-jsluice-'));
  try {
    mkdirSync(join(ws, '.live', 'js'), { recursive: true });
    scripts.forEach((s, i) => writeFileSync(join(ws, jsluiceFile(i).replace('/work/', '')), s.body));
    const run = mode => runTool({ image: JSLUICE, ws, network: 'none', cmd: jsluiceArgs(mode, scripts.length), timeoutMs: 120000 });
    const urls = await run('urls');
    const secrets = await run('secrets');
    for (const r of [urls, secrets]) { assert.equal(r.code, 0, r.stderr); assert.deepEqual(jsluiceErrors(r.stderr), []); }
    if (process.env.RECORD_JSLUICE) { writeFileSync(fixture('jsluice-urls.jsonl'), urls.stdout); writeFileSync(fixture('jsluice-secrets.jsonl'), secrets.stdout); }
    assert.deepEqual(parseJsluiceUrls(urls.stdout, scripts, LAB, AT), parseJsluiceUrls(urlsOut, scripts, LAB, AT));
    assert.deepEqual(parseJsluiceSecrets(secrets.stdout, scripts), parseJsluiceSecrets(secretsOut, scripts));
    // A file it cannot read still exits 0. Only stderr says so.
    const bad = await runTool({ image: JSLUICE, ws, network: 'none', cmd: ['urls', '/work/.live/js/9999.js'], timeoutMs: 60000 });
    assert.equal(bad.code, 0);
    assert.equal(jsluiceErrors(bad.stderr).length, 1);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});
