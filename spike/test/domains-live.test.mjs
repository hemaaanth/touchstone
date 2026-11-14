import "./helpers/isolated-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLabNetwork, removeLabNetwork } from '../lib/lab-net.mjs';
// grant-store reads the console token when it loads (via live.mjs). Point it at test
// values first, so no real token, grant or scope file is read (1h review F4).
const tokenStore = mkdtempSync(join(tmpdir(), 'domains-live-store-'));
process.env.TOUCHSTONE_GRANT_TOKEN = 'test-token-not-real';
process.env.TOUCHSTONE_GRANTS_FILE = join(tokenStore, 'grants.json');
process.env.TOUCHSTONE_SCOPES_FILE = join(tokenStore, 'scopes.json');
process.on('exit', () => rmSync(tokenStore, { recursive: true, force: true }));
const { assertReach, captureDomain, dnsRows, httpRows, inScope, originOf, parseSubfinder, scriptUrls, synthZone } = await import('../packs/domains/live.mjs');

test('a real target needs a grant that covers the domain', () => {
  assert.throws(() => assertReach({ network: 'bridge' }, 'example.com'), /grant/);
  assert.throws(() => assertReach({ network: 'bridge', granted: true, scope: ['other.com'] }, 'example.com'), /grant/);
  assert.throws(() => assertReach(null, 'example.com'), /reach\.network/);
  assert.throws(() => assertReach({ network: 'bridge', granted: true, scope: ['example.com'] }, '-oX.example'), /Invalid domain/);
  // A live grant covers the exact name. Only a "*." entry covers a subdomain.
  assert.throws(() => assertReach({ network: 'bridge', granted: true, scope: ['example.com'] }, 'app.example.com'), /grant/);
  assert.deepEqual(assertReach({ network: 'bridge', granted: true, scope: ['*.example.com'] }, 'app.example.com'), ['*.example.com']);
  assert.deepEqual(assertReach({ network: 'bridge', granted: true, scope: ['example.com'] }, 'example.com'), ['example.com']);
});

test('a lab-looking network name is not a grant', () => {
  assert.throws(() => assertReach({ network: 'touchstone-domains-42' }, 'touchstone.test'), /grant/);
  assert.throws(() => assertReach({ network: 'touchstone-domains-42', granted: false, scope: ['touchstone.test'] }, 'touchstone.test'), /grant/);
  assert.throws(() => assertReach({ network: 'touchstone-domains-42', granted: true, scope: ['other.test'] }, 'touchstone.test'), /grant/);
});

test('a lab-named network must exist and really be --internal', async () => {
  const open = 'touchstone-domains-test-open-' + process.pid, shut = 'touchstone-domains-test-shut-' + process.pid;
  const reach = network => ({ network, granted: true, scope: ['touchstone.test'] });
  assert.throws(() => assertReach(reach('touchstone-domains-test-missing-' + process.pid), 'touchstone.test'), /not found/);
  try {
    for (const [name, args] of [[open, []], [shut, ['--internal']]]) {
      const r = await createLabNetwork(name, args);
      if (r.code !== 0) throw new Error(r.stderr);
    }
    assert.throws(() => assertReach(reach(open), 'touchstone.test'), /not --internal/);
    assert.deepEqual(assertReach(reach(shut), 'touchstone.test'), ['touchstone.test']);
  } finally {
    for (const name of [open, shut]) await removeLabNetwork(name);
  }
});

test('the capture refuses before any tool runs when there is no grant', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'live-guard-'));
  try { await assert.rejects(captureDomain({ ws, domain: 'example.com', reach: { network: 'bridge' } }), /grant/); }
  finally { rmSync(ws, { recursive: true, force: true }); }
});

test('scope covers a listed name and its subdomains only', () => {
  assert.equal(inScope('a.example.com', ['example.com']), true);
  assert.equal(inScope('example.com', ['example.com']), true);
  assert.equal(inScope('badexample.com', ['example.com']), false);
  assert.equal(inScope('example.com.evil.net', ['example.com']), false);
});

