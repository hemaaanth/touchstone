// Raw inference client + spend ledger for the ACTIVE provider (see providers.mjs).
//
// BASE_URL, MODELS and the key come from the provider active when this module
// loads: PROVIDER=<id>, else the Settings default. Each engine run is a fresh
// process, so this snapshot is that run's provider and budget.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { FALLBACK_PRICE, activeProvider, runBudgetUsd, providerKey } from "./providers.mjs";
import { createRunBudget } from "./run-budget.mjs";

const budget = createRunBudget(process.env.RUN_BUDGET_USD ?? runBudgetUsd(), process.env.RUN_SPENT_USD ?? 0);
export const runSpend = () => ({ usd: budget.usd, budgetUsd: budget.limit });

const PROVIDER = activeProvider();

export const PROVIDER_ID = PROVIDER.id;
export const PROVIDER_LABEL = PROVIDER.label;
export const BASE_URL = PROVIDER.baseUrl;
export const MODELS = PROVIDER.models;

const LEDGER = new URL("../spend.json", import.meta.url);

export function key() {
  const k = providerKey(PROVIDER);
  if (!k) {
    throw new Error(`No API key for provider "${PROVIDER.id}". Add it in Settings${PROVIDER.keyEnv ? ` or set ${PROVIDER.keyEnv}` : ""}.`);
  }
  return k;
}

// ---- Spend ledger. One global ledger across providers; every paid call goes
// through charge(). The lifetime ledger is a summary, never a launch gate.
function readLedger() {
  return existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : { totalUsd: 0, calls: 0, byModel: {} };
}
export function spent() {
  return readLedger().totalUsd;
}
export function guard(estimateUsd = 0) {
  budget.guard(estimateUsd);
}
export function costOf(modelId, inTok, outTok) {
  const m = Object.values(MODELS).find((x) => x.id === modelId);
  if (!m) {
    // Unknown model for the active provider: fall back to a conservative price
    // so the cap still trips rather than letting spend run free.
    console.warn(`[inference] no price for ${modelId} on provider "${PROVIDER.id}"; using fallback $${FALLBACK_PRICE.input}/$${FALLBACK_PRICE.output} per 1M`);
    return (FALLBACK_PRICE.input * inTok + FALLBACK_PRICE.output * outTok) / 1e6;
  }
  return (m.input * inTok + m.output * outTok) / 1e6;
}
export function charge(modelId, usage) {
  const inTok = usage?.prompt_tokens ?? usage?.input ?? 0;
  const outTok = usage?.completion_tokens ?? usage?.output ?? 0;
  const usd = costOf(modelId, inTok, outTok);
  budget.charge(usd);
  const l = readLedger();
  l.totalUsd += usd;
  l.calls += 1;
  const key = `${PROVIDER.id}/${modelId}`;
  const b = (l.byModel[key] ??= { usd: 0, input: 0, output: 0, calls: 0 });
  b.usd += usd; b.input += inTok; b.output += outTok; b.calls += 1;
  writeFileSync(LEDGER, JSON.stringify(l, null, 2));
  return usd;
}

// ---- Raw Chat Completions call. Non-streaming returns the JSON body.
// Streaming returns { chunks, text, reasoning, toolCalls, finish, usage }.
export async function chat(modelId, body, { stream = false, estimateUsd = 0.01, timeoutMs = 180_000 } = {}) {
  guard(estimateUsd);
  const payload = { model: modelId, ...body, ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}) };
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key()}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text();
    return { httpError: res.status, error: text.slice(0, 600) };
  }
  if (!stream) {
    const json = await res.json();
    charge(modelId, json.usage);
    return json;
  }
  const out = { chunks: 0, text: "", reasoning: "", toolCalls: [], finish: null, usage: null };
  const decoder = new TextDecoder();
  let buf = "";
  for await (const part of res.body) {
    buf += decoder.decode(part, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      const evt = JSON.parse(data);
      out.chunks += 1;
      if (evt.usage) out.usage = evt.usage;
      const choice = evt.choices?.[0];
      if (!choice) continue;
      const d = choice.delta ?? {};
      if (d.content) out.text += d.content;
      if (d.reasoning_content) out.reasoning += d.reasoning_content;
      if (d.reasoning) out.reasoning += d.reasoning;
      for (const tc of d.tool_calls ?? []) {
        const slot = (out.toolCalls[tc.index ?? 0] ??= { id: "", name: "", arguments: "", deltas: 0 });
        slot.deltas += 1;
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.arguments += tc.function.arguments;
      }
      if (choice.finish_reason) out.finish = choice.finish_reason;
    }
  }
  charge(modelId, out.usage);
  return out;
}
