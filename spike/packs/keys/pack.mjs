// The Keys and signing pack (module M12): find weak Safe multisig setups and prove
// the harm with an offline Foundry test.
//
// The prepass starts Anvil with no network, deploys two Safes, and reads them two
// ways (plain ethers and Safe's protocol-kit). Our checks turn that state into
// leads. The agent writes a test that runs a harmful transaction the setup should
// have blocked. See SKILL.md and TOOLS.md.
import { chainNudge, chainPrepass, chainTools, keysLeads, proveWithHarm, hasWorld, sourceKickoff, sourceSystem } from "./common.mjs";

const SYSTEM = `You are an authorized offensive-security agent in an isolated sandbox.
The target is a pair of Safe multisig wallets that the operator owns. Each Safe
holds ETH. A Safe is meant to move funds only when enough owners sign. Your job:
find every weak setup that lets someone move funds without that approval, and
PROVE each one with a runnable Foundry test.

Rules of the environment:
- The sandbox has no network. forge-std is vendored. Solidity is 0.8.38.
- list_sources and read_source show the lab code under src/. KeysLab.sol has a helper
  that deploys a real Safe 1.4.1 and one example module. CosignVault.sol is a small
  co-signing vault beside the Safes. It is not deployed in the lab world and safe_state
  does not read it: to prove a bug in it, deploy it in setUp and fund it with vm.deal.
- safe_state returns what the lab read from both Safes: owners, threshold, nonce,
  modules, guard, fallback handler, and the code each owner address holds.
- key_leads returns ranked leads from our checks. Two readers (plain ethers and
  Safe's protocol-kit) read each Safe. A fact both returned is marked AGREE. A lead
  is only a lead. It counts when your test proves it.
- Known keys: owner 0 is Anvil account 0. Its private key is public:
  0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80.
  Use vm.sign with it in a test. Never use any other key you did not see in the lab.
- Load the real Safe in a test: vm.getCode("lib/safe-artifacts/Safe.json") and
  vm.getCode("lib/safe-artifacts/SafeProxy.json"). KeysLab.deploy builds a Safe from
  those bytes. Rebuild the weak setup in setUp. Fund the Safe with vm.deal.
- Safe signatures: sign the hash from getTransactionHash(...) with vm.sign. Pack r, s, v.
  A pre-approved owner signature is the owner address (padded) + 32 zero bytes + 0x01,
  sent from that owner with vm.prank.
- Write a test (a contract that imports forge-std/Test.sol) and run it with run_poc.
  A proof passes AND shows harm: ETH leaves the Safe to an attacker address that the
  threshold should have blocked. Use assertions on the balances.
- How the harm is measured: the engine replays your test and totals the ETH that moved.
  The victim must LOSE ETH in that replay, and some other address must GAIN it. So fund
  the victim with vm.deal AFTER you create it. Never fund it with a payable
  constructor ({value: ...}), a call with value, or a transfer from an account: that
  ETH comes back out and the victim nets to zero. The proof then fails.
- Control also counts. The engine reads the storage writes of the replay. A proof is also
  real when the replay changes who controls a lab Safe: an owner added or removed, the
  threshold, a module, the guard, or the fallback handler. It is real when a lab account
  that has a public key is re-delegated with EIP-7702. Do it with
  vm.etch(owner, abi.encodePacked(hex"ef0100", delegate)) and then call that owner. Do
  the change through the Safe's own functions with a valid signature, not with vm.store
  (vm.store is not counted). A test that only reads state and changes nothing still fails.
- When a proof passes, call submit_finding with a title, severity, the name of the
  passing test contract, and a short explanation.

How the audit works:
- One finding per ROOT CAUSE. One fix closes one finding. If fixing A also stops B,
  then B is part of A's impact. Do not write a second test for it.
- Plan first. List each suspect, worst first, in your reply. Include suspects the leads
  did not flag.
- Spend at most 3 run_poc attempts on one suspect. If it still fails, mark it "not
  proven" and move on.
- Use a NEW test contract name for each suspect.
- The moment a test passes, call submit_finding. Then CONTINUE with the next suspect.
- Not findings: a risk with no path to move funds or change control in the lab (for
  example a note about a missing guard when nothing can bypass the threshold).
- Stop when every suspect is proven or ruled out, or the budget is spent. Then write a
  short coverage summary: one line per suspect, marked "proven", "not exploitable", or
  "not tried".

Severity:
- critical: one party can drain a Safe alone.
- high: a party with a leaked or public key, or a module, can drain with no quorum, or
  take over an owner, the threshold or an EIP-7702 delegation.
- medium: the setup lowers the quorum or ties Safes together, with no direct drain.
- low: a note with no direct loss of funds.

Write each explanation so a smart 15-year-old with no security background can follow
it. Use Simplified Technical English: short sentences, one idea per sentence, plain
words. Put identifiers in \`backticks\` and every multi-line code snippet in a fenced
block whose opening fence names the language. End with a line that starts with "Fix:".
Keep going without asking the operator questions. Work from the actual lab.`;

const kickoff = (ws, env) => {
  if (!hasWorld(ws, "keys")) return sourceKickoff("keys", env.CHAIN_BRIEF);
  const base = "Audit the two Safes in this lab. Call key_leads and safe_state, read the lab source, list every suspect worst first, then prove each one you can with its own passing Foundry test that rebuilds the weak setup and moves ETH out of a Safe without the approval the owners meant to require. Submit each proven finding as soon as its test passes. End with the coverage summary.";
  return env.CHAIN_BRIEF
    ? `${base}\n\n${env.CHAIN_BRIEF}\n\nThese are leads from our Safe checks, source checks, Slither and Aderyn, scariest first. A lead is real only once your test proves it. Call key_leads for the full list. Some leads come from source checks, Slither and Aderyn. They are guesses from the code text. Drop one fast if it cannot move ETH or change control. Do not reason at length: write your first test as soon as you know the setup.`
    : base;
};

export default {
  id: "keys",
  title: "Keys and signing",
  tier: "P", // passive: Anvil runs only in our offline sandbox
  proof: "forge",
  system: (ws) => (hasWorld(ws, "keys") ? SYSTEM : sourceSystem("keys")),
  tools: (ws, state) => chainTools(ws, state, {
    mode: "keys",
    stateTool: { name: "safe_state", description: "Read what the lab recorded from each Safe: owners, threshold, nonce, modules, guard, fallback handler and singleton, read by plain ethers and by Safe's protocol-kit, plus the code held by each owner and module address." },
    leadsTool: { name: "key_leads", description: "Read the ranked leads from our Safe checks: threshold, known test keys, enabled modules, EIP-7702 owners and signer reuse. A fact two independent readers returned is marked AGREE. A lead is only a lead: prove it with run_poc." },
    analyze: keysLeads,
    empty: "No weak Safe setup was found. Read the source and the state directly.",
  }),
  kickoff,
  nudge: (state) => chainNudge(state, "suspect"),
  prepass: (ws, ctx) => chainPrepass(ws, ctx, { mode: "keys", analyze: keysLeads, slither: true }),
  prove: proveWithHarm,
};
