// Agent evidence is a separate verification method. It never sets oracle proof.
export const AGENT_FINDING_CAP = 3;
export const REPORT_FIELDS = ["attacker_capability", "observed_result", "harm", "limitations"];
export function agentReport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const steps = value.reproduction_steps;
  if (!Array.isArray(steps) || steps.length < 2 || steps.length > 12 || steps.some((s) => typeof s !== "string" || s.trim().length < 8 || s.length > 2000)) return null;
  if (REPORT_FIELDS.some((key) => typeof value[key] !== "string" || value[key].trim().length < 20 || value[key].length > 4000)) return null;
  return Object.fromEntries([["reproduction_steps", steps.map((s) => s.trim())], ...REPORT_FIELDS.map((key) => [key, value[key].trim()])]);
}
