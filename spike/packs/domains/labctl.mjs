// Start and stop the offline lab: CoreDNS plus the web server on a Docker --internal network.
// The network has no route to the internet. Only the lab containers and tool containers join it.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export const LAB = fileURLToPath(new URL('./lab', import.meta.url));
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000 });
const SERVICES = [
  ['dns', '172.30.44.53', 'coredns/coredns:1.12.0@sha256:40384aa1f5ea6bfdc77997d243aec73da05f27aed0c5e9d65bfa98933c519d97', ['-conf', '/lab/Corefile'], ['--cap-add', 'NET_BIND_SERVICE']],
  ['web', '172.30.44.20', 'node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32', ['node', '/lab/server.mjs'], []],
];
export function startLab(lab = LAB) {
  const network = 'touchstone-domains-' + process.pid;
  const names = [];
  let created = false;
  const stop = () => {
    for (const name of names.splice(0).reverse()) try { docker(['rm', '-f', name]); } catch {}
    if (created) { try { docker(['network', 'rm', network]); } catch {} created = false; }
  };
  try {
    docker(['network', 'create', '--internal', '--subnet', '172.30.44.0/24', network]); created = true;
    for (const [suffix, ip, image, cmd, caps] of SERVICES) {
      const name = network + '-' + suffix;
      docker(['run', '-d', '--name', name, '--network', network, '--ip', ip, '--cap-drop', 'ALL', ...caps, '--security-opt', 'no-new-privileges', '--user', process.getuid() + ':' + process.getgid(), '-v', lab + ':/lab:ro', image, ...cmd]); names.push(name);
    }
  } catch (error) { stop(); throw error; }
  return { network, resolver: '172.30.44.53', stop };
}
