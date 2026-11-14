import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer, request } from 'node:http';
import { DesktopRuntime, VIEW_TTL_MS } from '../roam/desktop/desktop-host.mjs';
import { ViewerLease } from '../roam/desktop/desktop-viewer.mjs';
import { guardVoxl } from '../roam/desktop/voxl-process.mjs';
import { control, launchDaemon } from '../roam/desktop/entry.mjs';
import { serveControl } from '../roam/desktop/daemon.mjs';

const token = 't'.repeat(43);
const previewOrigin = 'https://4567-signed.preview.example';
const openInput = { action: 'open', previewOrigin, appOrigins: ['https://console.example'], token, viewOnly: true };
function fakeClock() {
  let now = Date.now();
  const timers = [];
  return { timers, now: () => now, setTimeout(fn, ms) { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; }, clearTimeout(timer) { if (timer) timer.cleared = true; }, advance(ms) { now += ms; } };
}
function fakeChild() {
  const child = new EventEmitter();
  Object.assign(child, { exitCode: null, signalCode: null, signals: [], pid: 1234 });
  child.kill = signal => { child.signals.push(signal); queueMicrotask(() => { child.signalCode = signal; child.emit('exit', null, signal); }); return true; };
  return child;
}
async function fixture(t, { failSpawn = false, deadChild = false } = {}) {
  const peers = [], children = [], launches = [], received = [], upstreamSockets = new Set(), pending = [];
  const clock = fakeClock();
  let holdUpgrades = false;
  const upgrades = new EventEmitter();
  const runtime = new DesktopRuntime({ clock, notices: 'MIT licence fixture\nGPL-2 licence fixture', spawnVoxl: async input => {
    launches.push(input);
    if (failSpawn) throw Error('Do not leak ' + token + ' ' + previewOrigin);
    const child = fakeChild(); children.push(child);
    const peer = createServer((req, res) => {
      if (req.url !== '/healthz') received.push({ url: req.url, headers: req.headers });
      res.setHeader('Content-Type', 'text/html'); res.end(req.url === '/healthz' ? 'ok' : '<html>fake voxl</html>');
    });
    peer.on('connection', socket => { upstreamSockets.add(socket); socket.on('close', () => upstreamSockets.delete(socket)); });
    peer.on('upgrade', (req, socket) => {
      received.push({ url: req.url, headers: req.headers });
      const complete = () => {
        if (socket.destroyed) return;
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        socket.on('data', bytes => socket.write(bytes));
      };
      if (holdUpgrades) pending.push(complete); else complete();
      upgrades.emit('seen');
    });
    await new Promise(resolve => peer.listen(input.port, '127.0.0.1', resolve));
    peers.push(peer);
    child.on('exit', () => { for (const socket of upstreamSockets) socket.destroy(); peer.close(); });
    if (deadChild) child.exitCode = 1;
    return child;
  } });
  t.after(async () => {
    await runtime.command({ action: 'close' });
    for (const socket of upstreamSockets) socket.destroy();
    await Promise.all(peers.map(peer => new Promise(resolve => peer.close(resolve))));
  });
  return { runtime, clock, children, launches, received, pending, upgrades, hold() { holdUpgrades = true; } };
}
function http(port, path = '/', { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers, agent: false }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject); req.end(body);
  });
}
async function lease(port, action = 'acquire', extra = {}, origin = previewOrigin) {
  const result = await http(port, '/viewer-lease', { method: 'POST', headers: { Origin: origin, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...extra }) });
  return { ...result, data: result.text ? JSON.parse(result.text) : null };
}
function upgrade(port, secret, origin = previewOrigin) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/ws?token=' + token + '&lease=' + secret, headers: { Connection: 'Upgrade', Upgrade: 'websocket', Origin: origin, Cookie: 'must-not-forward', Authorization: 'Bearer external' }, agent: false });
    req.on('upgrade', (res, socket) => { socket.on('error', () => {}); resolve({ status: res.statusCode, socket }); });
    req.on('response', res => { res.resume(); resolve({ status: res.statusCode }); });
    req.on('error', reject); req.end();
  });
}
async function open(t, options) {
  const f = await fixture(t, options);
  const configured = await f.runtime.command({ action: 'configure' });
  const opened = await f.runtime.command(openInput);
  return { ...f, configured, opened, port: opened.port };
}

