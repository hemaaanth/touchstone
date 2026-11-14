// Run the existing Vite UI and backend from an immutable release, not a dev checkout.
// Remote access still requires an authenticated tunnel; the console token is not login.
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function releaseConfig(env = process.env) {
  const host = env.HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("The release server must bind to loopback.");
  const portText = env.PORT ?? "5190";
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer from 1 to 65535.");
  }
  const cacheDir = env.TOUCHSTONE_VITE_CACHE_DIR;
  if (!cacheDir || !isAbsolute(cacheDir)) throw new Error("TOUCHSTONE_VITE_CACHE_DIR must be an absolute private-state path.");
  return {
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    cacheDir,
    clearScreen: false,
    server: { host, port, strictPort: true, hmr: false, watch: null, open: false },
  };
}

export async function startServer(env = process.env, createServer) {
  const config = releaseConfig(env);
  createServer ??= (await import("vite")).createServer;
  const server = await createServer(config);
  try { await server.listen(); }
  catch (error) { await server.close(); throw error; }
  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  startServer().then(() => {
    console.log("Touchstone release server started.");
  }).catch(() => {
    // Do not print configuration, environment values, or backend errors containing secrets.
    console.error("Touchstone release server failed to start. Check its port and private cache configuration.");
    process.exitCode = 1;
  });
}
