// Turn the agent's submitted findings into recorded findings.
//
// One audit can submit several findings. Each one names its own passing test
// contract and carries the exact source that passed. Here we replay each test one
// more time in JSON trace mode (lib/proof.mjs) to read the money it really moved
// and the target storage it changed. A finding is proven only when that replay
// shows harm to a scope target.
// The CLI and the web server both call this, so both record the same shape.
//
// The workspace is deleted after this returns. snapshotForgeReplay copies the
// proof test, the scope sources, and foundry.toml first, so a later report
// export can zip them. storeReplayFiles writes those files to the results
// folder (replay/<sha256>.json); the proof keeps the hash and the paths only.
// The snapshot never includes a provider key or a bearer token.
import { proofDelta } from "./proof.mjs";
import { snapshotForgeReplay, storeReplayFiles } from "./replay-bundle.mjs";

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
// Each recorded finding keeps `source`, the exact test the replay ran. A fleet
// child's run_poc is not in the root transcript, and the workspace is deleted
// after this returns, so the report can show that test only if it is stored now.
//
// A passing test is NOT enough. `forgePassed` records that Foundry passed the
// named test. `pocProved` is true only when the final replay also passed AND its
// harm verdict is ok (lib/proof.mjs judgeHarm: the test called a scope target and
// either drained its ETH or wrote its storage). `judge(proof)` lets a pack with a
// lab model replace the generic verdict with its own (keys, chain-watch).
// `stateTrace` keeps the large controlTrace on the proof for that judge.
export async function proveFindings(ws, submitted, events, log = () => {}, { stateTrace = false, judge = null } = {}) {
  const out = [];
  for (const f of sortFindings(submitted ?? [])) {
    const forgePassed = events.some((e) => e.ev === "run_poc-done" && e.passed && e.contract === f.poc);
    let proof = null;
    if (forgePassed && f.source) {
      try {
        const delta = await proofDelta(ws, { source: f.source, contract: f.poc, stateTrace });
        // The kind names the replay that made this proof; the app picks its card from it.
        // The replay snapshot is taken here, while `ws` still has the sources.
        if (delta) {
          let replay = null;
          try {
            // Snapshot the proof's sources and store them. The offline re-run
            // check (verifyForgeReplay) is NOT run here: it must not delay
            // recording. recordReplayReruns runs it after the record is written
            // and patches rerun onto the replay (see agent-run.mjs / runs.mjs).
            replay = storeReplayFiles(snapshotForgeReplay(ws, { contract: f.poc, test: delta.test }));
            if (replay?.filesLost) log(`replay snapshot for ${f.poc}: ${replay.filesLost}`);
          } catch (err) {
            log(`replay snapshot failed for ${f.poc}: ${String(err?.message || err).slice(0, 200)}`);
          }
          proof = gate({ kind: "forge", ...delta, ...(replay ? { replay } : {}) }, judge);
        }
      } catch (err) {
        log(`proof-delta failed for ${f.poc}: ${String(err?.message || err).slice(0, 200)}`);
      }
    }
    const pocProved = forgePassed && proof?.pass === true && proof?.harm?.ok === true;
    // The submitted test, not proof.source (that label is "engine-replay").
    const source = typeof f.source === "string" && f.source.trim() ? f.source : undefined;
    out.push({ n: f.n, title: f.title, severity: f.severity, poc: f.poc, explanation: f.explanation, forgePassed, pocProved, proof, ...(source ? { source } : {}) });
  }
  return out;
}

// Apply the harm verdict to one replay proof. A replay that passed but shows no
// harm is recorded as a failed proof, with the reason, so every reader agrees.
export function gate(proof, judge = null) {
  const harm = (judge ? judge(proof) : proof.harm) ?? { ok: false, reason: "the replay produced no harm verdict" };
  const out = { ...proof, harm };
  if (out.pass && !harm.ok) Object.assign(out, { status: "fail", pass: false, reason: harm.reason });
  return out;
}
