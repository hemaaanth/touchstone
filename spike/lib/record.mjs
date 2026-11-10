// Turn the agent's submitted findings into recorded findings.
//
// One audit can submit several findings. Each one names its own passing test
// contract and carries the exact source that passed. Here we replay each test one
// more time in JSON trace mode (lib/proof.mjs) to read the money it really moved.
// The CLI and the web server both call this, so both record the same shape.
import { proofDelta } from "./proof.mjs";

const RANK = { critical: 0, high: 1, medium: 2, low: 3 };

// Lower is worse. Unknown labels sort after "low".
export function severityRank(s) {
  return RANK[String(s ?? "").toLowerCase()] ?? 4;
}

// Worst first; ties keep the order the agent submitted them.
export function sortFindings(list) {
  return [...list].sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || (a.n ?? 0) - (b.n ?? 0));
}

// submitted: [{ n, title, severity, poc, explanation, source }] from the engine.
// events: every engine event, used to check that the named test really passed.
// Returns the findings worst first, each with its own replay proof (or null).
export async function proveFindings(ws, submitted, events, log = () => {}) {
  const out = [];
  for (const f of sortFindings(submitted ?? [])) {
    const pocProved = events.some((e) => e.ev === "run_poc-done" && e.passed && e.contract === f.poc);
    let proof = null;
    if (pocProved && f.source) {
      try {
        const delta = await proofDelta(ws, { source: f.source, contract: f.poc });
        // The kind names the replay that made this proof; the app picks its card from it.
        proof = delta && { kind: "forge", ...delta };
      } catch (err) {
        log(`proof-delta failed for ${f.poc}: ${String(err?.message || err).slice(0, 200)}`);
      }
    }
    out.push({ n: f.n, title: f.title, severity: f.severity, poc: f.poc, explanation: f.explanation, pocProved, proof });
  }
  return out;
}
