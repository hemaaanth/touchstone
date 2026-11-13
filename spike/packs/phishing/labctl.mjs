// Start and stop the phishing lab: one CoreDNS on a Docker --internal network.
// The network has no route out. Only the lab DNS and the dnstwist capture join it.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export const LAB = fileURLToPath(new URL('./lab', import.meta.url));
export const LAB_SCOPE = ['tidekeep.test'];
const COREDNS = 'coredns/coredns:1.12.0@sha256:40384aa1f5ea6bfdc77997d243aec73da05f27aed0c5e9d65bfa98933c519d97';
const SUBNET = '172.30.47.0/24';
const RESOLVER = '172.30.47.53';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000 });
export function startLab(lab = LAB) {
  const network = 'touchstone-phishing-' + process.pid;
  const dns = network + '-dns';
  let created = false, started = false;
  const stop = () => {
    if (started) { try { docker(['rm', '-f', dns]); } catch {} started = false; }
    if (created) { try { docker(['network', 'rm', network]); } catch {} created = false; }
  };
  try {
    docker(['network', 'create', '--internal', '--subnet', SUBNET, network]); created = true;
    docker(['run', '-d', '--pull=never', '--name', dns, '--network', network, '--ip', RESOLVER, '--cap-drop', 'ALL', '--cap-add', 'NET_BIND_SERVICE',
      '--security-opt', 'no-new-privileges', '--user', process.getuid() + ':' + process.getgid(), '-v', lab + ':/lab:ro', COREDNS, '-conf', '/lab/Corefile']); started = true;
  } catch (error) { stop(); throw error; }
  // The lab is ours, so its reach carries its own grant for the lab brand.
  return { network, resolver: RESOLVER, granted: true, scope: LAB_SCOPE, stop };
}
