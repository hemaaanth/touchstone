// Inference providers for the red-team engine.
//
// Each provider speaks the OpenAI Chat Completions format over its own base URL
// and API key. A provider is config only: a base URL, a key, and a table of
// models with per-token prices (USD per 1M tokens).
//
// Two sources, merged by id:
//   1. PROVIDERS below: built-in presets. Their key comes from an env var
//      (spike/.env.local), e.g. NEARAI_API_KEY.
//   2. spike/data/providers.json: providers the operator saved in the app's
//      Settings page. A saved entry overrides a preset with the same id. Its key
//      is stored in that file (mode 0600, gitignored) and never leaves the server.
//
// The active provider is PROVIDER=<id> if set, else the default saved in
// Settings, else FALLBACK_ID. The app pins PROVIDER per run, so a run keeps its
// provider even when the default changes later.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// The project-wide spend cap, unless Settings saves another one.
export const DEFAULT_CAP_USD = 25.0;

// Conservative fallback when a provider has not published per-token prices yet.
// Assume expensive so the spend cap trips early rather than letting a run bleed
// past the cap on an unknown price.
export const FALLBACK_PRICE = { input: 1.0, output: 5.0 };

export const PROVIDERS = {
  // NEAR AI Cloud. Prices from /v1/models with the user's key.
  near: {
    id: "near",
    label: "NEAR AI Cloud",
    baseUrl: "https://cloud-api.near.ai/v1",
    keyEnv: "NEARAI_API_KEY",
    models: {
      "qwen-abl": { id: "Qwen/Qwen3.8-27B-abliterated", input: 0.04, output: 1.35, context: 262144, maxOut: 65536, structured: true },
      "qwen": { id: "Qwen/Qwen3.8-27B", input: 0.04, output: 1.35, context: 262144, maxOut: 65536, structured: true },
      "ds-abl": { id: "deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated", input: 0.3, output: 1.2, context: 1000000, maxOut: 65536, structured: false },
      "ds": { id: "deepseek-ai/DeepSeek-V4.1-Flash-1017", input: 0.3, output: 1.2, context: 1000000, maxOut: 65536, structured: false },
    },
  },

  // Boundless (boundless.network). OpenAI-compatible gateway for open models.
  // Host is api.inference.boundless.network. GET /v1/models lists what THIS
  // account can actually serve; re-run `node discover-models.mjs` with the key
  // to refresh. Prices are USD per 1M tokens, taken from that catalog.
  //
  // Discovery (2026-11) returned exactly one served model for this account:
  // the abliterated DeepSeek — the refusal-removed model Touchstone's premise
  // needs. The account's credits unlock it directly (no "Defensive Access"
  // gating applied here). Re-add the other open Boundless models (ds / qwen /
  // gpt-oss / glm) here if the account's /v1/models catalog grows to serve them.
  boundless: {
    id: "boundless",
    label: "Boundless",
    baseUrl: "https://api.inference.boundless.network/v1",
    keyEnv: "BOUNDLESS_API_KEY",
    models: {
      "ds-abl": { id: "deepseek-v4.1-flash-abliterated", input: 0.24, output: 0.96, context: 1048576, maxOut: 65536, structured: true },
    },
  },

  // Lyber (lyber.ai). One OpenAI-compatible API for uncensored/abliterated
  // models. Early access — launch prices are provisional, so the model below
  // carries the conservative FALLBACK_PRICE until Lyber publishes real numbers.
  // Wired "out of the box"; not yet validated (no account/key yet).
  lyber: {
    id: "lyber",
    label: "Lyber",
    baseUrl: "https://lyber-paid-acceptance-gateway-production.up.railway.app/v1",
    keyEnv: "LYBER_API_KEY",
    models: {
      "kimi-abl": {
        id: "kimi-k31-pro-abliterated",
        input: FALLBACK_PRICE.input,
        output: FALLBACK_PRICE.output,
        context: 262144,
        maxOut: 65536,
        structured: true,
        provisional: true,
      },
    },
  },
};

const FALLBACK_ID = "boundless";
const CONFIG = new URL("../data/providers.json", import.meta.url);

// ---- Saved config. Shape:
//   { default: { provider, model } | null, capUsd: number | null,
//     providers: { [id]: { id, label, baseUrl, apiKey, models: { [alias]: model } } } }
export function readConfig() {
  const empty = { default: null, capUsd: null, providers: {} };
  if (!existsSync(CONFIG)) return empty;
  try {
    return { ...empty, ...JSON.parse(readFileSync(CONFIG, "utf8")) };
  } catch {
    return empty;
  }
}

export function writeConfig(cfg) {
  mkdirSync(new URL(".", CONFIG), { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(CONFIG, 0o600);
}

// Every provider: presets merged with saved entries. Read fresh on each call,
// so the app server sees a Settings change without a restart.
export function allProviders(cfg = readConfig()) {
  const out = {};
  for (const [id, p] of Object.entries(PROVIDERS)) out[id] = { ...p, builtIn: true };
  for (const [id, saved] of Object.entries(cfg.providers ?? {})) {
    const base = out[id] ?? { id, builtIn: false };
    out[id] = {
      ...base,
      ...saved,
      id,
      label: saved.label || base.label || id,
      baseUrl: saved.baseUrl || base.baseUrl,
      models: saved.models && Object.keys(saved.models).length ? saved.models : base.models ?? {},
    };
  }
  return out;
}

// The key for a provider: the one saved in Settings, else its env var.
export function providerKey(p) {
  return p?.apiKey || (p?.keyEnv ? process.env[p.keyEnv] : null) || null;
}

export function activeId(cfg = readConfig()) {
  return process.env.PROVIDER || cfg.default?.provider || FALLBACK_ID;
}

export function getProvider(id, cfg = readConfig()) {
  const p = allProviders(cfg)[id];
  if (!p) throw new Error(`Unknown provider "${id}". Known: ${Object.keys(allProviders(cfg)).join(", ")}`);
  if (!p.baseUrl) throw new Error(`Provider "${id}" has no base URL.`);
  return p;
}

export function activeProvider(cfg = readConfig()) {
  return getProvider(activeId(cfg), cfg);
}

// The model alias a new run uses on provider p: the Settings default when it
// belongs to p, else p's first model.
export function defaultAlias(p, cfg = readConfig()) {
  const want = cfg.default?.provider === p.id ? cfg.default?.model : null;
  if (want && p.models?.[want]) return want;
  return Object.keys(p.models ?? {})[0] ?? null;
}

export function capUsd(cfg = readConfig()) {
  const c = Number(cfg.capUsd);
  return Number.isFinite(c) && c > 0 ? c : DEFAULT_CAP_USD;
}

// A filename-safe alias for a model id. Run ids and file names start with it.
export function aliasFor(modelId) {
  return String(modelId).split("/").pop().toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "model";
}
