// Fail-closed checklist for checkdmarc, testssl.sh and DNSViz, through the real
// captureDomain(). A PATH docker shim records every argv and answers with the
// recorded tool output in packs/domains/fixtures/. No container runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../lib/proof-evidence.mjs';
import { CHECKDMARC, emailLeads } from '../packs/domains/email.mjs';
import { TESTSSL, tlsLeads } from '../packs/domains/tls.mjs';
import { DNSVIZ } from '../packs/domains/dnssec.mjs';
// grant-store reads the console token when it loads (via live.mjs). Point it at test
// values first, so no real token, grant or scope file is read (1h review F4).
const tokenStore = mkdtempSync(join(tmpdir(), 'domains-tool-argv-store-'));
process.env.TOUCHSTONE_GRANT_TOKEN = 'test-token-not-real';
process.env.TOUCHSTONE_GRANTS_FILE = join(tokenStore, 'grants.json');
process.env.TOUCHSTONE_SCOPES_FILE = join(tokenStore, 'scopes.json');
process.on('exit', () => rmSync(tokenStore, { recursive: true, force: true }));
const { captureDomain } = await import('../packs/domains/live.mjs');
const FIXTURES = new URL('../packs/domains/fixtures/', import.meta.url).pathname;
const fixture = name => readFileSync(FIXTURES + name, 'utf8');
const root = 'example.com';
const NETWORK = 'touchstone-domains-shim';

// The shim: `image inspect` and `network inspect` succeed (the lab network
// reads as --internal); `run` answers by image. SHIM_HTTPS=0 finds no https
// page. SHIM_CHECKDMARC_EXIT sets checkdmarc's exit code; it still prints JSON.
const SHIM = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SHIM_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'network') { process.stdout.write('true\\n'); process.exit(0); }
if (args[0] !== 'run') process.exit(0);
const fx = name => fs.readFileSync(${JSON.stringify(FIXTURES)} + name, 'utf8');
const ws = (args[args.indexOf('-v') + 1] || '').split(':/work')[0];
const out = flag => path.join(ws, args[args.indexOf(flag) + 1].replace(/^\\/work\\//, ''));
const image = args.find(a => a.includes('@sha256:')) || '';
const https = process.env.SHIM_HTTPS !== '0';
if (image.startsWith('letiemble/checkdmarc')) { process.stdout.write(fx('checkdmarc-example.com.json')); process.exit(Number(process.env.SHIM_CHECKDMARC_EXIT || 0)); }
if (image.startsWith('drwetter/testssl.sh')) fs.writeFileSync(out('--jsonfile-pretty'), fx('testssl-example.com.json'));
if (image.startsWith('dnsviz/dnsviz')) fs.writeFileSync(out('-o'), args.includes('grok') ? fx('dnsviz-example.com.json') : '{}');
if (https && image.startsWith('projectdiscovery/dnsx')) process.stdout.write(JSON.stringify({ host: 'example.com', a: ['192.0.2.1'], status_code: 'NOERROR' }) + '\\n');
if (https && image.startsWith('projectdiscovery/httpx')) process.stdout.write(JSON.stringify({ url: 'https://example.com', status_code: 200, raw_header: 'HTTP/1.1 200 OK\\r\\ncontent-type: text/plain\\r\\n', body: 'ok' }) + '\\n');
process.exit(0);
`;

async function capture(env) {
  const dir = mkdtempSync(join(tmpdir(), 'domains-argv-'));
  const ws = mkdtempSync(join(tmpdir(), 'domains-argv-ws-'));
  const log = join(dir, 'argv.jsonl');
  writeFileSync(join(dir, 'docker'), SHIM, { mode: 0o755 });
  writeFileSync(log, '');
  const saved = { ...process.env };
  Object.assign(process.env, { PATH: dir + ':' + process.env.PATH, SHIM_LOG: log, ...env });
  try {
    const snapshot = await captureDomain({ ws, domain: root, reach: { network: NETWORK, granted: true, scope: [root], ports: [{ scheme: 'https', port: 443 }] }, wordlist: [] });
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(a => a[0] === 'run');
    return { snapshot, calls };
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
}
const row = (snapshot, engine) => snapshot.discovery.coverage.find(c => c.engine === engine);
const callOf = (calls, image, word) => calls.filter(a => a.includes(image) && (!word || a.includes(word)));
const flag = (args, name) => args[args.indexOf(name) + 1];
// One run of the image: run --rm --pull=never, the exact pinned image, this network.
function pinned(calls, image, word, network) {
  const found = callOf(calls, image, word);
  assert.equal(found.length, 1, image + ' ' + (word ?? ''));
  assert.deepEqual(found[0].slice(0, 3), ['run', '--rm', '--pull=never']);
  assert.equal(flag(found[0], '--network'), network, image + ' ' + (word ?? '') + ' network');
  assert.match(image, /@sha256:[0-9a-f]{64}$/);
}


test('checkdmarc runs pinned on the granted network, and a non-zero exit is a gap', async () => {
  const { snapshot, calls } = await capture({ SHIM_HTTPS: '1' });
  pinned(calls, CHECKDMARC, null, NETWORK);
  assert.equal(row(snapshot, 'checkdmarc').status, 'ran');
  assert.equal(snapshot.email.output, fixture('checkdmarc-example.com.json'));
  assert.equal(snapshot.email.raw, sha256(snapshot.email.output));
  // checkdmarc printed valid JSON but exited 1. That is not a result.
  const failed = (await capture({ SHIM_HTTPS: '1', SHIM_CHECKDMARC_EXIT: '1' })).snapshot;
  assert.equal(row(failed, 'checkdmarc').status, 'unavailable');
  assert.equal(failed.email, undefined);
  assert.deepEqual(emailLeads(failed).map(l => l.check), ['email-auth-evidence-missing']);
  assert.match(emailLeads(failed)[0].description, /Exited with code 1/);
});

test('testssl.sh runs pinned on the granted network, and no https page is an unavailable row', async () => {
  const { snapshot, calls } = await capture({ SHIM_HTTPS: '1' });
  pinned(calls, TESTSSL, null, NETWORK);
  assert.equal(row(snapshot, 'testssl:example.com:443').status, 'ran');
  assert.equal(snapshot.tls[0].output, fixture('testssl-example.com.json'));
  assert.equal(snapshot.tls[0].raw, sha256(snapshot.tls[0].output));
  // Nothing was measured, so the row says so. A missing row would read as clean.
  const none = await capture({ SHIM_HTTPS: '0' });
  assert.equal(callOf(none.calls, TESTSSL).length, 0);
  const tls = row(none.snapshot, 'testssl');
  assert.equal(tls?.status, 'unavailable');
  assert.match(tls.reason, /no https endpoint/);
  assert.match(tlsLeads(none.snapshot)[0].description, /no https endpoint/);
});

test('DNSViz probe runs pinned on the granted network, and grok runs with no network', async () => {
  const { snapshot, calls } = await capture({ SHIM_HTTPS: '1' });
  pinned(calls, DNSVIZ, 'probe', NETWORK);
  pinned(calls, DNSVIZ, 'grok', 'none');
  for (const engine of ['dnsviz-probe', 'dnsviz-grok']) assert.equal(row(snapshot, engine).status, 'ran', engine);
  assert.equal(snapshot.dnssec.output, fixture('dnsviz-example.com.json'));
  assert.equal(snapshot.dnssec.raw, sha256(snapshot.dnssec.output));
});
