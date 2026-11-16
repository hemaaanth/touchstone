// A streamed browser session: a human watches, and can take over, while the same
// Chromium sits behind the capture proxy and the gate.
//
// WHY. A login form, an OTP mail, a captcha, a wallet approval: an agent cannot
// finish these alone. Streaming is the step where a person drives, and the
// session is then exported as storageState so later runs start logged in.
//
// LAYOUT. One container: Xvfb + openbox + Chromium, the desktop runtime and Voxl,
// plus a loopback control API. It joins the client network, so its only route out
// is mitm -> gate. The viewer port and the desktop runtime are published on
// 127.0.0.1 only.
//
// PLACEMENT. This runs locally, not on Daytona, because the gate is local. It is
// not free-roam: the browser has no route except the gate. Free-roam shell stays
// a Daytona capability.
import { execFile } from "node:child_process";
import { createServer, connect } from "node:net";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MITM_PORT, startProxy } from "./intercept.mjs";
import { event } from "./event.mjs";
import { pause, resume } from "./pause.mjs";

export const STREAM_IMAGE = "touchstone/web-browser:stream";
const VIEW_PORT = 7801;
// How long operator control lasts without a fresh takeover request. A person who
// walks away must not leave the agent blocked forever.
// Read per call so a test (or an operator) can shorten it.
const resumeMs = () => Number(process.env.TOUCHSTONE_RESUME_MS || 5 * 60_000);
const CONTROL_PORT = 7802;

function docker(args, { timeoutMs = 60_000, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile("docker", args, { timeout: timeoutMs, maxBuffer }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

// One control call inside the container. The API is loopback-only, so exec is
// the only way in; nothing about it reaches the page under test.
const control = (name, action) => docker(["exec", name, "node", "-e",
  `fetch("http://127.0.0.1:${CONTROL_PORT}/${action}",{method:"POST"}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`,
], { timeoutMs: 20_000 });

const token = () => randomBytes(32).toString("base64url");

// A published port on an `--internal` network is not reachable from the host
// here, but the container IP is. So the viewer gets a loopback pipe instead of a
// Docker port mapping: the browser keeps a gate-only network and the operator
// still reaches it on 127.0.0.1.
// A remote operator cannot reach 127.0.0.1 of this machine. When
// TOUCHSTONE_STREAM_PORT is set, the pipe takes that fixed port on all
// interfaces and the returned URL is TOUCHSTONE_STREAM_PUBLIC_URL (a tunnel in
// front of it), so the preview iframe works from anywhere.
const STREAM_BIND = process.env.TOUCHSTONE_STREAM_BIND || "127.0.0.1";
const STREAM_PORT = Number(process.env.TOUCHSTONE_STREAM_PORT || 0);

const pipeTo = (target) => new Promise((resolve, reject) => {
  const server = createServer((client) => {
    const upstream = connect(target.port, target.host);
    client.pipe(upstream).pipe(client);
    const end = () => { client.destroy(); upstream.destroy(); };
    client.on("error", end); upstream.on("error", end);
  });
  // One public port is shared by every session, so a previous pipe may still be
  // closing. Retry the bind briefly; if it stays taken, take any port rather
  // than fail the session (the card then shows a local URL).
  let tries = 0;
  const listen = () => {
    server.once("error", onError);
    server.listen(STREAM_PORT || 0, STREAM_BIND, () => {
      server.removeListener("error", onError);
      resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) });
    });
  };
  const onError = (err) => {
    if (err.code === "EADDRINUSE" && STREAM_PORT && ++tries < 20) return setTimeout(listen, 500);
    reject(err);
  };
  listen();
});

