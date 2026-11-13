// The one call site where a property suite is judged before its results are
// trusted.
//
// A property tool (Halmos, Chimera) checks properties that someone wrote. A
// property can be vacuous: it may assert nothing, assume away every input, or
// never reach the code. A vacuous suite PASSES, and a pass then looks like
// "this code is safe". The vacuity gate decides if a suite is strong enough to
// trust. It checks that the suite reaches the code, that it kills mutants, and
// that it catches a known bug.
//
// The gate is built on branch pack/contracts-vacuity, in
// spike/packs/contracts/vacuity-gate/. It is not merged here. Until it is, this
// function FAILS CLOSED: every suite is untrusted. Then:
//   - a counterexample is a lead only. It can point the agent at a bug. It can
//     never support a proof. Only a replayed Foundry PoC makes a finding.
//   - a pass is "unverified". It never means "holds" or "not exploitable".
//
// When the gate merges, replace the body of suiteTrust with a call to it, for
// example `node vacuity-gate/gate.mjs --project <ws> --test <suite>`, and
// return trusted:true only when its verdict passes. Every caller already
// routes through here, so no other file needs to change.

export const GATE = "vacuity";

// Judge one suite. `tool` names the property tool ("Halmos", "Chimera").
// `suite` is the suite file, relative to the workspace. Returns
//   { trusted, gate, reason }
// trusted is false unless a merged gate said yes. Nothing else may set it.
export async function suiteTrust(ws, { tool, suite } = {}) {
  void ws;
  return {
    trusted: false,
    gate: GATE,
    reason: `vacuity gate not merged: ${tool ?? "the tool"}'s result for ${suite ?? "this suite"} is a lead only and cannot support a proof`,
  };
}
