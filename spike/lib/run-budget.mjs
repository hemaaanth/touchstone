// Budgets belong to a run, not the lifetime spend ledger. Check between calls:
// the final response can cost more than the amount left when it started.
export const DEFAULT_RUN_BUDGET_USD = 1;

export function validateRunBudget(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0.01 || n > 1000) {
    throw new Error("Run budget must be between $0.01 and $1,000.");
  }
  return n;
}

export function createRunBudget(limit, initial = 0) {
  const cap = validateRunBudget(limit);
  let usd = Number(initial);
  if (!Number.isFinite(usd) || usd < 0) throw new Error("Invalid run spend.");
  return {
    get limit() { return cap; },
    get usd() { return usd; },
    guard(estimate = 0) {
      if (!Number.isFinite(estimate) || estimate < 0) throw new Error("Invalid call estimate.");
      if (usd >= cap || usd + estimate > cap) {
        throw new Error(`Run budget reached: $${usd.toFixed(4)} spent of $${cap.toFixed(2)}. Start a new run to continue.`);
      }
    },
    charge(cost) {
      if (!Number.isFinite(cost) || cost < 0) throw new Error("Invalid call cost.");
      usd += cost;
    },
  };
}
