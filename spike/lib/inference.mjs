// Raw inference client + spend ledger for the ACTIVE provider (see providers.mjs).
//
// BASE_URL, MODELS and the key come from the provider active when this module
// loads: PROVIDER=<id>, else the Settings default. Each engine run is a fresh
// process, so this snapshot is that run's provider and budget.
import { appendFileSync, existsSync, linkSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
// A lock failure is not a cap stop, so it has its own sentence. "billing" also
// stops pi-ai's retry: a call whose cost was not recorded must not be repeated.
export const LEDGER_LOCKED = "The spend ledger stayed locked, so this call's cost was not recorded and no more billing is allowed.";
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
// sees a half-written file, and no charge is lost.
//
// The lock file holds its holder's pid. It is made whole in a temp file and
// hard-linked into place, so it is never seen empty. A lock is stale when its
// holder is dead, or when it is older than staleMs whatever its pid: a pid can
// be reused (or be pid 1 in a container), and a charge holds the lock for well
// under a millisecond, so a lock that old is stuck. Age is the inode's ctime,
// which the link sets and which a touch cannot set back. Only the holder of
// `${lock}.break` removes a stale lock, and it checks the lock again under
// that hold, so two processes cannot both remove it and then each take a lock.
// A `.break` older than staleMs was left by a process that died while it held
// it, and is removed. Two waiters that both see that old `.break` can both
// remove it and both hold a new one; the re-check then shields the lock except
// in the few microseconds between its read and its unlink. waitMs is longer
// than staleMs, so a waiter outlasts a stuck lock and still writes its charge.
// A holder that stalls longer than staleMs can lose its lock. Tests shorten
// both.
export const LEDGER_LOCK_MS = { waitMs: 45_000, staleMs: 30_000 };
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// Take `path` by linking the pid file to it. False when someone else has it.
function take(pidFile, path) {
  try { linkSync(pidFile, path); return true; } catch (err) { if (err.code === "EEXIST") return false; throw err; }
}
// The pid in a lock: a number, null when it has none, undefined when it is gone.
function holderOf(path) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return undefined; }
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}
function alive(pid) {
  // This code is synchronous and holds no lock while it waits, so a lock with
  // this process's pid is left from an earlier process that had the same pid.
  if (pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; }
}
// Milliseconds since the file at `path` was linked; -1 when it is gone.
function ageMs(path) {
  try { return Date.now() - statSync(path).ctimeMs; } catch { return -1; }
}
function stale(lock, pid) {
  if (pid === undefined) return false;
  if (ageMs(lock) > LEDGER_LOCK_MS.staleMs) return true;
  return pid !== null && !alive(pid);
}
function breakStale(lock, pidFile) {
  const pid = holderOf(lock);
  if (!stale(lock, pid)) return;
  const brk = `${lock}.break`;
  if (!take(pidFile, brk)) {
    // Another process is removing it, or died while it did.
    if (ageMs(brk) > LEDGER_LOCK_MS.staleMs) try { unlinkSync(brk); } catch { /* already removed */ }
    return;
  }
  try {
    // Still the same stale lock? A new holder's lock has a live pid.
    const again = holderOf(lock);
    if (again === pid && stale(lock, again)) unlinkSync(lock);
  } finally {
    try { unlinkSync(brk); } catch { /* already removed */ }
  }
}
function withLedgerLock(file, fn) {
  const lock = `${file}.lock`;
  const pidFile = `${lock}.${process.pid}.tmp`;
  writeFileSync(pidFile, String(process.pid));
  const until = Date.now() + LEDGER_LOCK_MS.waitMs;
  try {
    while (!take(pidFile, lock)) {
      breakStale(lock, pidFile);
      if (Date.now() > until) throw new Error(`Could not lock the spend ledger (${lock}) to record a charge. ${LEDGER_LOCKED} If no run is active, remove ${lock} and ${lock}.break.`);
      sleepMs(2 + Math.random() * 8);
    }
  } finally {
    try { unlinkSync(pidFile); } catch { /* already removed */ }
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
  // Record the charged response before its stdout event or durable session can
  // be interrupted. This cumulative value is the recovery budget floor.
  if (process.env.RUN_CHARGE_FILE) appendFileSync(process.env.RUN_CHARGE_FILE, JSON.stringify(runSpend()) + "\n");
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
