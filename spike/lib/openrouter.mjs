// OpenRouter: stock (non-abliterated) models, prices, raw calls, and a spend ledger with a hard cap.
// The key comes from OPENROUTER_API_KEY (load .env.local into the environment first).
// This is a separate ledger from NEAR's spend.json so the two caps never mix.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export const BASE_URL = "https://openrouter.ai/api/v1";
export const CAP_USD = 0.25;
const LEDGER = new URL("../spend-openrouter.json", import.meta.url);

// Prices in USD per million tokens, read from OpenRouter's /models on 2026-11-08.
// These are the STOCK versions. NEAR runs the abliterated versions of the first two.
export const MODELS = {
  "ds": { id: "deepseek/deepseek-v4.1-flash-1017", input: 0.006, output: 0.5 },
  "qwen": { id: "qwen/qwen3.8-27b", input: 0.15, output: 1.875 },
  "glm": { id: "z-ai/glm-5.3-flash", input: 0.034, output: 0.083 },
};

export function key() {
  const k = process.env.OPENROUTER_API_KEY;
  if (!k) throw new Error("OPENROUTER_API_KEY is not set. Run: set -a; . ./.env.local; set +a");
  return k;
}

function readLedger() {
  return existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : { totalUsd: 0, calls: 0, byModel: {} };
}
export function spent() {
  return readLedger().totalUsd;
}
export function guard(estimateUsd = 0) {
  const total = spent();
  if (total + estimateUsd >= CAP_USD) {
    throw new Error(`OpenRouter cap: $${total.toFixed(4)} spent, next call estimate $${estimateUsd.toFixed(4)}, cap $${CAP_USD}`);
  }
}
export function costOf(modelId, inTok, outTok) {
  const m = Object.values(MODELS).find((x) => x.id === modelId);
  if (!m) throw new Error(`No price for ${modelId}`);
  return (m.input * inTok + m.output * outTok) / 1e6;
}
export function charge(modelId, usage) {
  const inTok = usage?.prompt_tokens ?? usage?.input ?? 0;
  const outTok = usage?.completion_tokens ?? usage?.output ?? 0;
  const usd = costOf(modelId, inTok, outTok);
  const l = readLedger();
  l.totalUsd += usd;
  l.calls += 1;
  const b = (l.byModel[modelId] ??= { usd: 0, input: 0, output: 0, calls: 0 });
  b.usd += usd; b.input += inTok; b.output += outTok; b.calls += 1;
  writeFileSync(LEDGER, JSON.stringify(l, null, 2));
  return usd;
}

// Raw Chat Completions call. Non-streaming returns the JSON body.
export async function chat(modelId, body, { estimateUsd = 0.01, timeoutMs = 120_000 } = {}) {
  guard(estimateUsd);
  const payload = { model: modelId, ...body };
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key()}`,
      "HTTP-Referer": "https://localhost/redteam-harness-spike",
      "X-Title": "redteam-harness refusal spike",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text();
    return { httpError: res.status, error: text.slice(0, 600) };
  }
  const json = await res.json();
  charge(modelId, json.usage);
  return json;
}