test('two-step configure blocks preview access; open fixes the original expiry and status has no secrets', async t => {
  const f = await fixture(t);
  const configured = await f.runtime.command({ action: 'configure' });
  assert.equal(configured.kind, 'configured');
  assert.equal(configured.expires, f.clock.now() + VIEW_TTL_MS);
  assert.equal(f.runtime.session.server.address().address, '0.0.0.0');
  assert.equal((await http(configured.port)).status, 403);
  assert.equal(f.launches.length, 0);
  await assert.rejects(f.runtime.command({ action: 'configure' }), /already configured/);
  f.clock.advance(10_000);
  const opened = await f.runtime.command(openInput);
  assert.deepEqual(opened, { kind: 'open', port: configured.port, expires: configured.expires, viewOnly: true });
  assert.deepEqual(await f.runtime.command({ action: 'status' }), opened);
  assert.equal(JSON.stringify(opened).includes(token), false);
  assert.equal(JSON.stringify(opened).includes(previewOrigin), false);
  await assert.rejects(f.runtime.command(openInput), /Configure/);
  assert.equal((await http(opened.port, '/licenses')).text, 'MIT licence fixture\nGPL-2 licence fixture');
  assert.match((await http(opened.port)).headers['content-security-policy'], /frame-ancestors 'self' https:\/\/console.example/);
});

test('lease and stream accept only the exact signed origin; one viewer and one socket at a time', async t => {
  const f = await open(t);
  for (const origin of ['https://evil.example', 'https://other.preview.example', 'http://localhost:' + f.port, 'null', '']) {
    assert.equal((await lease(f.port, 'acquire', {}, origin)).status, 403);
  }
  const first = await lease(f.port);
  assert.match(first.data.lease, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await lease(f.port)).data.lease, null);
  assert.equal((await upgrade(f.port, first.data.lease, 'https://evil.example')).status, 403);
  const stream = await upgrade(f.port, first.data.lease);
  assert.equal(stream.status, 101);
  assert.equal((await upgrade(f.port, first.data.lease)).status, 403);
  const data = once(stream.socket, 'data'); stream.socket.write('fake-stream-bytes');
  assert.equal((await data)[0].toString(), 'fake-stream-bytes');
  const upstream = f.received.at(-1);
  assert.equal(upstream.url, '/ws');
  assert.equal(upstream.headers.origin, undefined);
  assert.equal(upstream.headers.cookie, undefined);
  assert.equal(upstream.headers.authorization, 'Bearer ' + f.launches[0].password);
  const closed = once(stream.socket, 'close');
  const replacement = await lease(f.port, 'acquire', { takeover: true });
  assert.notEqual(replacement.data.lease, first.data.lease);
  await closed;
  assert.equal((await upgrade(f.port, first.data.lease)).status, 403);
});

test('proxy strips capabilities and denies file transfer and writes in both modes', async t => {
  for (const viewOnly of [true, false]) {
    const f = await fixture(t);
    const configured = await f.runtime.command({ action: 'configure' });
    await f.runtime.command({ ...openInput, viewOnly });
    const secret = (await lease(configured.port)).data.lease;
    const query = '?token=' + token + '&lease=' + secret;
    assert.equal((await http(configured.port, '/view' + query, { headers: { Cookie: 'secret-cookie', Referer: previewOrigin + '/#' + token, Origin: previewOrigin } })).status, 200);
    const forwarded = f.received.at(-1);
    assert.equal(forwarded.url, '/');
    for (const name of ['cookie', 'referer', 'origin']) assert.equal(forwarded.headers[name], undefined);
    assert.equal(forwarded.headers.authorization, 'Bearer ' + f.launches[0].password);
    assert.equal((await http(configured.port, '/files/download' + query)).status, 403);
    assert.equal((await http(configured.port, '/upload' + query, { method: 'POST' })).status, 403);
    assert.equal((await http(configured.port, '/view?token=wrong&lease=' + secret)).status, 403);
    await f.runtime.command({ action: 'close' });
  }
});

