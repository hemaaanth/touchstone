// Start and stop the offline lab: CoreDNS plus the web server on a Docker --internal network.
// The network has no route to the internet. Only the lab containers and tool containers join it.
//
// Each run gets its own small subnet from lib/lab-net.mjs, as the web lab does, so two
// runs at once never fail with "Pool overlaps". The files in lab/ (zone files,
// resolvers.txt, capture.mjs) name the canonical addresses in CANON. startLab mounts a
// per-run copy of lab/ with those addresses rewritten to the run's own.
//
// Cleanup: stop() removes the containers, the network and the copy. createLabNetwork
// tracks the network, so a SIGINT/SIGTERM (a test runner's kill on timeout) also removes
// the network and every container on it; this file's own handler removes the copy.
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLabNetwork, removeLabNetwork } from '../../lib/lab-net.mjs';
export const LAB = fileURLToPath(new URL('./lab', import.meta.url));
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000 });
// Async docker, the shape lib/lab-net.mjs expects. The Phishing lab uses it too.
export const labDocker = (args, { timeoutMs = 60000 } = {}) => new Promise(resolve => {
  execFile('docker', args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => resolve({
    code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut: Boolean(err?.killed),
  }));
});
// The addresses the files in lab/ name. A run's own addresses replace them in its copy.
export const CANON = { dns: '172.30.44.53', web: '172.30.44.20' };
const SERVICES = [
  ['dns', 'dns', 'coredns/coredns:1.12.0@sha256:40384aa1f5ea6bfdc77997d243aec73da05f27aed0c5e9d65bfa98933c519d97', ['-conf', '/lab/Corefile'], ['--cap-add', 'NET_BIND_SERVICE']],
  ['web', 'web', 'node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32', ['node', '/lab/server.mjs'], []],
];
// The lab's two addresses inside a subnet "a.b.c.d/n": .1 is Docker's gateway, so the
// DNS server takes base+3 and the web server base+4 (a /28 has 13 usable).
export function labAddresses(subnet) {
  const [ip] = String(subnet).split('/');
  const n = ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
  const at = k => { const v = (n + k) >>> 0; return [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.'); };
  return { dns: at(3), web: at(4) };
}
// Replace each address in `from` with the address under the same key in `to`. A
// longer address that only starts the same (172.30.44.200) is left alone.
export function swapAddresses(text, from, to) {
  let out = String(text);
  for (const k of Object.keys(from)) out = out.replace(new RegExp('(?<![\\d.])' + from[k].replaceAll('.', '\\.') + '(?![\\d])', 'g'), to[k]);
  return out;
}
// Canonical lab addresses -> this run's addresses, and back (to compare with a pin).
export const toRunAddresses = (text, ips) => swapAddresses(text, CANON, ips);
export const toCanonAddresses = (text, ips) => swapAddresses(text, ips, CANON);
// Rewrite every file under dir that names a canonical address.
export function rewriteLabDir(dir, ips, canon = CANON) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { rewriteLabDir(p, ips, canon); continue; }
    const text = readFileSync(p, 'utf8');
    if (Object.values(canon).some(a => text.includes(a))) writeFileSync(p, swapAddresses(text, canon, ips));
  }
}
// A lab network must really be --internal: no route to the internet. A name proves nothing, so ask Docker.
export function assertInternal(network) {
  let internal;
  try { internal = docker(['network', 'inspect', '--format', '{{.Internal}}', network]).trim(); }
  catch { throw new Error('Lab network ' + network + ' was not found'); }
  if (internal !== 'true') throw new Error('Lab network ' + network + ' is not --internal');
}
export const LAB_SCOPE = ['touchstone.test'];
// The per-run copies of lab/ this process made. On SIGINT/SIGTERM they are removed too
// (lab-net's handler removes the network and containers, not the copy). The process
// still dies by the signal: whichever of the two handlers runs last, with no other
// listener left, raises it again. A crash (the 'exit' event) removes them as well.
const copies = new Set();
const SIGNALS = ['SIGINT', 'SIGTERM'];
const removeCopies = () => { for (const c of copies) { try { rmSync(c, { recursive: true, force: true }); } catch {} } copies.clear(); };
function onSignal(sig) {
  removeCopies();
  for (const s of SIGNALS) process.removeListener(s, onSignal);
  process.removeListener('exit', removeCopies);
  if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
}
function trackCopy(dir) {
  if (copies.size === 0) { for (const s of SIGNALS) process.on(s, onSignal); process.on('exit', removeCopies); }
  copies.add(dir);
}
function untrackCopy(dir) {
  if (!copies.delete(dir) || copies.size) return;
  for (const s of SIGNALS) process.removeListener(s, onSignal);
  process.removeListener('exit', removeCopies);
}
// A per-run copy of a lab folder with its canonical addresses rewritten to this
// run's. It is removed by removeLabCopy, or on SIGINT/SIGTERM/exit.
export function makeLabCopy(lab, ips, canon = CANON, prefix = 'touchstone-domains-lab-') {
  const copy = mkdtempSync(join(tmpdir(), prefix));
  trackCopy(copy);
  cpSync(lab, copy, { recursive: true });
  rewriteLabDir(copy, ips, canon);
  return copy;
}
export function removeLabCopy(copy) {
  rmSync(copy, { recursive: true, force: true });
  untrackCopy(copy);
}
// Start the lab on its own --internal network with a free subnet. Resolves to
// { network, subnet, resolver, web, dir (the lab copy), granted, scope, stop }; stop() is async
// and safe to call twice.
export async function startLab(lab = LAB, { docker: run = labDocker } = {}) {
  const network = 'touchstone-domains-' + process.pid + '-' + randomBytes(3).toString('hex');
  const names = [];
  let created = false;
  let copy = null;
  const stop = async () => {
    for (const name of names.splice(0).reverse()) await run(['rm', '-f', name]);
    if (created) { created = false; await removeLabNetwork(network, { docker: run }); }
    if (copy) { removeLabCopy(copy); copy = null; }
  };
  try {
    const net = await createLabNetwork(network, ['--internal'], { docker: run });
    if (net.code !== 0) throw new Error('Lab network: ' + net.stderr);
    created = true;
    const ips = labAddresses(net.subnet);
    copy = makeLabCopy(lab, ips);
    for (const [suffix, role, image, cmd, caps] of SERVICES) {
      const name = network + '-' + suffix;
      const r = await run(['run', '-d', '--name', name, '--network', network, '--ip', ips[role], '--cap-drop', 'ALL', ...caps, '--security-opt', 'no-new-privileges', '--user', process.getuid() + ':' + process.getgid(), '-v', copy + ':/lab:ro', image, ...cmd]);
      names.push(name); // a failed run can still leave a created container
      if (r.code !== 0) throw new Error('Lab ' + suffix + ' did not start: ' + r.stderr);
    }
    // The lab is ours, so its reach carries its own grant for the lab domain.
    return { network, subnet: net.subnet, resolver: ips.dns, web: ips.web, dir: copy, granted: true, scope: LAB_SCOPE, stop };
  } catch (error) { await stop(); throw error; }
}
