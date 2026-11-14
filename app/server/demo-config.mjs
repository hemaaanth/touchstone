import { isAbsolute, join, resolve } from "node:path";
import { isIP } from "node:net";

export const DEMO = Object.freeze({ budgetUsd: 1, maxMinutes: 10 });
export const DEMO_TARGETS = Object.freeze(["vault-reentrancy", "vault-accounting"]);
export const DEMO_MODEL = "ds-abl";
export const DEMO_ENDPOINT = "https://cloud-api.near.ai/v1";

// Validate before importing the backend: its imports read stores and credentials.
export function demoConfig(env = process.env) {
  if (env.TOUCHSTONE_DEMO === undefined || env.TOUCHSTONE_DEMO === "0") return null;
  if (env.TOUCHSTONE_DEMO !== "1") throw new Error("TOUCHSTONE_DEMO must be 0 or 1.");
  let origin;
  try { origin = new URL(env.TOUCHSTONE_DEMO_ORIGIN); } catch { throw new Error("An explicit demo origin is required."); }
  const loopbackTest = env.TOUCHSTONE_DEMO_TEST_HTTP === "1" && origin.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname);
  if (origin.origin !== env.TOUCHSTONE_DEMO_ORIGIN || origin.username || origin.password || (!loopbackTest && origin.protocol !== "https:")) throw new Error("Invalid demo origin.");
  if (env.TOUCHSTONE_DEMO_TEST_HTTP !== undefined && env.TOUCHSTONE_DEMO_TEST_HTTP !== "1") throw new Error("Invalid demo test flag.");
  const stateDir = env.TOUCHSTONE_DEMO_STATE_DIR;
  if (!stateDir || !isAbsolute(stateDir)) throw new Error("TOUCHSTONE_DEMO_STATE_DIR must be an absolute private directory.");
  const positive = (name) => {
    const raw = env[name];
    if (!/^(?:\d+\.?\d*|\.\d+)$/.test(raw ?? "") || !Number.isFinite(Number(raw)) || Number(raw) <= 0) throw new Error(`${name} must be an explicit positive finite amount.`);
    return Number(raw);
  };
  const capUsd = positive("SPEND_CAP_USD");
  if (env.PROVIDER && env.PROVIDER !== "near") throw new Error("Demo requires NEAR.");
  if (env.TOUCHSTONE_EXEC !== undefined && env.TOUCHSTONE_EXEC !== "local") throw new Error("Demo requires local confined execution.");
  if (env.FLEET_MAX !== undefined && env.FLEET_MAX !== "3") throw new Error("Demo requires FLEET_MAX=3.");
  if (env.TOUCHSTONE_DEMO_PROXY_IP !== undefined && !isIP(env.TOUCHSTONE_DEMO_PROXY_IP)) throw new Error("Demo proxy must be one literal IP address.");
  if (env.TOUCHSTONE_DEMO_ASSETS_DIR !== undefined && !isAbsolute(env.TOUCHSTONE_DEMO_ASSETS_DIR)) throw new Error("Demo assets directory must be absolute.");
  const host = env.HOST ?? "127.0.0.1";
  if (!["127.0.0.1", "::1"].includes(host)) throw new Error("Demo must bind loopback.");
  const port = env.PORT ?? "5190";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("Invalid demo port.");
  const stores = {
    TOUCHSTONE_RESULTS_DIR: join(stateDir, "results"), AGENT_RESULTS_DIR: join(stateDir, "results"), TOUCHSTONE_PROVIDERS_FILE: join(stateDir, "providers.json"),
    TOUCHSTONE_GRANTS_FILE: join(stateDir, "grants.json"), TOUCHSTONE_SCOPES_FILE: join(stateDir, "scopes.json"),
    TOUCHSTONE_GRANT_TOKEN_FILE: join(stateDir, "console-token"), DAYTONA_PENDING: join(stateDir, "daytona-pending.json"),
    TOUCHSTONE_DAYTONA_STATE_FILE: join(stateDir, "daytona-state.json"), SPEND_LEDGER: join(stateDir, "spend.json"),
  };
  for (const [name, file] of Object.entries(stores)) {
    if (env[name] !== undefined && resolve(env[name]) !== resolve(file)) throw new Error(`${name} must stay in the demo state directory.`);
  }
  return { ...DEMO, origin: origin.origin, secure: !loopbackTest, stateDir: resolve(stateDir), stores,
    secretFile: join(stateDir, "session-secret"), ratesFile: join(stateDir, "start-rates.json"),
    assetsDir: env.TOUCHSTONE_DEMO_ASSETS_DIR ?? new URL("../dist", import.meta.url).pathname,
    host, port: Number(port), proxyIp: env.TOUCHSTONE_DEMO_PROXY_IP ?? null, capUsd };
}

export function demoEnvironment(config) {
  return { ...config.stores, PROVIDER: "near", FLEET_MAX: "3", TOUCHSTONE_EXEC: "local" };
}