test('close revokes active sockets, stops child, closes port, and permits a fresh session', async t => {
  const f = await open(t);
  const secret = (await lease(f.port)).data.lease;
  const stream = await upgrade(f.port, secret);
  const closed = once(stream.socket, 'close');
  assert.deepEqual(await f.runtime.command({ action: 'close' }), { kind: 'closed' });
  await closed;
  assert.deepEqual(f.children[0].signals, ['SIGTERM']);
  await assert.rejects(http(f.port), { code: 'ECONNREFUSED' });
  assert.deepEqual(await f.runtime.command({ action: 'status' }), { kind: 'closed' });
  const configured = await f.runtime.command({ action: 'configure' });
  const reopened = await f.runtime.command({ ...openInput, token: 'n'.repeat(43), viewOnly: false });
  assert.equal(reopened.port, configured.port);
  assert.equal(reopened.viewOnly, false);
  assert.equal((await lease(reopened.port)).status, 403);
});

test('expiry revokes stream without a host close request', async t => {
  const f = await open(t);
  const secret = (await lease(f.port)).data.lease;
  const stream = await upgrade(f.port, secret), closed = once(stream.socket, 'close');
  f.clock.advance(VIEW_TTL_MS);
  f.clock.timers[0].fn();
  assert.deepEqual(await f.runtime.command({ action: 'status' }), { kind: 'closed' });
  await closed;
  assert.deepEqual(f.children[0].signals, ['SIGTERM']);
  await assert.rejects(http(f.port), { code: 'ECONNREFUSED' });
});

test('failed open cleans up configured port and redacts child failure; cold runtime has no restored metadata', async t => {
  for (const options of [{ failSpawn: true }, { deadChild: true }]) {
    const f = await fixture(t, options);
    const configured = await f.runtime.command({ action: 'configure' });
    await assert.rejects(f.runtime.command(openInput), { message: 'Desktop open failed' });
    assert.deepEqual(await f.runtime.command({ action: 'status' }), { kind: 'closed' });
    await assert.rejects(http(configured.port), { code: 'ECONNREFUSED' });
    assert.deepEqual(await new DesktopRuntime().command({ action: 'status' }), { kind: 'closed' });
  }
});

test('invalid origins, token and mode fail closed before spawning Voxl', async t => {
  const f = await fixture(t);
  for (const patch of [{ previewOrigin: 'https://signed.example/path' }, { previewOrigin: 'https://user:pass@signed.example' }, { previewOrigin: 'http://signed.example' }, { appOrigins: ['https://console.example/'] }, { token: 'bad' }, { viewOnly: 'false' }]) {
    const configured = await f.runtime.command({ action: 'configure' });
    await assert.rejects(f.runtime.command({ ...openInput, ...patch }), { message: 'Desktop open failed' });
    assert.deepEqual(await f.runtime.command({ action: 'status' }), { kind: 'closed' });
    await assert.rejects(http(configured.port), { code: 'ECONNREFUSED' });
  }
  assert.equal(f.launches.length, 0);
});

test('late cleanup of an old session cannot close a newly configured port', async t => {
  const f = await open(t), old = f.runtime.session;
  const closing = f.runtime.command({ action: 'close' });
  const configuring = f.runtime.command({ action: 'configure' });
  f.runtime.retire(old);
  await closing;
  const next = await configuring;
  assert.deepEqual(await f.runtime.command({ action: 'status' }), next);
  assert.equal((await http(next.port)).status, 403);
});

test('lease transfer cancels a pending upstream upgrade and cannot resurrect its socket', async t => {
  const f = await open(t); f.hold();
  const secret = (await lease(f.port)).data.lease;
  // A pending TCP upgrade occupies the lease before the fake upstream replies.
  const seen = once(f.upgrades, 'seen');
  const attempted = upgrade(f.port, secret).catch(error => ({ error }));
  await seen;
  const replacement = await lease(f.port, 'acquire', { takeover: true });
  f.pending[0]();
  const retired = await attempted;
  assert.ok(retired.error);
  assert.equal((await lease(f.port, 'status', { lease: replacement.data.lease })).data.current, true);
});