test('subfinder output keeps in-scope hosts once', () => {
  const out = ['{"host":"A.Example.com","source":["x"]}', '{"host":"a.example.com"}', '{"host":"evil.net"}', 'noise'].join('\n');
  assert.deepEqual(parseSubfinder(out, ['example.com']), ['a.example.com']);
});

test('dnsx rows become dns evidence with NXDOMAIN as ENOTFOUND', () => {
  const rows = dnsRows([{ host: 'old.example.com.', status_code: 'NOERROR', cname: ['gone.example.com.'] }, { host: 'gone.example.com', status_code: 'NXDOMAIN' }]);
  const find = (host, type) => rows.find(r => r.host === host && r.type === type);
  assert.deepEqual(find('old.example.com', 'CNAME'), { host: 'old.example.com', type: 'CNAME', status: 'NOERROR', answers: ['gone.example.com'] });
  assert.equal(find('old.example.com', 'A').status, 'ENODATA');
  assert.equal(find('gone.example.com', 'A').status, 'ENOTFOUND');
});

test('the zone has a CNAME or addresses, never both, and only in-scope names', () => {
  const zone = synthZone('example.com', dnsRows([{ host: 'example.com', status_code: 'NOERROR', a: ['1.2.3.4'] }, { host: 'docs.example.com', status_code: 'NOERROR', a: ['1.2.3.4'], cname: ['x.github.io'] }, { host: 'outside.net', status_code: 'NOERROR', a: ['9.9.9.9'] }]));
  assert.match(zone, /\$ORIGIN example\.com\./);
  assert.match(zone, /^@ IN A 1\.2\.3\.4$/m);
  assert.match(zone, /^docs IN CNAME x\.github\.io\.$/m);
  assert.doesNotMatch(zone, /^docs IN A/m);
  assert.doesNotMatch(zone, /9\.9\.9\.9/);
});

test('httpx rows keep headers, body and a stable url, and drop volatile headers', () => {
  const [row] = httpRows([{ url: 'http://a.example.com:8080', status_code: 200, raw_header: 'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nDate: now\r\nConnection: close\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n', body: '<html></html>' }]);
  assert.equal(row.url, 'http://a.example.com:8080/');
  assert.deepEqual(row.headers, { 'content-type': 'text/html', 'set-cookie': 'a=1, b=2' });
  assert.equal(row.body, '<html></html>');
});

test('script urls stay inside the grant and resolve relative paths', () => {
  const pages = [{ url: 'https://app.example.com/', headers: { 'content-type': 'text/html' }, body: '<script src="/a.js"></script><script src="https://cdn.example.com/b.js"></script><script src="https://evil.net/c.js"></script><script src="javascript:1"></script>' }, { url: 'https://app.example.com/x', headers: { 'content-type': 'text/plain' }, body: '<script src="/skip.js">' }];
  assert.deepEqual(scriptUrls(pages, ['example.com']).sort(), ['https://app.example.com/a.js', 'https://cdn.example.com/b.js']);
});

test('default ports leave the origin bare', () => {
  assert.equal(originOf('a.example.com', { scheme: 'https', port: 443 }), 'https://a.example.com');
  assert.equal(originOf('a.example.com', { scheme: 'http', port: 8080 }), 'http://a.example.com:8080');
});

test('the lab tools refuse a network Docker does not call --internal, whatever its name', async () => {
  const { captureTools } = await import('../packs/domains/tools.mjs');
  await assert.rejects(captureTools('/nonexistent', 'touchstone-domains-no-such-network'), /not found/);
});

test('script urls stay on the granted scheme and port pairs, not only the granted hosts', () => {
  const pages = [{ url: 'https://app.example.com/', headers: { 'content-type': 'text/html' }, body: '<script src="/a.js"></script><script src="https://app.example.com:8443/b.js"></script><script src="http://app.example.com/c.js"></script><script src="http://app.example.com:8080/d.js"></script>' }];
  // The default pairs: https 443 and http 80.
  assert.deepEqual(scriptUrls(pages, ['example.com']).sort(), ['http://app.example.com/c.js', 'https://app.example.com/a.js']);
  // A grant on https 8443 only.
  assert.deepEqual(scriptUrls(pages, ['example.com'], [{ scheme: 'https', port: 8443 }]), ['https://app.example.com:8443/b.js']);
});
