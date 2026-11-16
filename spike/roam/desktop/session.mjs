// The session program inside the streamed-browser container.
//
// One process owns the whole session: it starts the X display, launches a
// persistent Chromium profile through the proxy, runs the desktop runtime (view
// and takeover over Voxl), and answers a tiny control API on loopback.
//
// The agent's host side talks to it with `docker exec`, never over the network,
// so the control API cannot be reached from the page under test.
//
//   POST /state   -> write the profile's storageState to /app/_run/state.json
//   POST /close   -> close the browser and exit
//   GET  /healthz -> 200 once a page is up
//
// The operator watches through the desktop runtime's own port, which the host
// publishes; this file never proxies frames itself.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { DesktopRuntime } from "./desktop-host.mjs";

const DIR = "/app/_run";
const PORT = Number(process.env.TOUCHSTONE_CONTROL_PORT || 7802);
const PROXY = process.env.TOUCHSTONE_PROXY_URL || "http://mitm:8080";
const VIEW_ONLY = process.env.TOUCHSTONE_VIEW_ONLY !== "0";
const STATE = process.env.TOUCHSTONE_STATE || `${DIR}/state.json`;
const PREVIEW = process.env.TOUCHSTONE_PREVIEW_ORIGIN || "";

// The display the desktop runtime streams. The script refuses without the roam
// flag, which the image sets.
process.env.TOUCHSTONE_STATE_DIR ||= "/tmp/touchstone";
execFileSync("/opt/touchstone/roam/desktop/display-start.sh", ["start"], { stdio: "inherit" });

const { chromium } = await import("/usr/local/lib/node_modules/playwright/index.mjs");
const profile = `${DIR}/profile`;
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  ...(process.env.TOUCHSTONE_HAS_STATE === "1" ? { storageState: STATE } : {}),
  args: ["--no-sandbox", "--proxy-server=" + PROXY, "--proxy-bypass-list=<-loopback>", "--window-position=0,0"],
  ignoreHTTPSErrors: true,
  viewport: null,
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(process.env.TOUCHSTONE_START_URL || "about:blank");

const desktop = new DesktopRuntime();
const view = await desktop.command({ action: "configure" });

// The viewer origin is only known once the host published the port, so the
// session opens on command instead of at startup.
const openView = async (preview, wantViewOnly, viewToken, parent) => {
  // A preview may carry a path (the console proxies it there); the parent
  // allow-list is compared against a bare origin, so reduce both to one.
  const bare = (u) => { try { return new URL(u).origin; } catch { return null; } };
  const origins = [...new Set([bare(preview), bare(parent)].filter(Boolean))];
  await desktop.command({ action: "open", previewOrigin: preview, appOrigins: origins, token: viewToken, viewOnly: wantViewOnly });
};

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await desktop.command({ action: "close" }).catch(() => {});
  await context.close().catch(() => {});
  process.exit(0);
};

createServer((req, res) => {
  const url = req.url || "/";
  if (req.method === "GET" && url === "/healthz") {
    res.writeHead(page.url() === "about:blank" ? 204 : 200);
    return res.end();
  }
  if (req.method === "POST" && url === "/state") {
    context.storageState({ path: STATE }).then(
      () => { res.writeHead(204); res.end(); },
      (err) => { res.writeHead(500); res.end(String(err?.message ?? err)); },
    );
    return;
  }
  if (req.method === "POST" && url.startsWith("/open")) {
    const q = new URL(url, "http://x").searchParams;
    openView(q.get("preview"), q.get("viewOnly") === "1", q.get("token"), q.get("parent")).then(
      () => { res.writeHead(204); res.end(); },
      (err) => { res.writeHead(500); res.end(String(err?.message ?? err)); },
    );
    return;
  }
  // Switch watch/control without dropping the browser: the desktop runtime is
  // restarted, the Chromium context is not.
  if (req.method === "POST" && url.startsWith("/mode")) {
    const q = new URL(url, "http://x").searchParams;
    (async () => {
      await desktop.command({ action: "close" });
      await desktop.command({ action: "configure" });
      await openView(q.get("preview"), q.get("viewOnly") === "1", q.get("token"), q.get("parent"));
    })().then(() => { res.writeHead(204); res.end(); }, (err) => { res.writeHead(500); res.end(String(err?.message ?? err)); });
    return;
  }
  if (req.method === "POST" && url === "/close") { res.writeHead(204); res.end(); return void close(); }
  if (req.method === "POST" && url === "/navigate") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const target = Buffer.concat(chunks).toString("utf8");
      page.goto(target).then(() => { res.writeHead(204); res.end(); }, () => { res.writeHead(400); res.end(); });
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(PORT, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ ready: true, viewPort: view.port, preview: PREVIEW }) + "\n");
});

for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, close);