// Start the session and return its viewer URL. Rejects on any setup failure.
export async function startStream(ws, ctx, { baseUrl, storageState = null, viewOnly = true, appOrigins = [], readyTimeoutMs = 60_000 } = {}) {
  if (!ctx?.net || !ctx?.upstream) throw new Error("startStream: ctx {net, upstream} is required");
  const dir = mkdtempSync(join(tmpdir(), "touchstone-stream-"));
  chmodSync(dir, 0o777);
  mkdirSync(join(dir, "shots"), { recursive: true });
  if (storageState) writeFileSync(join(dir, "state.json"), JSON.stringify(storageState));
  const proxy = await startProxy(ctx, join(dir, "proxy"));
  const name = `touchstone-stream-${randomBytes(4).toString("hex")}`;
  const cert = `/app/_run/proxy/ca/mitmproxy-ca-cert.pem`;
  const view = token();
  let started = false;
  let pipe = null;
  try {
    const run = await docker([
      "run", "-d", "--rm", "--pull=never", "--name", name,
      "--network", ctx.net,
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--pids-limit", "512", "--memory", "3g", "--shm-size", "1g",
      "--user", `${process.getuid()}:${process.getgid()}`,
      "-v", `${dir}:/app/_run`,
      "-e", `TOUCHSTONE_DESKTOP_PORT=${VIEW_PORT}`,
      "-e", `TOUCHSTONE_CONTROL_PORT=${CONTROL_PORT}`,
      "-e", `TOUCHSTONE_VIEW_TOKEN=${view}`,
      "-e", `TOUCHSTONE_VIEW_ONLY=${viewOnly ? "1" : "0"}`,
      "-e", `TOUCHSTONE_STATE=/app/_run/state.json`,
      "-e", `TOUCHSTONE_START_URL=${baseUrl}`,
      "-e", `TOUCHSTONE_HAS_STATE=${storageState ? "1" : "0"}`,
      "-e", `TOUCHSTONE_PROXY_URL=http://mitm:${MITM_PORT}`,
      "-e", `TOUCHSTONE_TEST_URL=${baseUrl}`,
      "-e", `NODE_EXTRA_CA_CERTS=${cert}`,
      "--entrypoint", "node", STREAM_IMAGE, "/opt/touchstone/roam/desktop/session.mjs",
    ]);
    if (run.code !== 0) throw new Error(`stream: container run failed: ${run.stderr.trim().slice(0, 500)}`);
    started = true;

    const ip = (await docker(["inspect", name, "--format",
      `{{index .NetworkSettings.Networks ${JSON.stringify(ctx.net)} "IPAddress"}}`])).stdout.trim();
    if (!ip) throw new Error("stream: no container address on the client network");
    pipe = await pipeTo({ host: ip, port: VIEW_PORT });
    // A tunnel needs its sign-in cookie, which a cross-site iframe does not
    // reliably carry. When the console is served on an origin, the viewer is
    // framed THROUGH that origin instead (the server proxies /preview/<port>),
    // so the frame is same-site and needs no extra tunnel port.
    const publicUrl = process.env.TOUCHSTONE_STREAM_PUBLIC_URL;
    const consoleOrigin = process.env.TOUCHSTONE_CONSOLE_ORIGIN;
    const preview = publicUrl && consoleOrigin ? `${consoleOrigin.replace(/\/+$/, "")}/preview/${pipe.port}` : publicUrl || `http://127.0.0.1:${pipe.port}`;
    // Wait for the control API before asking it anything: the container is
    // running but its node process may not be listening yet.
    const upBy = Date.now() + 30_000;
    for (;;) {
      const any = await docker(["exec", name, "node", "-e",
        `fetch("http://127.0.0.1:${CONTROL_PORT}/healthz").then(()=>process.exit(0)).catch(()=>process.exit(1))`]);
      if (any.code === 0) break;
      if (Date.now() >= upBy) throw new Error("stream: the session control API did not start");
      await new Promise((r) => setTimeout(r, 300));
    }
    // The desktop runtime is opened AFTER the container is up, because the
    // preview origin is only known once the port is published.
    const open = await docker(["exec", name, "node", "-e",
      `fetch("http://127.0.0.1:${CONTROL_PORT}/open?viewOnly=${viewOnly ? 1 : 0}&preview=${encodeURIComponent(preview)}&token=${view}&parent=${encodeURIComponent(appOrigins[0] ?? preview)}",{method:"POST"}).then(async r=>{ if(r.ok) process.exit(0); console.log(await r.text()); process.exit(1) }).catch(()=>process.exit(1))`,
    ], { timeoutMs: 30_000 });
    if (open.code !== 0) {
      const why = open.stdout.trim()
      throw new Error(`stream: the desktop runtime did not open${why ? `: ${why.slice(0, 300)}` : ""}`)
    }

    // Ready when the session reports a page and the viewer page answers.
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      const probe = await docker(["exec", name, "node", "-e",
        `fetch("http://127.0.0.1:${CONTROL_PORT}/healthz").then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))`]);
      if (probe.code === 0) break;
      if (Date.now() >= deadline) throw new Error("stream: the session did not become ready");
      await new Promise((r) => setTimeout(r, 400));
    }

    return {
      name, dir, view, preview,
      // The console frames the viewer, so the fragment names ITS origin. Without
      // one (a smoke, a CLI) the viewer frames itself.
      url: `${preview}/#${view}&parentOrigin=${encodeURIComponent(appOrigins[0] ?? preview)}`,
      viewOnly,
      async navigate(url) {
        return docker(["exec", name, "node", "-e",
          `fetch("http://127.0.0.1:${CONTROL_PORT}/navigate",{method:"POST",body:${JSON.stringify(url)}}).then(r=>process.exit(r.ok?0:1))`], { timeoutMs: 30_000 });
      },
      async setMode(nextViewOnly, { auto = false, touch = false } = {}) {
        // A renew while already in control only re-arms the idle window: no
        // runtime restart, no event.
        if (touch && this.viewOnly === nextViewOnly) {
          clearTimeout(this.resumeTimer);
          if (!nextViewOnly) this.armResume();
          return;
        }
        const r = await docker(["exec", name, "node", "-e",
          `fetch("http://127.0.0.1:${CONTROL_PORT}/mode?viewOnly=${nextViewOnly ? 1 : 0}&preview=${encodeURIComponent(preview)}&token=${view}&parent=${encodeURIComponent(appOrigins[0] ?? preview)}",{method:"POST"}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`], { timeoutMs: 60_000 });
        if (r.code !== 0) throw new Error("stream: the mode switch failed");
        this.viewOnly = nextViewOnly;
        event("browser_session-mode", { viewOnly: nextViewOnly, ...(auto ? { auto: true } : {}) });
        clearTimeout(this.resumeTimer);
        this.resumeTimer = undefined;
        if (nextViewOnly) resume("operator");
        else { pause("operator"); this.armResume(); }
      },
      async state() {
        const r = await control(name, "state");
        if (r.code !== 0) return null;
        try { return JSON.parse(readFileSync(join(dir, "state.json"), "utf8")); } catch { return null; }
      },
      armResume() {
        clearTimeout(this.resumeTimer);
        this.resumeTimer = setTimeout(() => { this.setMode(true, { auto: true }).catch(() => {}); }, resumeMs());
        this.resumeTimer.unref?.();
      },
      async stop() {
        clearTimeout(this.resumeTimer);
        if (!this.viewOnly) resume("stop");
        await control(name, "close");
        await pipe?.close();
        pipe = null;
        await new Promise((r) => setTimeout(r, 1500));
        await docker(["rm", "-f", name]);
        await proxy.stop();
        const har = join(dir, "proxy", "capture.har");
        const keep = existsSync(har) ? readFileSync(har) : null;
        rmSync(dir, { recursive: true, force: true });
        return keep;
      },
    };
  } catch (err) {
    await pipe?.close();
    if (started) await docker(["rm", "-f", name]);
    await proxy.stop();
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

// Sessions live for the process, keyed by workspace: a tool call and the next
// one are the same run, and a handle cannot cross a file boundary.
const live = new Map();

export const sessionFor = (ws) => live.get(ws) ?? null;

// The engine's stdin path (agent-run.mjs) has no workspace in scope, so the one
// open session is reachable through this sink. The pack sets it on open.
let modeSink = null;

export async function applySessionMode(viewOnly, touch = false) {
  if (!modeSink) return null;
  return modeSink(viewOnly, touch);
}

// True while a person has control: capture tools stand down.
export const operatorHasControl = (ws) => sessionFor(ws)?.viewOnly === false;

export async function openSession(ws, ctx, opts) {
  if (live.has(ws)) throw new Error("a browser session is already open for this run; stop it first");
  const handle = await startStream(ws, ctx, opts);
  live.set(ws, handle);
  modeSink = (viewOnly, touch) => handle.setMode(viewOnly, { touch });
  return handle;
}

export async function closeSession(ws) {
  const handle = live.get(ws);
  live.delete(ws);
  modeSink = null;
  if (!handle) return null;
  const har = await handle.stop();
  return { har, viewUrl: handle.url };
}
