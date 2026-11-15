// Budgets belong to a run, not the lifetime spend ledger. Check between calls:
// the final response can cost more than the amount left when it started.
export const DEFAULT_RUN_BUDGET_USD = 5;

export function validateRunBudget(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0.01 || n > 1000) {
    throw new Error("Run budget must be between $0.01 and $1,000.");
  }
  return n;
}

// `liveLimit` lets the cap move while a run works: a coordinator that finds
// something worth following can raise it (request_budget), and the next guard
// reads the new ceiling from the run's budget file.
export function createRunBudget(limit, initial = 0, liveLimit = null) {
  let cap = validateRunBudget(limit);
  const read = () => {
    if (!liveLimit) return cap;
    let v;
    try { v = liveLimit(); } catch { return cap; }
    if (v != null && Number.isFinite(Number(v))) cap = validateRunBudget(Number(v));
    return cap;
  };
  let usd = Number(initial);
  if (!Number.isFinite(usd) || usd < 0) throw new Error("Invalid run spend.");
  return {
    get limit() { return read(); },
    get usd() { return usd; },
    guard(estimate = 0) {
      if (!Number.isFinite(estimate) || estimate < 0) throw new Error("Invalid call estimate.");
      const ceiling = read();
      if (usd >= ceiling || usd + estimate > ceiling) {
        throw new Error(`Run budget reached: $${usd.toFixed(4)} spent of $${ceiling.toFixed(2)}. Ask for more with request_budget, or start a new run.`);
      }
    },
    charge(cost) {
      if (!Number.isFinite(cost) || cost < 0) throw new Error("Invalid call cost.");
      usd += cost;
    },
  };
}
