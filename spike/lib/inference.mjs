// Raw inference client + spend ledger for the ACTIVE provider (see providers.mjs).
//
// BASE_URL, MODELS and the key come from the provider active when this module
// loads: PROVIDER=<id>, else the Settings default. Each engine run is a fresh
// process, so this snapshot is that run's provider and budget.
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FALLBACK_PRICE, activeProvider, readConfig, runBudgetUsd, providerKey } from "./providers.mjs";
import { createRunBudget } from "./run-budget.mjs";

const budget = createRunBudget(process.env.RUN_BUDGET_USD ?? runBudgetUsd(), process.env.RUN_SPENT_USD ?? 0);
export const runSpend = () => ({ usd: budget.usd, budgetUsd: budget.limit });

const PROVIDER = activeProvider();

export const PROVIDER_ID = PROVIDER.id;
export const PROVIDER_LABEL = PROVIDER.label;
export const BASE_URL = PROVIDER.baseUrl;
export const MODELS = PROVIDER.models;

// SPEND_LEDGER points every worktree at one shared ledger. The total spend cap
// stops a call once the shared lifetime total reaches it. Both are read on every
// call, so a test or a server can change them without a reload.
const ledgerPath = () => {
  const p = process.env.SPEND_LEDGER || new URL("../spend.json", import.meta.url);
  return p instanceof URL ? fileURLToPath(p) : p;
};

export function key() {
  const k = providerKey(PROVIDER);
  if (!k) {
    throw new Error(`No API key for provider "${PROVIDER.id}". Add it in Settings${PROVIDER.keyEnv ? ` or set ${PROVIDER.keyEnv}` : ""}.`);
  }
  return k;
}

// ---- Spend ledger. One global ledger across providers; every paid call goes
// through charge(). guard() stops a call once the ledger total reaches the cap.
//
// Fail closed: a ledger that cannot be read, is not JSON, or has no numeric
// totalUsd throws. It never reads as $0 spent. A missing file is a fresh ledger
// (with a warning, so a deleted ledger is noticed).
// Every cap message says "out of budget": pi-ai's retry check never retries a
// message with those words, even when an amount such as $500 looks like an HTTP
// status. So a cap stop is never retried.
const OUT = "This call is out of budget.";
let warnedMissing = false;
function readLedger() {
  const file = ledgerPath();
  if (!existsSync(file)) {
    if (!warnedMissing) console.warn(`[inference] no spend ledger at ${file}; starting a new one at $0`);
    warnedMissing = true;
    return { totalUsd: 0, calls: 0, byModel: {} };
  }
  let l;
  try {
    l = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    l = null;
  }
  if (!l || typeof l !== "object" || typeof l.totalUsd !== "number" || !Number.isFinite(l.totalUsd) || l.totalUsd < 0) {
    throw new Error(`The spend ledger (${file}) is unreadable or corrupt, so the total spend cap cannot be checked. ${OUT} Fix or restore the ledger before spending more.`);
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

// Many processes share the ledger (fleet children, parallel app runs). Each
// charge is a read-modify-write, so it runs under a lock file, and the new
// ledger is written to a temp file and renamed over the old one. A reader never
// sees a half-written file, and no charge is lost. A lock older than
// LOCK_STALE_MS is left by a dead process and is removed.
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function withLedgerLock(file, fn) {
  const lock = `${file}.lock`;
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock); } catch { /* gone already */ }
      if (Date.now() > until) throw new Error(`Could not lock the spend ledger (${lock}) to record a charge. ${OUT} Remove the lock file if no run is active.`);
      sleepMs(2 + Math.random() * 8);
    }
  }
  try {
    return fn();
  } finally {
    try { unlinkSync(lock); } catch { /* already removed */ }
  }
}

// The total spend cap. It is the config's spendCapUsd, else DEFAULT_SPEND_CAP_USD,
// so the CLI has a cap too. SPEND_CAP_USD can only lower it. A value that is set
// but is not a positive finite number throws: it is never "no limit".
export const DEFAULT_SPEND_CAP_USD = 50.85;
const positive = (raw) => typeof raw !== "boolean" && Number.isFinite(Number(raw)) && Number(raw) > 0;
export function spendCapUsd(cfg = readConfig(), raw = process.env.SPEND_CAP_USD) {
  const fromCfg = cfg?.spendCapUsd;
  if (fromCfg != null && !positive(fromCfg)) {
    throw new Error(`spendCapUsd in the provider config is "${fromCfg}", which is not a positive dollar amount, so the total spend cap cannot be checked. ${OUT}`);
  }
  const cap = fromCfg == null ? DEFAULT_SPEND_CAP_USD : Number(fromCfg);
  if (raw == null || String(raw).trim() === "") return cap;
  if (!positive(raw)) {
    throw new Error(`SPEND_CAP_USD is set to "${raw}", which is not a positive dollar amount, so the total spend cap cannot be checked. ${OUT}`);
  }
  return Math.min(cap, Number(raw));
}
export function spendCapMessage(usd, cap) {
  return `Total spend cap reached: the ledger shows $${usd.toFixed(4)} of the $${cap.toFixed(2)} total cap (SPEND_CAP_USD). ${OUT} Raise the total cap to spend more.`;
}
export function guard(estimateUsd = 0) {
  budget.guard(estimateUsd);
  capGuard(estimateUsd);
}
// The total cap alone. For spend outside this process's run budget, such as a
// Strix scan, which in the app runs inside the long-lived server process.
export function capGuard(estimateUsd = 0) {
  if (!Number.isFinite(estimateUsd) || estimateUsd < 0) throw new Error(`Invalid call estimate: ${estimateUsd}. ${OUT}`);
  const cap = spendCapUsd();
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
  record(modelId, usd, inTok, outTok);
  return usd;
}
// Spend priced elsewhere, such as Strix's own model calls. The ledger only:
// it is not this process's run spend (see capGuard).
export function ledgerCharge(modelId, usd) {
  if (!(usd > 0)) return 0;
  record(modelId, usd, 0, 0);
  return usd;
}
function record(modelId, usd, inTok, outTok) {
  const file = ledgerPath();
  withLedgerLock(file, () => {
    const l = readLedger();
    l.totalUsd += usd;
    l.calls = (l.calls ?? 0) + 1;
    const key = `${PROVIDER.id}/${modelId}`;
    const b = ((l.byModel ??= {})[key] ??= { usd: 0, input: 0, output: 0, calls: 0 });
    b.usd += usd; b.input += inTok; b.output += outTok; b.calls += 1;
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(l, null, 2));
    renameSync(tmp, file);
  });
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
