// The boundary test for the testssl.sh rebind stop (G1 repair M1).
//
// WHY. testssl.sh 3.2 runs its Winshock check by default. When the server's
// banner is Microsoft-HTTPAPI/2.0 it fetches http://<name>/ with curl, using the
// host NAME, not the address --ip pins. So a hostile granted host can answer a
// different (private) address the second time its name is looked up, and get a
// blind GET to port 80 there. captureTls closes this: it pins the name to the one
// checked address inside the container (--add-host), points the resolver at an
// address where nothing listens (--dns 127.0.0.1), and tells testssl to make no
// DNS lookup of its own (--nodns none). This test proves the boundary, not the argv.
//
// HOW. On an --internal Docker network (no route off it):
//   - a server at the CHECKED address answers HTTPS with the HTTPAPI banner;
//   - a logging listener at a SECOND address carries the host name as a Docker
//     network alias, so the name resolves to the listener on any real lookup.
// captureTls scans the name with the checked address. After the scan the listener
// has received nothing. The control run (the old argv, no pin) does reach the
// listener, so the attack is real and the listener logging works. Remove the pin
// from tls.mjs and the scan's own Winshock curl resolves the name through Docker
// DNS to the listener, so the listener is hit and this test fails.
//
// Honest skip: if docker, the testssl image, or node:20-slim is missing, the test
// skips with a reason rather than passing vacuously.
//
//   node --test spike/test/domains-tls-rebind.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docker, dockerReady } from '../lib/reach-confine.mjs';
import { createLabNetwork, removeLabNetwork } from '../lib/lab-net.mjs';
import { runTool } from '../lib/wrap.mjs';
import { captureTls, TESTSSL } from '../packs/domains/tls.mjs';

const LAB = join(dirname(fileURLToPath(import.meta.url)), '..', 'packs', 'domains', 'lab');
const NAME = 'www.touchstone.test';
const tag = randomBytes(4).toString('hex');
const net = `touchstone-tls-rebind-${tag}`;
const server = `touchstone-tls-rebind-server-${tag}`;
const listener = `touchstone-tls-rebind-listener-${tag}`;

// The server: HTTPS at the checked address, with the Windows banner the Winshock
// check keys on. The cipher set is one testssl reads a banner from.
const serverScript = `const https=require('https'),fs=require('fs');`
  + `https.createServer({cert:fs.readFileSync('/c/tls-cert.pem'),key:fs.readFileSync('/c/tls-key.pem'),`
  + `minVersion:'TLSv1.2',maxVersion:'TLSv1.2',ciphers:'ECDHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:AES128-SHA256',`
  + `ecdhCurve:'P-256',honorCipherOrder:true},`
  + `(q,r)=>{r.writeHead(200,{Server:'Microsoft-HTTPAPI/2.0','content-type':'text/html'});r.end('<html>hi</html>')})`
  + `.listen(443,'0.0.0.0',()=>console.error('up'))`;
// The listener: logs every request it receives on port 80.
const listenerScript = `require('http').createServer((q,r)=>{console.error('UNCHECKED-HIT '+q.method+' '+q.url);`
  + `r.writeHead(200,{Server:'x'});r.end('x')}).listen(80,'0.0.0.0',()=>console.error('up'))`;

let skip = false;
let serverIp = null;

async function ip(name) {
  const r = await docker(['inspect', '-f', `{{(index .NetworkSettings.Networks "${net}").IPAddress}}`, name]);
  return r.stdout.trim();
}
async function listenerHits() {
  const r = await docker(['logs', listener]);
  return r.stderr.split('\n').filter((l) => l.includes('UNCHECKED-HIT')).length;
}
async function cleanup() {
  for (const c of [server, listener]) await docker(['rm', '-f', c]);
  await removeLabNetwork(net, { docker });
}

before(async () => {
  const ready = await dockerReady();
  if (!ready.ok) { skip = ready.reason; return; }
  const img = await docker(['image', 'inspect', TESTSSL], { timeoutMs: 8000 });
  if (img.code !== 0) { skip = `${TESTSSL} image not present`; return; }
  const n = await createLabNetwork(net, ['--internal'], { docker });
  if (n.code !== 0) { skip = `lab network create failed: ${n.stderr.trim().slice(0, 200)}`; return; }
  const s = await docker(['run', '-d', '--name', server, '--network', net, '--memory', '128m',
    '-v', `${LAB}:/c:ro`, '--entrypoint', 'node', 'node:20-slim', '-e', serverScript]);
  if (s.code !== 0) { skip = `server start failed: ${s.stderr.trim().slice(0, 200)}`; await cleanup(); return; }
  // The listener carries the host name as a network alias: the name resolves here
  // on any lookup the fix does not stop.
  const l = await docker(['run', '-d', '--name', listener, '--network', net, '--network-alias', NAME,
    '--memory', '128m', '--entrypoint', 'node', 'node:20-slim', '-e', listenerScript]);
  if (l.code !== 0) { skip = `listener start failed: ${l.stderr.trim().slice(0, 200)}`; await cleanup(); return; }
  await new Promise((r) => setTimeout(r, 1500));
  serverIp = await ip(server);
  if (!serverIp) { skip = 'no server address'; await cleanup(); }
});

after(async () => { if (!skip) await cleanup(); });

test('captureTls keeps testssl.sh on the checked address; it never reaches the rebind address', { timeout: 400000 }, async (t) => {
  if (skip) { t.skip(skip); return; }
  // The real captureTls scans the name with the checked server address.
  const ws = mkdtempSync(join(tmpdir(), 'tls-rebind-ws-'));
  mkdirSync(join(ws, '.live'));
  try {
    const run = async (engine, opts) => runTool({ ws, network: net, ...opts });
    const result = await captureTls(run, ws, [{ origin: `https://${NAME}`, host: NAME, port: 443 }], () => serverIp);
    // The scan ran: a stored report, not a gap. So a pass is not vacuous.
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].error, undefined, result.entries[0].error);
    assert.match(String(result.entries[0].raw ?? ''), /^[0-9a-f]{64}$/);
    // The boundary: the rebind address received nothing.
    assert.equal(await listenerHits(), 0, 'the listener at the rebind address was contacted');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }

  // Control: the old argv, with no pin. The name resolves to the listener through
  // Docker DNS, so testssl's own Winshock curl reaches it. This proves the attack
  // is real and the listener logging works, so the assertion above is not vacuous.
  const old = await docker(['run', '--rm', '--pull=never', '--network', net, '--memory', '1g',
    '--entrypoint', 'testssl.sh', TESTSSL,
    '--jsonfile-pretty', '/tmp/o.json', '--severity', 'LOW', '--quiet', '--warnings', 'off',
    '--color', '0', '--connect-timeout', '10', '--openssl-timeout', '10', '--ip', serverIp, `${NAME}:443`],
    { timeoutMs: 300000 });
  assert.equal(old.timedOut, false, 'the control scan timed out');
  assert.ok(await listenerHits() >= 1, 'the control scan did not reach the listener, so the test proves nothing');
});
