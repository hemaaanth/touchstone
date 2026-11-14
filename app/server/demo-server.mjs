import { createServer } from "node:http";
import { lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import { DEMO, demoEnvironment } from "./demo-config.mjs";
import { createDemoHandler } from "./demo-http.mjs";

const TYPES = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff" };
export function demoAssets(directory) {
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("Demo assets must be a real built directory.");
  const indexFile = join(directory, "index.html");
  if (!lstatSync(indexFile).isFile() || lstatSync(indexFile).isSymbolicLink()) throw new Error("Demo index must be a regular file.");
  const html = readFileSync(indexFile, "utf8");
  if (!html.includes("</head>") || /touchstone-console-token|touchstone-demo|\/src\/|@vite|@fs\//i.test(html) || !/<script\b[^>]*src=["']\/assets\/[^"']+\.js["']/i.test(html)) throw new Error("Demo needs built HTML without a console token or source imports.");
  const assets = new Map();
  const scan = (relative) => {
    const dir = join(directory, relative);
    if (lstatSync(dir).isSymbolicLink()) throw new Error("Demo assets cannot be links.");
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry.name)) continue;
      const path = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error("Demo assets cannot be links.");
      if (entry.isDirectory()) scan(path);
      else if (entry.isFile() && TYPES[extname(entry.name)]) assets.set(`/${path}`, { data: readFileSync(join(directory, path)), type: TYPES[extname(entry.name)] });
    }
  };
  for (const dir of ["assets", "fonts"]) {
    if (readdirSync(directory).includes(dir)) scan(dir);
  }
  if (readdirSync(directory).includes("favicon.svg")) {
    const file = join(directory, "favicon.svg");
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error("Invalid demo favicon.");
    assets.set("/favicon.svg", { data: readFileSync(file), type: TYPES[".svg"] });
  }
  for (const match of html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)) if (!assets.has(match[1])) throw new Error("Built HTML names a missing asset.");
  return { html: html.replace("</head>", `<meta name="touchstone-demo" content='${JSON.stringify(DEMO)}'></head>`), assets };
}

export function createDemoServerHandler(config, api, built = demoAssets(config.assetsDir)) {
  return (req, res) => {
    let staticPage;
    if (req.method === "GET" || req.method === "HEAD") {
      if (req.url === "/") staticPage = () => { res.statusCode = 200; res.setHeader("content-type", "text/html; charset=utf-8"); res.end(req.method === "HEAD" ? undefined : built.html); };
      else {
        const key = req.url === "/favicon.svg?v=stone" ? "/favicon.svg" : req.url;
        const asset = built.assets.get(key);
        if (asset) staticPage = () => { res.statusCode = 200; res.setHeader("content-type", asset.type); res.end(req.method === "HEAD" ? undefined : asset.data); };
      }
    }
    // No SPA catch-all, Vite middleware, filesystem router, or owner dispatch.
    return api(req, res, staticPage);
  };
}

export async function startDemoServer(config, env = process.env) {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const state = lstatSync(config.stateDir);
  if (!state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o077)) throw new Error("Demo state must be a private real directory.");
  Object.assign(process.env, env, demoEnvironment(config));
  // A process-owned lock rejects a second public server sharing this sponsor state.
  const { DatabaseSync } = await import("node:sqlite");
  const lock = new DatabaseSync(join(config.stateDir, "demo-server.sqlite"), { timeout: 0 });
  try {
    lock.exec("BEGIN IMMEDIATE");
    const providersFile = config.stores.TOUCHSTONE_PROVIDERS_FILE;
    if (readdirSync(config.stateDir).includes("providers.json")) {
      const file = lstatSync(providersFile);
      if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077)) throw new Error("Demo provider config must be private.");
      const saved = JSON.parse(readFileSync(providersFile, "utf8"));
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("Invalid demo provider config.");
    }
    const built = demoAssets(config.assetsDir);
    const backend = await import("./runs.mjs");
    const findings = await import("./findings.mjs");
    const { handleFindings } = await import("./runs-http.mjs");
    backend.demoCatalog();
    const api = createDemoHandler(config, backend, findings, handleFindings);
    const server = createServer(createDemoServerHandler(config, api, built));
    server.requestTimeout = 10000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(config.port, config.host, resolve); });
    // Keep the state lock until process exit: closing HTTP does not stop run cleanup.
    server.demoLock = lock;
    return server;
  } catch (error) { lock.close(); throw error; }
}
