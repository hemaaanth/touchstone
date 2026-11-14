import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validReviewBytes } from './review-image.mjs';

async function within(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Review timeout')), ms); })]); }
  finally { clearTimeout(timer); }
}

/** The only page content is a verified PNG and its fixed-format hash. */
export async function renderBufferedImage({ png, sha256 }, { chromium, signal, storage = { mkdtemp, writeFile, rm } } = {}) {
  if (!validReviewBytes(png, sha256)) throw Error('Image review unavailable');
  let directory, server, closing;
  const abort = () => { void server?.kill().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  const close = () => closing ??= (async () => {
    try {
      if (server) {
        try { await within(server.close(), 3000); }
        catch { await within(server.kill(), 2000); }
      }
    } finally {
      if (directory) await storage.rm(directory, { recursive: true, force: true });
      signal?.removeEventListener('abort', abort);
    }
  })();
  try {
    signal?.throwIfAborted();
    chromium ??= (await import('playwright')).chromium;
    directory = await storage.mkdtemp('/run/touchstone/review-');
    const file = directory + '/image.html';
    const html = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><title>Touchstone screenshot review</title><style>html,body{margin:0;background:#111;color:#fff;font:16px monospace}body{display:flex;flex-direction:column;height:100vh}p{margin:12px;overflow-wrap:anywhere}img{min-height:0;flex:1;object-fit:contain;max-width:100%}</style><p>Exact screenshot · SHA-256 <span id="hash">' + sha256 + '</span> · ' + png.length + ' bytes</p><img alt="Exact screenshot under review" src="data:image/png;base64,' + png.toString('base64') + '">';
    await storage.writeFile(file, html, { mode: 0o600 });
    // A separate browser process owns a fresh Playwright profile. Never connect to I3.
    // Its random control endpoint is loopback-only; the page has no network access.
    server = await chromium.launchServer({ host: '127.0.0.1', headless: false, timeout: 5000,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root', DISPLAY: ':99', PLAYWRIGHT_BROWSERS_PATH: '/opt/playwright' },
      args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync', '--disable-extensions', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND', '--window-position=0,0', '--window-size=1920,1080'],
    });
    signal?.throwIfAborted();
    const browser = await chromium.connect(server.wsEndpoint(), { timeout: 3000 });
    const context = await browser.newContext({ viewport: null, offline: true, serviceWorkers: 'block', acceptDownloads: false, permissions: [] });
    const url = pathToFileURL(file).href;
    await context.route('**/*', route => route.request().url() === url ? route.continue() : route.abort());
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: 3000 });
    const decoded = await within(page.locator('img').evaluate(async image => { await image.decode(); return image.complete && image.naturalWidth > 0 && image.naturalHeight > 0; }), 5000);
    if (!decoded || await page.locator('#hash').textContent() !== sha256) throw Error('Image not shown');
    await page.bringToFront();
    await within(page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))), 2000);
    signal?.throwIfAborted();
    return { close };
  } catch {
    await close();
    throw Error('Image review unavailable');
  }
}

/** Daemon IPC transports verified bytes, never a source pathname or command argument. */
export async function launchImageReview(input, { signal, onExit } = {}) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker'], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced',
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', TOUCHSTONE_ROAM_RUNTIME: '1', PLAYWRIGHT_BROWSERS_PATH: '/opt/playwright' },
  });
  let closing;
  child.once('exit', () => { if (!closing) onExit?.(); });
  const close = () => closing ??= (async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await within(new Promise(resolve => child.once('exit', resolve)), 7000).catch(() => { child.kill('SIGKILL'); });
  })();
  const abort = () => { void close(); };
  signal?.addEventListener('abort', abort, { once: true });
  child.once('exit', () => signal?.removeEventListener('abort', abort));
  try {
    signal?.throwIfAborted();
    await new Promise((resolve, reject) => {
      let timer;
      const finish = error => {
        clearTimeout(timer); child.off('error', failed); child.off('exit', failed); child.off('message', message);
        if (error) reject(Error('Image review unavailable')); else resolve();
      };
      const failed = () => finish(true);
      const message = result => {
        if (result?.kind === 'shown' && result.sha256 === input.sha256 && result.bytes === input.png.length) finish(false);
        else finish(true);
      };
      child.once('error', failed); child.once('exit', failed); child.once('message', message);
      timer = setTimeout(failed, 18_000);
      child.send(input, error => { if (error) failed(); });
    });
    signal?.throwIfAborted();
    return { close };
  } catch {
    await close();
    throw Error('Image review unavailable');
  }
}

export function reviewWorker({ parent = process, render = renderBufferedImage, clock = { now: Date.now, setTimeout, clearTimeout } } = {}) {
  let renderer, loading, stopping = false, expiry;
  const controller = new AbortController();
  const stop = async () => {
    if (stopping) return;
    stopping = true; clock.clearTimeout(expiry);
    controller.abort();
    try { await loading; await renderer?.close(); } finally { parent.exit(0); }
  };
  parent.once('disconnect', stop); parent.once('SIGTERM', stop); parent.once('SIGINT', stop);
  expiry = clock.setTimeout(stop, 5000);
  parent.once('message', input => {
    clock.clearTimeout(expiry);
    if (!input || !Number.isFinite(input.expires) || input.expires <= clock.now() || input.expires > clock.now() + 15 * 60_000 || !validReviewBytes(input.png, input.sha256)) { void stop(); return; }
    expiry = clock.setTimeout(stop, input.expires - clock.now());
    loading = (async () => {
      try {
        renderer = await render(input, { signal: controller.signal });
        if (stopping || !parent.connected || clock.now() >= input.expires) { void stop(); return; }
        parent.send({ kind: 'shown', sha256: input.sha256, bytes: input.png.length });
      } catch { void stop(); }
    })();
  });
  return { stop };
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--worker') {
  if (process.env.TOUCHSTONE_ROAM_RUNTIME !== '1' || !process.connected) process.exit(1);
  reviewWorker();
}
