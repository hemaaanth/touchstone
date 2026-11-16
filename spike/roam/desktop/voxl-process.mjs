// BB sandboxes Voxl flags adapted under MIT; see LICENSE.bb.
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VIEW_TTL_MS } from './desktop-host.mjs';

export function voxlArgs({ port, viewOnly }) {
  return ['--addr=127.0.0.1', '--port=' + port, '--title=Touchstone desktop',
    '--audio-enabled=false', '--microphone-enabled=false', '--file-transfers=none',
    '--enable-clipboard=' + (viewOnly ? 'false' : 'in'), '--enable-resize=false',
    ...(viewOnly ? ['--read-only=true'] : [])];
}

/** IPC disconnect kills Voxl even when the runtime daemon crashes. */
export function guardVoxl(input, { parent = process, spawn = nodeSpawn, clock = { now: Date.now, setTimeout, clearTimeout } } = {}) {
  let child, stopping = false, killTimer, expiry;
  const finish = () => { clock.clearTimeout(killTimer); clock.clearTimeout(expiry); parent.exit(0); };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (!child || child.exitCode !== null || child.signalCode !== null) { finish(); return; }
    child.kill('SIGTERM');
    killTimer = clock.setTimeout(() => { child.kill('SIGKILL'); }, 1000);
  };
  parent.once('disconnect', stop); parent.once('SIGTERM', stop); parent.once('SIGINT', stop);
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535 || typeof input.password !== 'string' || typeof input.viewOnly !== 'boolean' || !Number.isFinite(input.expires) || input.expires <= clock.now() || input.expires > clock.now() + VIEW_TTL_MS) { finish(); return; }
  child = spawn('/usr/local/bin/voxl', voxlArgs(input), { stdio: 'ignore', env: {
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root', DISPLAY: ':99', VOXL_PASSWORD: input.password,
  } });
  child.once('error', finish); child.once('exit', finish);
  child.once('spawn', () => { if (parent.connected) parent.send({ ready: true }); else stop(); });
  expiry = clock.setTimeout(stop, Math.max(0, input.expires - clock.now()));
  return { child, stop };
}

export async function launchVoxl(input) {
  const child = nodeSpawn(process.execPath, [fileURLToPath(import.meta.url), '--guardian'], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: '/usr/local/bin:/usr/bin:/bin', TOUCHSTONE_ROAM_RUNTIME: '1' },
  });
  await new Promise((resolve, reject) => {
    let timer;
    const done = error => {
      clearTimeout(timer); child.off('error', failed); child.off('exit', failed); child.off('message', ready);
      if (error) { child.kill('SIGTERM'); reject(Error('Voxl guardian failed')); } else resolve();
    };
    const failed = () => done(true);
    const ready = message => { if (message?.ready === true) done(false); };
    child.once('error', failed); child.once('exit', failed); child.on('message', ready);
    timer = setTimeout(failed, 5000);
    child.send(input, error => { if (error) failed(); });
  });
  return child;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--guardian') {
  if (process.env.TOUCHSTONE_ROAM_RUNTIME !== '1' || !process.connected) process.exit(1);
  const timer = setTimeout(() => process.exit(1), 5000);
  process.once('message', input => { clearTimeout(timer); guardVoxl(input); });
}
