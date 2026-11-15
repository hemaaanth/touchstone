// Adapted from BB sandboxes desktop-host.ts. MIT; see LICENSE.bb.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, request } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { ViewerLease, viewerPage, viewerScript } from './desktop-viewer.mjs';
import { launchVoxl } from './voxl-process.mjs';

export const VIEW_TTL_MS = 15 * 60_000;
// A published container port is fixed, so a local session binds one. 0 keeps the
// Daytona behaviour (an ephemeral port).
const VIEW_PORT = Number(process.env.TOUCHSTONE_DESKTOP_PORT || 0) || 0;
const publicFiles = new Set(['/client.js', '/worker.js', '/audio.js', '/mic.js', '/favicon.ico', '/inter.woff2']);
const systemClock = { now: Date.now, setTimeout, clearTimeout };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// A live capture runs locally, so its viewer is plain http on loopback. A Daytona
// preview is https. Anything else (a hostname over http) is refused: the token
// would travel in clear text on a network.
function origin(value) {
  if (typeof value !== 'string') throw Error('Invalid origin');
  const url = new URL(value);
  const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !loopback) || url.origin !== value || url.username || url.password) throw Error('Invalid origin');
  return value;
}
async function listen(server, host, port = 0) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server.address().port;
}
async function freePort() {
  const server = tcpServer();
  const port = await listen(server, '127.0.0.1');
  await new Promise(resolve => server.close(resolve));
  return port;
}
function secure(res, policy) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', policy);
}
async function healthy(port) {
  return new Promise(resolve => {
    const req = request({ host: '127.0.0.1', port, path: '/healthz', timeout: 200 }, res => {
      res.resume(); resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  let timer;
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => { timer = setTimeout(resolve, 1500); }),
  ]);
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

/** One configured port and one viewer lease per machine. No process discovery. */
export class DesktopRuntime {
  constructor({ spawnVoxl = launchVoxl, clock = systemClock, notices = '' } = {}) {
    this.spawnVoxl = spawnVoxl;
    this.clock = clock;
    this.notices = notices;
    this.session = null;
    this.queue = Promise.resolve();
  }
  command(input) {
    const job = this.queue.catch(() => {}).then(async () => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid desktop command');
      if (input.action === 'status') {
        if (this.session && this.clock.now() >= this.session.expires) await this.closeNow();
        return this.status();
      }
      if (input.action === 'close') { await this.closeNow(); return { kind: 'closed' }; }
      if (input.action === 'configure') return this.configure();
      if (input.action === 'open') return this.open(input);
      throw Error('Invalid desktop command');
    });
    this.queue = job;
    return job;
  }
  status() {
    const s = this.session;
    return s ? { kind: s.kind, port: s.port, expires: s.expires, ...(s.kind === 'open' ? { viewOnly: s.viewOnly } : {}) } : { kind: 'closed' };
  }
  async configure() {
    if (this.session) throw Error('Desktop already configured; close it first');
    const s = { kind: 'configured', expires: this.clock.now() + VIEW_TTL_MS, sockets: new Set(), lease: new ViewerLease(), token: null, child: null };
    s.server = createServer((req, res) => { void this.handle(s, req, res).catch(() => { if (!res.headersSent) res.writeHead(400); res.end(); }); });
    s.server.on('connection', socket => { s.sockets.add(socket); socket.once('close', () => s.sockets.delete(socket)); });
    s.server.on('upgrade', (req, socket, head) => this.upgrade(s, req, socket, head));
    try {
      // Daytona reaches the wrapper. Voxl itself never listens beyond loopback.
      // 0.0.0.0 even locally: a published port is forwarded to the container IP, so
    // a loopback-only listener would be unreachable. The host mapping keeps it
    // on 127.0.0.1.
    s.port = await listen(s.server, '0.0.0.0', VIEW_PORT || 0);
      this.session = s;
      s.timer = this.clock.setTimeout(() => this.retire(s), VIEW_TTL_MS);
      s.timer.unref?.();
      return this.status();
    } catch {
      s.server.close();
      throw Error('Desktop configuration failed');
    }
  }
  async open(input) {
    const s = this.session;
    if (!s || s.kind !== 'configured') throw Error('Configure desktop before opening');
    try {
      if (this.clock.now() >= s.expires) throw Error('Expired');
      s.previewOrigin = origin(input.previewOrigin);
      if (!Array.isArray(input.appOrigins) || input.appOrigins.length > 8) throw Error('Invalid parent origins');
      s.appOrigins = [...new Set(input.appOrigins.map(origin))];
      if (typeof input.viewOnly !== 'boolean' || typeof input.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.token)) throw Error('Invalid view');
      s.viewOnly = input.viewOnly;
      s.token = input.token;
      s.password = randomBytes(24).toString('base64url');
      s.voxlPort = await freePort();
      s.child = await this.spawnVoxl({ port: s.voxlPort, password: s.password, viewOnly: s.viewOnly, expires: s.expires });
      s.child.once('exit', () => this.retire(s));
      let ready = false;
      const readyUntil = Math.min(s.expires, this.clock.now() + 8000);
      for (let i = 0; i < 160 && !ready && this.clock.now() < readyUntil; i++) {
        if (s.child.exitCode !== null || s.child.signalCode !== null || this.clock.now() >= s.expires) throw Error('Voxl exited');
        ready = await healthy(s.voxlPort);
        if (!ready) await delay(50);
      }
      if (!ready || this.clock.now() >= s.expires) throw Error('Voxl unavailable');
      s.kind = 'open';
      return this.status();
    } catch {
      await this.closeNow();
      // Never echo request fields, URLs, child errors or tokens to the host.
      throw Error('Desktop open failed');
    }
  }
  valid(s, token) {
    const got = Buffer.from(token || ''), expected = Buffer.from(s.token || '');
    return this.session === s && s.kind === 'open' && this.clock.now() < s.expires && got.length === expected.length && timingSafeEqual(got, expected);
  }
  upstream(s, headers) {
    const out = { ...headers };
    for (const name of ['host', 'origin', 'referer', 'cookie', 'authorization']) delete out[name];
    return { ...out, host: '127.0.0.1:' + s.voxlPort, authorization: 'Bearer ' + s.password };
  }
  async handle(s, req, res) {
    const ancestors = "frame-ancestors 'self'" + (s.appOrigins || []).map(o => ' ' + o).join('');
    secure(res, "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; " + ancestors);
    if (s.kind !== 'open' || this.clock.now() >= s.expires) { res.writeHead(403); res.end('Session ended'); return; }
    const url = new URL(req.url || '/', 'http://desktop');
    if (req.method === 'GET' && url.pathname === '/licenses') { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end(this.notices); return; }
    if (req.method === 'GET' && url.pathname === '/bb-desktop-start.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(viewerScript(s.appOrigins)); return; }
    if (req.method === 'GET' && url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(viewerPage); return; }
    const token = url.searchParams.get('token') ?? req.headers.authorization?.replace(/^Bearer /, '');
    if (url.pathname === '/viewer-lease') {
      // Only the configured signed preview origin. Never reflect a client origin.
      if (req.method !== 'POST' || !this.valid(s, token) || req.headers.origin !== s.previewOrigin || req.headers['content-type'] !== 'application/json') { res.writeHead(403); res.end(); return; }
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2048) { res.writeHead(413); res.end(); return; }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['action', 'lease', 'takeover', 'ticket'].includes(key)) || typeof body.action !== 'string' || body.lease != null && (typeof body.lease !== 'string' || body.lease.length !== 43) || body.takeover !== undefined && typeof body.takeover !== 'boolean' || body.ticket !== undefined && (typeof body.ticket !== 'string' || body.ticket.length !== 43)) throw Error('Invalid lease');
      if (!this.valid(s, token)) { res.writeHead(403); res.end(); return; }
      let result;
      if (body.action === 'acquire') result = { lease: s.lease.acquire(body.takeover === true, body.ticket) };
      else if (body.action === 'status') result = { current: s.lease.owns(body.lease) };
      else if (body.action === 'transfer') result = { ticket: s.lease.transfer(body.lease, s.expires), expires: s.expires };
      else if (body.action === 'release') { s.lease.release(body.lease); result = { ok: true }; }
      else throw Error('Invalid lease');
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result)); return;
    }
    // Capture and other unused Voxl routes can outlive a viewer lease.
    if (req.method !== 'GET' || !(publicFiles.has(url.pathname) || url.pathname === '/view' && this.valid(s, token) && s.lease.owns(url.searchParams.get('lease')))) { res.writeHead(403); res.end('Session ended'); return; }
    if (url.pathname === '/view') url.pathname = '/';
    url.searchParams.delete('token'); url.searchParams.delete('lease');
    secure(res, ancestors);
    const forward = request({ host: '127.0.0.1', port: s.voxlPort, method: 'GET', path: url.pathname + url.search, headers: this.upstream(s, req.headers) }, reply => {
      const headers = { ...reply.headers };
      delete headers.connection; delete headers['keep-alive'];
      res.writeHead(reply.statusCode || 502, headers); reply.pipe(res);
    });
    forward.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.once('close', () => forward.destroy());
    forward.end();
  }
  upgrade(s, req, socket, head) {
    const deny = () => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    let url;
    try { url = new URL(req.url || '/', 'http://desktop'); } catch { deny(); return; }
    const secret = url.searchParams.get('lease');
    if (url.pathname !== '/ws' || !this.valid(s, url.searchParams.get('token')) || req.headers.origin !== s.previewOrigin || !s.lease.owns(secret)) { deny(); return; }
    let remote, forward;
    const end = () => { forward?.destroy(); socket.destroy(); if (remote) { remote.destroy(); s.sockets.delete(remote); } reservation?.done(); };
    const reservation = s.lease.reserve(secret, end);
    if (!reservation) { deny(); return; }
    url.searchParams.delete('token'); url.searchParams.delete('lease');
    socket.once('error', end); socket.once('close', end);
    forward = request({ host: '127.0.0.1', port: s.voxlPort, path: url.pathname + url.search, headers: this.upstream(s, req.headers), timeout: 5000 });
    forward.on('timeout', end);
    forward.once('upgrade', (reply, upstreamSocket, remoteHead) => {
      remote = upstreamSocket;
      if (!reservation.current() || socket.destroyed || !this.valid(s, s.token)) { end(); return; }
      s.sockets.add(remote); remote.once('error', end); remote.once('close', end);
      const lines = ['HTTP/1.1 101 Switching Protocols'];
      for (let i = 0; i < reply.rawHeaders.length; i += 2) lines.push(reply.rawHeaders[i] + ': ' + reply.rawHeaders[i + 1]);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      remote.pipe(socket).pipe(remote);
    });
    forward.once('response', reply => { reply.resume(); end(); });
    forward.once('error', end); forward.end();
  }
  retire(session) {
    const job = this.queue.catch(() => {}).then(async () => {
      if (this.session === session) await this.closeNow();
    });
    this.queue = job;
    void job.catch(() => {});
  }
  async closeNow() {
    const s = this.session;
    if (!s) return;
    this.session = null;
    s.kind = 'closed'; s.token = null; s.password = null;
    this.clock.clearTimeout(s.timer);
    s.lease.revoke();
    for (const socket of s.sockets) socket.destroy();
    s.server.closeAllConnections();
    await Promise.all([new Promise(resolve => s.server.close(resolve)), stop(s.child)]);
  }
}
