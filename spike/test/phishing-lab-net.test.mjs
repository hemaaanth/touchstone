// The Phishing lab gets its own subnet per run (review m4, as L28 did for the
// Domains lab). It used a fixed 172.30.47.0/24, so two runs at once failed with
// "Pool overlaps". Now startLab takes a free /28 from lib/lab-net.mjs, puts its
// CoreDNS at an address inside it, and mounts a copy of lab/ whose zone file
// names that address. stop() removes the container, the network and the copy.
//
// The first tests use a mock docker that, like Docker, refuses an overlapping
// subnet. The last one runs real Docker and skips with a reason without it.
//
//   node --test spike/test/phishing-lab-net.test.mjs
import "./helpers/isolated-env.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { labAddresses } from '../packs/domains/labctl.mjs';
import { CANON, LAB, startLab, toCanonSnapshot } from '../packs/phishing/labctl.mjs';

function mockDocker({ fail = false } = {}) {
  const calls = [];
  const subnets = new Map();
  const zones = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === 'network' && args[1] === 'create') {
      const subnet = args[args.indexOf('--subnet') + 1];
      if ([...subnets.values()].includes(subnet)) return { code: 1, stdout: '', stderr: 'Error response from daemon: Pool overlaps with other one on this address space' };
      subnets.set(args.at(-1), subnet);
      return { code: 0, stdout: 'id\n', stderr: '' };
    }
    if (args[0] === 'network' && args[1] === 'rm') { subnets.delete(args[2]); return { code: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'run') {
      zones.push(readFileSync(`${args[args.indexOf('-v') + 1].split(':')[0]}/test.db`, 'utf8'));
      return fail ? { code: 125, stdout: '', stderr: 'boom' } : { code: 0, stdout: 'cid\n', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { run, calls, subnets, zones };
}

test('startLab takes a free subnet, not the fixed one, and its zone names the run resolver', async () => {
  const d = mockDocker();
  const lab = await startLab(undefined, { docker: d.run });
  try {
    assert.notEqual(lab.subnet, '172.30.47.0/24');
    assert.match(lab.subnet, /\/28$/);
    assert.equal(lab.resolver, labAddresses(lab.subnet).dns);
    const run = d.calls.find((a) => a[0] === 'run');
    assert.equal(run[run.indexOf('--ip') + 1], lab.resolver);
    assert.ok(d.zones[0].includes(`ns IN A ${lab.resolver}`), d.zones[0]);
    assert.ok(!d.zones[0].includes(CANON.dns), 'the copy still names the fixed address');
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

test('stop() and a failed start leave no container, network or copy', async () => {
  const d = mockDocker();
  const lab = await startLab(undefined, { docker: d.run });
  await lab.stop();
  await lab.stop();
  assert.deepEqual(d.calls.filter((a) => a[0] === 'rm').map((a) => a.at(-1)), [`${lab.network}-dns`]);
  assert.equal(d.subnets.size, 0);
  assert.equal(existsSync(lab.dir), false);

  const f = mockDocker({ fail: true });
  await assert.rejects(startLab(undefined, { docker: f.run }), /did not start/);
  const network = f.calls.find((a) => a[0] === 'network' && a[1] === 'create').at(-1);
  assert.deepEqual(f.calls.filter((a) => a[0] === 'rm').map((a) => a.at(-1)), [`${network}-dns`]);
  assert.equal(f.subnets.size, 0);
});

// The operator capture pins the canonical resolver, not the run's own (review of
// m4): the stored dnstwist arguments must be the same on every run.
const PINNED = JSON.parse(readFileSync(join(LAB, 'snapshot.json'), 'utf8'));
const nameservers = (snap) => [snap.dnstwist.cmd, ...(snap.dnstwist.controls ?? []).map((c) => c.cmd)]
  .map((cmd) => cmd[cmd.indexOf('--nameservers') + 1]);

test('toCanonSnapshot stores the canonical resolver, the same for two runs on different subnets', () => {
  const asRun = (resolver) => JSON.parse(JSON.stringify(PINNED).replaceAll(CANON.dns, resolver));
  const [a, b] = [{ resolver: '10.208.3.19' }, { resolver: '10.219.77.35' }];
  const [sa, sb] = [toCanonSnapshot(asRun(a.resolver), a), toCanonSnapshot(asRun(b.resolver), b)];
  assert.deepEqual(sa.dnstwist.cmd, PINNED.dnstwist.cmd);
  assert.deepEqual(sa.dnstwist.cmd, sb.dnstwist.cmd);
  assert.equal(sa.dnstwist.resolver, CANON.dns);
  assert.ok(nameservers(sa).every((n) => n === CANON.dns), JSON.stringify(nameservers(sa)));
  assert.ok(!JSON.stringify(sa).includes(a.resolver), 'the run address is gone');
  // The address is matched whole: a longer address that starts the same stays.
  assert.equal(toCanonSnapshot({ x: '10.208.3.190' }, a).x, '10.208.3.190');
});

// ---- real Docker

const IMAGES = [
  'coredns/coredns:1.12.0@sha256:40384aa1f5ea6bfdc77997d243aec73da05f27aed0c5e9d65bfa98933c519d97',
  'node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32',
];
const noDocker = (() => {
  try { for (const i of IMAGES) execFileSync('docker', ['image', 'inspect', i], { stdio: 'ignore' }); return false; }
  catch { return 'docker or a lab image is missing on this host (never pulled by a test)'; }
})();
const sh = (args) => { try { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };

test('real Docker: two Phishing labs at once both run, each DNS answers with its own address, and stop() removes both', { skip: noDocker, timeout: 120_000 }, async () => {
  const [a, b] = await Promise.all([startLab(), startLab()]);
  try {
    assert.notEqual(a.subnet, b.subnet);
    for (const lab of [a, b]) {
      assert.equal(sh(['network', 'inspect', '--format', '{{.Internal}}', lab.network]), 'true');
      const ask = `const r=new (require('dns').promises.Resolver)();r.setServers(['${lab.resolver}']);` +
        `r.resolve4('ns.test').then(a=>console.log(a.join(',')),e=>console.log('ERR '+e.code))`;
      assert.equal(sh(['run', '--rm', '--pull=never', '--network', lab.network, '--entrypoint', 'node', IMAGES[1], '-e', ask]), lab.resolver, lab.network);
    }
  } finally { await a.stop(); await b.stop(); }
  for (const lab of [a, b]) {
    assert.equal(sh(['network', 'inspect', lab.network]), null, `${lab.network} left behind`);
    assert.equal(sh(['ps', '-aq', '--filter', `name=^${lab.network}-`]), '');
    assert.equal(existsSync(lab.dir), false);
  }
});

const hasDnstwist = sh(['image', 'inspect', 'touchstone-phishing-dnstwist:20250130']) !== null;
test('real Docker: two operator captures on two labs store the same --nameservers argument, the pinned one', { skip: (noDocker || (!hasDnstwist && 'dnstwist image not built')), timeout: 900_000 }, async () => {
  const { captureLookalikes } = await import('../packs/phishing/live.mjs');
  const cfg = JSON.parse(readFileSync(join(LAB, '.touchstone.json'), 'utf8'));
  const stored = [];
  for (let i = 0; i < 2; i++) {
    const ws = mkdtempSync(join(tmpdir(), 'phishing-capture-'));
    cpSync(LAB, ws, { recursive: true });
    const lab = await startLab();
    try {
      await new Promise((r) => setTimeout(r, 1500));
      const snap = await captureLookalikes({ ws, domain: cfg.domain, owned: cfg.owned, reach: lab, blocklists: cfg.blocklists, lab: true });
      assert.equal(snap.coverage[0].status, 'ran', snap.coverage[0].reason);
      assert.ok(nameservers(snap).every((n) => n === lab.resolver), 'the capture asked this run\'s own resolver');
      stored.push({ resolver: lab.resolver, snap: toCanonSnapshot(snap, lab) });
    } finally { await lab.stop(); rmSync(ws, { recursive: true, force: true }); }
  }
  assert.notEqual(stored[0].resolver, stored[1].resolver, 'the two runs had different resolvers');
  for (const { snap } of stored) {
    assert.deepEqual(snap.dnstwist.cmd, PINNED.dnstwist.cmd);
    assert.ok(nameservers(snap).every((n) => n === CANON.dns), JSON.stringify(nameservers(snap)));
    assert.equal(snap.dnstwist.resolver, CANON.dns);
  }
});
