import { createServer } from 'node:net';
import { chmod, lstat, mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DesktopRuntime } from './desktop-host.mjs';

export const SOCKET_PATH = '/run/touchstone/desktop.sock';
export function serveControl(socket, runtime) {
  let text = '', handled = false;
  socket.setTimeout(25_000, () => socket.destroy());
  socket.on('error', () => {});
  socket.on('data', chunk => {
    if (handled) return;
    text += chunk.toString('utf8');
    if (Buffer.byteLength(text) > 8192) { handled = true; socket.end('{"error":"Invalid desktop command"}\n'); return; }
    if (!text.includes('\n')) return;
    handled = true;
    let input;
    try { input = JSON.parse(text.trim()); } catch { socket.end('{"error":"Invalid desktop command"}\n'); return; }
    void runtime.command(input).then(result => socket.end(JSON.stringify(result) + '\n'), () => socket.end('{"error":"Desktop command failed"}\n'));
  });
}

async function notices() {
  const parts = await Promise.all(['LICENSE.bb', 'THIRD-PARTY-NOTICES'].map(name => readFile(new URL(name, import.meta.url), 'utf8')));
  for (const name of ['voxl', 'libx264-164', 'libyuv0', 'libopus0', 'libpulse0', 'nodejs', 'xvfb', 'openbox']) {
    const base = '/usr/share/doc/' + name;
    for (const file of await readdir(base).catch(() => [])) {
      if (file === 'copyright' || file === 'LICENSE' || file === 'Cargo.lock') parts.push(name + '/' + file + '\n' + await readFile(base + '/' + file, 'utf8'));
    }
  }
  parts.push(await readFile(new URL('../node_modules/playwright/LICENSE', import.meta.url), 'utf8'));
  parts.push(await readFile('/usr/share/common-licenses/GPL-2', 'utf8'));
  return parts.join('\n\n');
}

export async function startDaemon() {
  if (process.env.TOUCHSTONE_ROAM_RUNTIME !== '1') throw Error('Remote runtime only');
  process.umask(0o077);
  await mkdir('/run/touchstone', { recursive: true, mode: 0o700 });
  await chmod('/run/touchstone', 0o700);
  // entry.mjs holds flock for this daemon's lifetime, so only a stale socket is removed.
  const old = await lstat(SOCKET_PATH).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (old) {
    if (!old.isSocket() || old.uid !== process.getuid()) throw Error('Invalid control socket');
    await unlink(SOCKET_PATH);
  }
  const runtime = new DesktopRuntime({ notices: await notices() });
  const server = createServer(socket => serveControl(socket, runtime));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(SOCKET_PATH, resolve); });
  await chmod(SOCKET_PATH, 0o600);
  let stopping = false;
  const close = async () => {
    if (stopping) return;
    stopping = true;
    await runtime.command({ action: 'close' });
    server.close(() => process.exit(0));
  };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  return { runtime, server };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startDaemon().catch(() => process.exit(1));
}
