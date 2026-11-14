// Agent evidence is a separate verification method. It never sets oracle proof.
//
// A cap exists because each report costs a human's review. Three was too tight on
// a large scope: DorkFi's run produced five distinct, evidenced root causes and
// two of them were marked "PROVEN, blocked from filing" in the write-up itself
// (2026-11-14). Twelve still bounds review while fitting a real contract audit.
export const AGENT_FINDING_CAP = 12;
export const REPORT_FIELDS = ["attacker_capability", "observed_result", "harm", "limitations"];
export function agentReport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const steps = value.reproduction_steps;
  if (!Array.isArray(steps) || steps.length < 2 || steps.length > 12 || steps.some((s) => typeof s !== "string" || s.trim().length < 8 || s.length > 2000)) return null;
  if (REPORT_FIELDS.some((key) => typeof value[key] !== "string" || value[key].trim().length < 20 || value[key].length > 4000)) return null;
  return Object.fromEntries([["reproduction_steps", steps.map((s) => s.trim())], ...REPORT_FIELDS.map((key) => [key, value[key].trim()])]);
}
