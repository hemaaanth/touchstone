// Start and stop the phishing lab: one CoreDNS on a Docker --internal network.
// The network has no route out. Only the lab DNS and the dnstwist capture join it.
//
// Each run gets its own small subnet from lib/lab-net.mjs (as the Domains and web
// labs do), so two runs at once never fail with "Pool overlaps". The zone files in
// lab/ name the canonical resolver address in CANON; startLab mounts a per-run copy of
// lab/ with it rewritten to the run's own. stop() removes the container, the network
// and the copy; a SIGINT/SIGTERM removes them too (lab-net and the Domains labctl
// copy tracking).
import { fileURLToPath } from 'node:url';
import { createLabNetwork, removeLabNetwork } from '../../lib/lab-net.mjs';
import { labAddresses, labDocker, makeLabCopy, removeLabCopy } from '../domains/labctl.mjs';
import { randomBytes } from 'node:crypto';
export const LAB = fileURLToPath(new URL('./lab', import.meta.url));
export const LAB_SCOPE = ['tidekeep.test'];
const COREDNS = 'coredns/coredns:1.12.0@sha256:40384aa1f5ea6bfdc77997d243aec73da05f27aed0c5e9d65bfa98933c519d97';
// The address the files in lab/ name. A run's own address replaces it in its copy.
export const CANON = { dns: '172.30.47.53' };
// Start the lab on its own --internal network with a free subnet. Resolves to
// { network, subnet, resolver, dir (the lab copy), granted, scope, stop }; stop() is
// async and safe to call twice.
export async function startLab(lab = LAB, { docker: run = labDocker } = {}) {
  const network = 'touchstone-phishing-' + process.pid + '-' + randomBytes(3).toString('hex');
  const dns = network + '-dns';
  let created = false, started = false, copy = null;
  const stop = async () => {
    if (started) { started = false; await run(['rm', '-f', dns]); }
    if (created) { created = false; await removeLabNetwork(network, { docker: run }); }
    if (copy) { removeLabCopy(copy); copy = null; }
  };
  try {
    const net = await createLabNetwork(network, ['--internal'], { docker: run });
    if (net.code !== 0) throw new Error('Lab network: ' + net.stderr);
    created = true;
    const resolver = labAddresses(net.subnet).dns;
    copy = makeLabCopy(lab, { dns: resolver }, CANON, 'touchstone-phishing-lab-');
    started = true; // a failed run can still leave a created container
    const r = await run(['run', '-d', '--pull=never', '--name', dns, '--network', network, '--ip', resolver, '--cap-drop', 'ALL', '--cap-add', 'NET_BIND_SERVICE',
      '--security-opt', 'no-new-privileges', '--user', process.getuid() + ':' + process.getgid(), '-v', copy + ':/lab:ro', COREDNS, '-conf', '/lab/Corefile']);
    if (r.code !== 0) throw new Error('Lab dns did not start: ' + r.stderr);
    // The lab is ours, so its reach carries its own grant for the lab brand.
    return { network, subnet: net.subnet, resolver, dir: copy, granted: true, scope: LAB_SCOPE, stop };
  } catch (error) { await stop(); throw error; }
}
