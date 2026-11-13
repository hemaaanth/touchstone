// The Domains lab gets its own subnet per run (L28). It used a fixed
// 172.30.44.0/24, so two runs at once failed with "Pool overlaps". Now startLab
// takes a free /28 from lib/lab-net.mjs (as the web lab does), gives its
// containers addresses inside it, and mounts a copy of lab/ whose zone files
// name those addresses. stop() removes the containers, the network and the
// copy; a SIGTERM (a runner's kill on timeout) removes the network and its
// containers through lab-net's handler.
//
// The first tests use a mock docker that, like Docker, refuses an overlapping
// subnet. The last two run real Docker and skip with a reason without it.
//
//   node --test spike/test/domains-lab-net.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CANON, labAddresses, startLab, toCanonAddresses, toRunAddresses } from '../packs/domains/labctl.mjs';

// A docker stand-in: records calls, refuses a subnet already in use, and keeps
// the mounted lab copy's zone file as it was when each container started.
function mockDocker({ failOn } = {}) {
  const calls = [];
  const subnets = new Map(); // network -> subnet
  const zones = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === 'network' && args[1] === 'create') {
      const subnet = args[args.indexOf('--subnet') + 1];
      if ([...subnets.values()].includes(subnet)) return { code: 1, stdout: '', stderr: 'Error response from daemon: Pool overlaps with other one on this address space' };
      subnets.set(args[args.length - 1], subnet);
      return { code: 0, stdout: 'id\n', stderr: '' };
    }
    if (args[0] === 'network' && args[1] === 'rm') { subnets.delete(args[2]); return { code: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'run') {
      const mount = args[args.indexOf('-v') + 1].split(':')[0];
      zones.push(readFileSync(`${mount}/zone.db`, 'utf8'));
      if (failOn && args.includes(failOn)) return { code: 125, stdout: '', stderr: 'boom' };
      return { code: 0, stdout: 'cid\n', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { run, calls, subnets, zones };
}

test('labAddresses puts DNS and web inside the subnet, past the gateway', () => {
  assert.deepEqual(labAddresses('10.208.3.16/28'), { dns: '10.208.3.19', web: '10.208.3.20' });
  const ips = labAddresses('10.208.3.16/28');
  assert.equal(toRunAddresses('ns IN A 172.30.44.53\nwww IN A 172.30.44.20\nx 172.30.44.200', ips), 'ns IN A 10.208.3.19\nwww IN A 10.208.3.20\nx 172.30.44.200');
  assert.equal(toCanonAddresses('a 10.208.3.20 b 10.208.3.19', ips), `a ${CANON.web} b ${CANON.dns}`);
});

test('startLab takes a free subnet, not the fixed one, and mounts zone files that name it', async () => {
  const d = mockDocker();
  const lab = await startLab(undefined, { docker: d.run });
  try {
    const create = d.calls.find((a) => a[0] === 'network' && a[1] === 'create');
    assert.ok(create.includes('--internal'));
    const subnet = create[create.indexOf('--subnet') + 1];
    assert.notEqual(subnet, '172.30.44.0/24');
    assert.match(subnet, /^10\.(2(0[89]|1\d|2[0-3]))\.\d+\.\d+\/28$/);
    assert.equal(lab.subnet, subnet);
    const ips = labAddresses(subnet);
    assert.equal(lab.resolver, ips.dns);
    assert.equal(lab.web, ips.web);
    const runs = d.calls.filter((a) => a[0] === 'run');
    assert.deepEqual(runs.map((a) => a[a.indexOf('--ip') + 1]), [ips.dns, ips.web]);
    // The containers read zone files that name this run's addresses only.
    for (const zone of d.zones) {
      assert.ok(zone.includes(`IN A ${ips.web}`), zone);
      assert.ok(!zone.includes('172.30.44.'), 'the copy still names the fixed subnet');
    }
  } finally { await lab.stop(); }
});

test('two labs at once both start, on different subnets (no "Pool overlaps")', async () => {
  const d = mockDocker();
  const [a, b] = await Promise.all([startLab(undefined, { docker: d.run }), startLab(undefined, { docker: d.run })]);
  try {
    assert.notEqual(a.network, b.network);
    assert.notEqual(a.subnet, b.subnet);
  } finally { await a.stop(); await b.stop(); }
});

test('stop() removes the containers, the network and the lab copy; twice is safe', async () => {
  const d = mockDocker();
  const lab = await startLab(undefined, { docker: d.run });
  const copy = d.calls.find((a) => a[0] === 'run').find((x) => x.endsWith(':/lab:ro')).split(':')[0];
  assert.ok(existsSync(copy));
  await lab.stop();
  await lab.stop();
  const rms = d.calls.filter((a) => a[0] === 'rm').map((a) => a.at(-1));
  assert.deepEqual(rms, [`${lab.network}-web`, `${lab.network}-dns`]);
  assert.equal(d.calls.filter((a) => a[0] === 'network' && a[1] === 'rm' && a[2] === lab.network).length, 1);
  assert.equal(existsSync(copy), false, 'the lab copy is removed');
});

test('a container that fails to start leaves nothing behind', async () => {
  const d = mockDocker({ failOn: 'node' }); // the web container's command
  await assert.rejects(startLab(undefined, { docker: d.run }), /did not start/);
  const network = d.calls.find((a) => a[0] === 'network' && a[1] === 'create').at(-1);
  const rms = d.calls.filter((a) => a[0] === 'rm').map((a) => a.at(-1));
  assert.deepEqual(rms, [`${network}-web`, `${network}-dns`]);
  assert.ok(d.calls.some((a) => a[0] === 'network' && a[1] === 'rm' && a[2] === network));
  assert.equal(d.subnets.size, 0);
});

// ---- real Docker

const IMAGES = [
  'coredns/coredns:1.12.0@sha256:40384aa1f5ea6bfdc77997d243aec73da05f27aed0c5e9d65bfa98933c519d97',
  'node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32',
];
const noDocker = (() => {
  try { for (const i of IMAGES) execFileSync('docker', ['image', 'inspect', i], { stdio: 'ignore' }); return false; }
  catch { return 'docker or a Domains lab image is missing on this host (never pulled by a test)'; }
})();
const sh = (args) => { try { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const gone = (network) => sh(['network', 'inspect', network]) === null
  && sh(['ps', '-aq', '--filter', `name=^${network}-`]) === '';

test('real Docker: two labs at once both run, each answers DNS with its own address, and stop() removes both', { skip: noDocker, timeout: 120_000 }, async () => {
  const [a, b] = await Promise.all([startLab(), startLab()]);
  try {
    assert.notEqual(a.subnet, b.subnet);
    for (const lab of [a, b]) {
      assert.equal(sh(['network', 'inspect', '--format', '{{.Internal}}', lab.network]), 'true');
      assert.equal(sh(['inspect', '--format', '{{.State.Running}}', `${lab.network}-dns`]), 'true');
      assert.equal(sh(['inspect', '--format', '{{.State.Running}}', `${lab.network}-web`]), 'true');
    }
    // Each lab's DNS answers www.touchstone.test with its own web address: the
    // copy's zone file was rewritten. A node container on the lab network asks.
    for (const lab of [a, b]) {
      const ask = `const r=new (require('dns').promises.Resolver)();r.setServers(['${lab.resolver}']);` +
        `r.resolve4('www.touchstone.test').then(a=>console.log(a.join(',')),e=>console.log('ERR '+e.code))`;
      const out = sh(['run', '--rm', '--pull=never', '--network', lab.network, '--entrypoint', 'node', IMAGES[1], '-e', ask]);
      assert.equal(out, lab.web, `lab ${lab.network}`);
    }
  } finally { await a.stop(); await b.stop(); }
  assert.ok(gone(a.network), `${a.network} left behind`);
  assert.ok(gone(b.network), `${b.network} left behind`);
});

test('real Docker: a process killed by SIGTERM (a runner timeout) leaves no lab network or container', { skip: noDocker, timeout: 120_000 }, async () => {
  const labctl = fileURLToPath(new URL('../packs/domains/labctl.mjs', import.meta.url));
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `const { startLab } = await import(${JSON.stringify(labctl)}); const lab = await startLab(); console.log(lab.network); setInterval(() => {}, 1000);`],
  { stdio: ['ignore', 'pipe', 'inherit'] });
  const network = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve(out.trim()); });
    child.on('exit', (code) => reject(new Error(`child exited ${code} before the lab started`)));
  });
  assert.ok(sh(['network', 'inspect', network]) !== null, 'the lab started');
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve(signal ?? code)));
  child.kill('SIGTERM');
  assert.equal(await exited, 'SIGTERM', 'the process still dies by the signal');
  assert.ok(gone(network), `${network} or its containers left behind`);
});
