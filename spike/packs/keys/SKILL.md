---
name: keys
description: Find weak Safe multisig setups and prove each one with an offline Foundry test that moves funds the setup should have blocked.
tier: P
proof: forge
tools: [list_sources, read_source, safe_state, key_leads, run_poc, submit_finding]
labs: [lab]
---

# Keys and signing

The agent audits Safe multisig wallets that the operator owns. A Safe should move
funds only when enough owners sign. The agent looks for setups where that is not
true. It proves each one with a Foundry test. The test runs offline in Docker.

## Inputs

- A lab: `src/KeysLab.sol` deploys a real Safe 1.4.1. The pre-pass writes the
  Safe code to `lib/safe-artifacts/`. A test loads it with `vm.getCode`.
- A chain observation. The pre-pass writes `chain-observation.json` into the
  workspace. The agent reads it through `safe_state`.

## Pre-pass

Before the agent starts, a container with no network does four things:

1. It starts Anvil.
2. It deploys two Safes with weak setups.
3. It reads each Safe two ways: plain ethers, and Safe protocol-kit.
4. It writes the readings to `chain-observation.json`.

Our checks turn the readings into leads. A lead is never a finding.

| Check | Impact | What it means |
|-------|--------|---------------|
| `threshold-one` | High | One owner can move funds alone. |
| `threshold-below-majority` | Medium | Less than half of the owners can move funds. |
| `owner-known-key` | High | An owner address has a public private key (Anvil account 0). |
| `owner-7702-delegated` | High | An owner address holds EIP-7702 delegation code. The delegate controls it. |
| `owner-is-contract` | Low | An owner is a contract. Its signing rules are not the Safe's rules. |
| `module-enabled` | High | A module can move funds with no signatures. |
| `no-guard` | Low | No guard checks a transaction before it runs. |
| `fallback-handler-set` | Low | A fallback handler runs on calls the Safe does not know. |
| `old-safe-version` | Medium | The singleton is an old Safe version. |
| `signer-reuse` | Medium | One address is an owner of more than one Safe. One leaked key opens all of them. |

When both readers return the same fact, the lead is `corroborated` and ranks
first. A lead only one reader returned ranks lower.

## Steps

1. Call `safe_state` and `key_leads`. Read the lab code.
2. List every suspect, worst first. Add suspects the leads did not flag.
3. For each suspect, write a Foundry test and run it with `run_poc`. Use at most
   3 attempts per suspect.
4. When a test passes and shows the harm, call `submit_finding`. Go on to the
   next suspect.
5. End with one coverage line per suspect: proven, not exploitable, or not tried.

## Writing the proof

- Rebuild the weak setup in `setUp`. Use `KeysLab.deploy(singleton, proxy, owners, threshold)`.
- Fund the Safe with `vm.deal` after it is deployed. Never fund it with a call
  that sends ETH: the ETH comes back out and the Safe nets to zero.
- Known key: owner 0 is Anvil account 0. Use `vm.sign` with its public key.
- Signature: sign `getTransactionHash(...)`. Pack `r`, `s`, `v`.
- Pre-approved owner signature: the owner address padded to 32 bytes, then 32
  zero bytes, then `0x01`. Send it from that owner with `vm.prank`.
- Module: an enabled module calls `execTransactionFromModule`. No signature is
  needed.
- The test asserts that ETH left the Safe and an attacker address gained it.

## Oracle

`submit_finding` refuses a test that has not passed in this run. When the run
settles, the engine replays each test once more. A finding is real only when the test passes and the replay shows harm of one kind:

- `funds`: the Safe (a "Deployed contract" row, or a lab Safe address) lost ETH, and
  some other address gained ETH.
- `control`: the replay changed who controls a lab target. Safe owners, threshold,
  modules, guard or fallback handler, or EIP-7702 delegation code on a lab account.

The engine reads control changes from the replay state diff (`forge test -vvvvv`
storage writes). It does not read the test text. The result shows the field and the
slot that changed.

What does not count:

- A write made while the test deploys the Safe: a constructor, or Safe `setup` on a Safe
  the test made or a lab Safe it rebuilt.
- A write in a call that reverted.
- `vm.store`. It writes no step in the diff.
- A test that only reads state. It is marked failed.

A risk with no path to move funds or change control, like a missing guard, is a note
and not a finding.

The 7702 path: the vendored forge-std has no 7702 cheatcodes. The test calls
`vm.etch(owner, abi.encodePacked(hex"ef0100", delegate))` on a lab account, then calls
that account. A lab account is an owner with a public key, or an owner that already has
delegation code. A delegate that is already in place is not a change.

The setup path: a lab account that delegates to the Safe singleton has no Safe state.
A call to `setup()` on it makes the caller its owner. The replay shows owner, threshold
and handler writes at that account, so it counts as `control`.

## Limits

- Safe 1.4.1 only. Older singletons are not deployed in the lab.
- Local EVM only. No fork, no live network, no real keys.
- Hardware wallet, MPC and key-ceremony checks are not covered. See TOOLS.md.
