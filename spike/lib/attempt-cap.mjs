// Count caps on PoC and script attempts.
//
// The run's spend budget is the normal stop. inference.mjs checks it before
// every model call (RUN_BUDGET_USD, plus SPEND_CAP_USD for a shared wave). A
// count cap applies only when the operator sets one in env, for example
// MAX_POC=20 or MAX_HTTP_RUNS=12. With no value there is no count cap.
export function attemptCap(name, env = process.env) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === "") return Infinity;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number of 1 or more, got "${raw}".`);
  return n;
}

// Where the run's live spend comes from. agent-run.mjs sets it to
// inference.mjs runSpend, so this module does not load a provider itself.
let spend = null;
export const readSpendWith = (fn) => { spend = fn; };

const usd = (n) => `$${n.toFixed(2)}`;
function budgetLeft() {
  const s = spend?.();
  if (!s || !Number.isFinite(s.usd) || !Number.isFinite(s.budgetUsd)) return "The run's spend budget is the limit.";
  return `${usd(Math.max(0, s.budgetUsd - s.usd))} of the ${usd(s.budgetUsd)} run budget left.`;
}

// The line a tool shows the model about what is left. With no count cap it
// is the money left, because the budget is what stops the run.
export function leftText(cap, used, noun) {
  if (cap === Infinity) return budgetLeft();
  const left = Math.max(0, cap - used);
  return `${left} ${noun} attempt${left === 1 ? "" : "s"} left. ${budgetLeft()}`;
}

// The "left" number for the audit-continue event. Null means no count cap.
export const leftCount = (cap, used) => (cap === Infinity ? null : Math.max(0, cap - used));
