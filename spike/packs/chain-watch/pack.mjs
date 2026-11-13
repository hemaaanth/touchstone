// The Chain watch pack (module M9): watch a local block range for admin changes
// and prove the harm with an offline Foundry test.
//
// The prepass starts Anvil with no network, runs a proxy through a series of admin
// changes, and reads the range two ways: a state diff (EIP-1967 slots, owner,
// roles) and Forta's log filter. A change both see is a stronger lead. A change
// with no event shows only in the state diff. The agent writes a test that shows
// the change and its harm. See SKILL.md and TOOLS.md.
import { chainNudge, chainPrepass, chainTools, proveWithHarm, watchLeads, hasWorld, sourceKickoff, sourceSystem } from "../keys/common.mjs";

const SYSTEM = `You are an authorized offensive-security agent in an isolated sandbox.
The target is a proxy contract that the operator owns. A monitor watched a range of
local blocks. Your job: find every admin change that matters (a proxy upgrade, an
owner change, a role grant) and PROVE its harm with a runnable Foundry test.

Rules of the environment:
- The sandbox has no network. forge-std is vendored. Solidity is 0.8.38.
- list_sources and read_source show the lab code under src/. ChainWatchLab.sol is the
  proxy, with the benign and the drain implementations.
- chain_state returns what the lab recorded for the block range: a snapshot of the
  implementation slot, admin slot, owner and role state at each block, the logs, the
  transactions, and the proxy balance.
- watch_leads returns ranked leads from two engines: our state diff and Forta's event
  filter. A change both engines saw is marked AGREE. A change with no event shows only
  in the state diff. A lead is only a lead. It counts when your test proves it.
- Write a test (a contract that imports forge-std/Test.sol) and run it with run_poc.
  Rebuild the lab in setUp, replay the change, and show the harm. A proof passes AND
  shows harm: ETH leaves the proxy to an attacker address because of the change.
- How the harm is measured: the engine replays your test and totals the ETH that moved.
  The victim must LOSE ETH in that replay, and some other address must GAIN it. So fund
  the victim with vm.deal AFTER you create it. Never fund it with a payable
  constructor ({value: ...}), a call with value, or a transfer from an account: that
  ETH comes back out and the victim nets to zero. The proof then fails.
- Control also counts. The engine reads the storage writes of the replay. A proof is also
  real when the replay changes the EIP-1967 implementation slot, the EIP-1967 admin slot,
  or the owner (slot 0) of the lab proxy, with no ETH moved. Make the change as the actor
  the lead names, with vm.prank, through the proxy's own functions. The caller must be an
  outsider. When the owner or admin hands over control, that is a legitimate change and the
  engine rejects it. Do not use vm.store (vm.store is not counted). A test that only reads state and changes nothing still fails.
- When a proof passes, call submit_finding with a title, severity, the name of the
  passing test contract, and a short explanation.

How the audit works:
- One finding per ROOT CAUSE. One fix closes one finding. If fixing A also stops B,
  then B is part of A's impact. Do not write a second test for it.
- Plan first. List each suspect change, worst first, in your reply.
- Spend at most 3 run_poc attempts on one suspect. If it still fails, mark it "not
  proven" and move on.
- Use a NEW test contract name for each suspect.
- The moment a test passes, call submit_finding. Then CONTINUE with the next suspect.
- Not findings: a change the owner is allowed to make that cannot hurt anyone, such as
  a role that was granted and then revoked. A probe that reads state and changes nothing
  is not a finding.
- Stop when every suspect is proven or ruled out, or the budget is spent. Then write a
  short coverage summary: one line per suspect, marked "proven", "not exploitable", or
  "not tried".

Severity:
- critical: an attacker can drain the proxy now, because of the change.
- high: a change gives an attacker control (admin, owner or upgrade right) with no
  drain shown yet.
- medium: a risky change that needs another step.
- low: a note with no direct loss of funds.

Write each explanation so a smart 15-year-old with no security background can follow
it. Use Simplified Technical English: short sentences, one idea per sentence, plain
words. Put identifiers in \`backticks\` and every multi-line code snippet in a fenced
block whose opening fence names the language. End with a line that starts with "Fix:".
Keep going without asking the operator questions. Work from the actual lab.`;

const kickoff = (ws, env) => {
  if (!hasWorld(ws, "chain-watch")) return sourceKickoff("chain-watch", env.CHAIN_BRIEF);
  const base = "Review the watched block range for this proxy. Call watch_leads and chain_state, read the lab source, list every suspect change worst first, then prove each one you can with its own passing Foundry test that replays the change and moves ETH out of the proxy. Submit each proven finding as soon as its test passes. End with the coverage summary.";
  return env.CHAIN_BRIEF
    ? `${base}\n\n${env.CHAIN_BRIEF}\n\nThese are leads from the state diff, Forta, source checks and Aderyn, scariest first. A lead is real only once your test proves it. Call watch_leads for the full list. Some leads come from source checks and Aderyn. They are guesses from the code text. Drop one fast if it cannot move ETH or change control. Do not reason at length: write your first test as soon as you know the setup.`
    : base;
};

export default {
  id: "chain-watch",
  title: "Chain watch",
  tier: "P", // passive: Anvil runs only in our offline sandbox
  proof: "forge",
  // No tool reaches a network. The Modules page reads this.
  offline: true,
  system: (ws) => (hasWorld(ws, "chain-watch") ? SYSTEM : sourceSystem("chain-watch")),
  tools: (ws, state) => chainTools(ws, state, {
    mode: "chain-watch",
    stateTool: { name: "chain_state", description: "Read what the lab recorded for the watched block range: per-block snapshots of the EIP-1967 implementation and admin slots, the owner and role state, the logs, the transactions, the proxy balance and the canary wallet." },
    leadsTool: { name: "watch_leads", description: "Read the ranked leads for the block range from two engines: our state diff and Forta's event filter. A change both saw is marked AGREE. A change with no event shows only in the state diff. A lead is only a lead: prove it with run_poc." },
    analyze: watchLeads,
    empty: "The monitor saw no admin change in this range. Read the source and the state directly.",
  }),
  kickoff,
  nudge: (state) => chainNudge(state, "suspect"),
  prepass: (ws, ctx) => chainPrepass(ws, ctx, { mode: "chain-watch", analyze: watchLeads }),
  prove: proveWithHarm,
};
