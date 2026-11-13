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

// SPEND_LEDGER points every worktree at one shared ledger. SPEND_CAP_USD stops a
// call once the shared lifetime total reaches it (the total spend cap). Both are
// read on every call, so a test or a server can change them without a reload.
const ledgerPath = () => process.env.SPEND_LEDGER || new URL("../spend.json", import.meta.url);

export function key() {
  const k = providerKey(PROVIDER);
  if (!k) {
    throw new Error(`No API key for provider "${PROVIDER.id}". Add it in Settings${PROVIDER.keyEnv ? ` or set ${PROVIDER.keyEnv}` : ""}.`);
  }
  return k;
}

// ---- Spend ledger. One global ledger across providers; every paid call goes
// through charge(). With SPEND_CAP_USD set, guard() stops a call once the ledger
// total reaches the cap.
//
// Fail closed: a ledger that cannot be read, is not JSON, or has no numeric
// totalUsd throws. It never reads as $0 spent. A missing file is a fresh ledger.
// The messages below avoid words the engine's retry check treats as transient
// ("error", "timeout", "unavailable"), so a cap stop is never retried.
function readLedger() {
  const file = ledgerPath();
  if (!existsSync(file)) return { totalUsd: 0, calls: 0, byModel: {} };
  let l;
  try {
    l = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    l = null;
  }
  if (!l || typeof l !== "object" || typeof l.totalUsd !== "number" || !Number.isFinite(l.totalUsd) || l.totalUsd < 0) {
    throw new Error(`The spend ledger (${file}) is unreadable or corrupt, so the total spend cap cannot be checked. Fix or restore it before spending more.`);
  }
  return l;
}
export function spent() {
  return readLedger().totalUsd;
}
// The ledger total, or why it cannot be read. For screens that must not throw.
export function ledgerState() {
  try {
    return { usd: spent(), error: null };
  } catch (err) {
    return { usd: null, error: err.message };
  }
}
// The total spend cap from SPEND_CAP_USD, or null when it is not set. A value
// that is set but is not a positive finite number throws: it is never "no limit".
export function spendCapUsd(raw = process.env.SPEND_CAP_USD) {
  if (raw == null || String(raw).trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`SPEND_CAP_USD is set to "${raw}", which is not a positive dollar amount, so the total spend cap cannot be checked.`);
  }
  return n;
}
export function spendCapMessage(usd, cap) {
  return `Total spend cap reached: the ledger shows $${usd.toFixed(4)} of the $${cap.toFixed(2)} total cap (SPEND_CAP_USD). Raise the total cap to spend more.`;
}
export function guard(estimateUsd = 0) {
  budget.guard(estimateUsd);
  const cap = spendCapUsd();
  if (cap == null) return;
  const usd = spent();
  if (usd >= cap || usd + estimateUsd > cap) throw new Error(spendCapMessage(usd, cap));
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
  l.calls = (l.calls ?? 0) + 1;
  const key = `${PROVIDER.id}/${modelId}`;
  const b = ((l.byModel ??= {})[key] ??= { usd: 0, input: 0, output: 0, calls: 0 });
  b.usd += usd; b.input += inTok; b.output += outTok; b.calls += 1;
  writeFileSync(ledgerPath(), JSON.stringify(l, null, 2));
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
