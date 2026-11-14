#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SOCKET_PATH } from './daemon.mjs';

export function requestControl(input, socketPath = SOCKET_PATH) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let text = '';
    socket.setTimeout(25_000, () => { socket.destroy(); reject(Error('Desktop control timeout')); });
    socket.once('connect', () => socket.write(JSON.stringify(input) + '\n'));
    socket.on('data', chunk => {
      text += chunk.toString('utf8');
      if (text.length > 8192) { socket.destroy(); reject(Error('Invalid desktop response')); }
    });
    socket.once('error', reject);
    socket.once('end', () => { try { resolve(JSON.parse(text)); } catch { reject(Error('Invalid desktop response')); } });
  });
}

export async function control(input, { request = requestControl, launch = launchDaemon } = {}) {
  try { return await request(input); } catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw Error('Desktop control unavailable');
  }
  await launch();
  for (let i = 0; i < 100; i++) {
    try { return await request(input); } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw Error('Desktop control unavailable');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw Error('Desktop control unavailable');
}

export async function launchDaemon({ spawnProcess = spawn, makeDirectory = mkdir } = {}) {
  if (process.env.TOUCHSTONE_ROAM_RUNTIME !== '1') throw Error('Remote runtime only');
  await makeDirectory('/run/touchstone', { recursive: true, mode: 0o700 });
  const child = spawnProcess('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73', '/run/touchstone/desktop.lock', process.execPath, fileURLToPath(new URL('daemon.mjs', import.meta.url))], {
    detached: true, stdio: 'ignore', env: { PATH: '/usr/local/bin:/usr/bin:/bin', TOUCHSTONE_ROAM_RUNTIME: '1' },
  });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(Error('Desktop control unavailable'))); });
  child.unref();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.env.TOUCHSTONE_ROAM_RUNTIME !== '1') throw Error('Remote runtime only');
    let text = '';
    for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 8192) throw Error('Invalid command'); }
    const result = await control(JSON.parse(text));
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.error) process.exitCode = 1;
  } catch {
    process.stdout.write('{"error":"Desktop control unavailable"}\n'); process.exitCode = 1;
  }
}
