// Inference providers for the red-team engine.
//
// Each provider speaks the OpenAI Chat Completions format over its own base URL
// and API key, so adding one is pure config: a base URL, the name of the env var
// that holds its key, and a table of models with per-token prices.
//
// Select the active provider with PROVIDER=<id> (default below). The active one
// drives BOTH paths: the raw calls in lib/inference.mjs (probes, ledger) and the
// pi-durable agent loop in lib/provider.mjs. Keys are supplied via spike/.env.local
// (e.g. NEARAI_API_KEY, BOUNDLESS_API_KEY, LYBER_API_KEY) — never hard-coded here.

export const CAP_USD = 2.0;

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

// Default provider. Rotated to Boundless after NEAR rejected its key; the
// Boundless key is validated and its abliterated model confirmed served.
// Override per-run with PROVIDER=<id> (e.g. PROVIDER=near, PROVIDER=lyber).
export const ACTIVE_ID = process.env.PROVIDER ?? "boundless";

export function activeProvider() {
  const p = PROVIDERS[ACTIVE_ID];
  if (!p) {
    throw new Error(`Unknown PROVIDER "${ACTIVE_ID}". Known: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  if (!p.baseUrl) {
    throw new Error(`Provider "${ACTIVE_ID}" has no baseUrl configured yet.`);
  }
  return p;
}