test('Voxl guardian uses read-only and no clipboard in watch, keeps password out of argv, and kills on daemon loss', () => {
  for (const viewOnly of [true, false]) {
    const parent = new EventEmitter(), child = fakeChild(), clock = fakeClock();
    parent.connected = true; parent.send = () => {}; parent.exit = () => {};
    let launch;
    guardVoxl({ port: 4000, password: 'private-password', viewOnly, expires: clock.now() + VIEW_TTL_MS }, { parent, clock, spawn(binary, args, options) { launch = { binary, args, options }; return child; } });
    assert.equal(launch.binary, '/usr/local/bin/voxl');
    assert.ok(launch.args.includes('--addr=127.0.0.1'));
    assert.equal(launch.args.includes('--read-only=true'), viewOnly);
    assert.ok(launch.args.includes('--enable-clipboard=' + (viewOnly ? 'false' : 'in')));
    for (const flag of ['--file-transfers=none', '--microphone-enabled=false', '--audio-enabled=false', '--enable-resize=false']) assert.ok(launch.args.includes(flag));
    assert.equal(launch.args.join(' ').includes('private-password'), false);
    assert.deepEqual(launch.options.env, { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root', DISPLAY: ':99', VOXL_PASSWORD: 'private-password' });
    parent.emit('disconnect');
    assert.deepEqual(child.signals, ['SIGTERM']);
  }
});

test('guardian expiry survives a stalled daemon and escalates to SIGKILL', () => {
  const parent = new EventEmitter(), child = fakeChild(), clock = fakeClock();
  parent.connected = true; parent.send = () => {}; parent.exit = () => {};
  child.kill = signal => { child.signals.push(signal); return true; };
  guardVoxl({ port: 4000, password: 'private-password', viewOnly: true, expires: clock.now() + VIEW_TTL_MS }, { parent, clock, spawn: () => child });
  assert.equal(clock.timers[0].ms, VIEW_TTL_MS);
  clock.timers[0].fn();
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(clock.timers[1].ms, 1000);
  clock.timers[1].fn();
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
});

test('detached daemon launch has ignored stdio, lifetime flock and no request in argv', async () => {
  const previous = process.env.TOUCHSTONE_ROAM_RUNTIME;
  process.env.TOUCHSTONE_ROAM_RUNTIME = '1';
  try {
    let launch, unref = false;
    await launchDaemon({ makeDirectory: async () => {}, spawnProcess(binary, args, options) {
      launch = { binary, args, options };
      const child = fakeChild(); child.unref = () => { unref = true; };
      queueMicrotask(() => child.emit('spawn')); return child;
    } });
    assert.equal(launch.binary, 'flock');
    assert.ok(launch.args.includes('/run/touchstone/desktop.lock'));
    assert.ok(launch.args.at(-1).endsWith('/desktop/daemon.mjs'));
    assert.equal(launch.options.detached, true);
    assert.equal(launch.options.stdio, 'ignore');
    assert.equal(launch.args.join(' ').includes(token), false);
    assert.equal(unref, true);
  } finally { if (previous === undefined) delete process.env.TOUCHSTONE_ROAM_RUNTIME; else process.env.TOUCHSTONE_ROAM_RUNTIME = previous; }
});

test('client cold start retries only missing/refused socket; control rejects oversized or malformed requests without echoes', async () => {
  let calls = 0, launched = 0;
  const result = await control({ action: 'status' }, { request: async () => { if (calls++ === 0) throw Object.assign(Error('missing'), { code: 'ENOENT' }); return { kind: 'closed' }; }, launch: async () => { launched++; } });
  assert.deepEqual(result, { kind: 'closed' }); assert.equal(launched, 1);
  await assert.rejects(control(openInput, { request: async () => { throw Object.assign(Error(token), { code: 'EACCES' }); }, launch: () => assert.fail('must not launch') }), { message: 'Desktop control unavailable' });
  for (const bytes of ['invalid-' + token + '\n', 'x'.repeat(8193) + token + '\n', JSON.stringify(openInput) + '\n']) {
    const socket = new EventEmitter(); let output;
    socket.setTimeout = () => {}; socket.end = text => { output = text; };
    serveControl(socket, { command: async () => { throw Error('child leaked ' + token); } });
    socket.emit('data', Buffer.from(bytes));
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(output); assert.equal(output.includes(token), false); assert.equal(output.includes(previewOrigin), false);
  }
});

test('one-use transfer ticket revokes the old lease and pending socket', () => {
  const lease = new ViewerLease();
  const first = lease.acquire(); let cancelled = 0;
  const reservation = lease.reserve(first, () => { cancelled++; });
  const ticket = lease.transfer(first);
  const second = lease.acquire(false, ticket);
  assert.equal(cancelled, 1); assert.equal(reservation.current(), false);
  assert.equal(lease.owns(first), false); assert.equal(lease.owns(second), true);
  assert.equal(lease.acquire(false, ticket), null);
});
