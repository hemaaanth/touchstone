---
name: chain-watch
description: Read an admin change in a local block range, raise leads from chain state, and prove the change and its harm with an offline Foundry test.
tier: P
proof: forge
tools: [list_sources, read_source, chain_state, watch_leads, run_poc, submit_finding]
labs: [lab]
---

# Chain watch

The agent reads what changed on a chain between two blocks. It looks for admin
changes: a proxy upgrade, an owner change, a role grant. It proves that the
change lets someone take funds. The proof is a Foundry test that runs offline in
Docker.

## Inputs

- A lab: `src/ChainWatchLab.sol` has an upgradeable proxy, a benign
  implementation, and a drain implementation. `src/VaultImplementationV2.sol` is a
  second implementation that holds ETH. Its `initialized` flag is never set.
- A chain observation. The pre-pass writes `chain-observation.json` into the
  workspace. The agent reads it through `chain_state`.

## Pre-pass

Before the agent starts, a container with no network does four things:

1. It starts Anvil and deploys the lab.
2. It sends a fixed list of transactions: a silent upgrade, an upgrade with an
   event, an admin change, a role grant, a role revoke, an owner transfer, and
   one move of a canary wallet.
3. It reads the chain two ways: our slot diff (EIP-1967 implementation and admin
   slots, owner, roles) and Forta's log filter.
4. It writes the readings to `chain-observation.json`.

Our checks turn the readings into leads. A lead is never a finding.

| Check | Impact | What it means |
|-------|--------|---------------|
| `implementation-changed` | High | The EIP-1967 implementation slot changed. |
| `admin-changed` | High | The EIP-1967 admin slot changed. |
| `owner-changed` | High | The owner changed. |
| `role-granted` | High | An address got a role. |
| `role-revoked` | Low | An address lost a role. |
| `canary-wallet-moved` | High | A wallet that should never move, moved. |
| `actor-correlation` | High | One address is behind two or more kinds of change. |

Two engines look at the same range. Our slot diff reads state. Forta reads
logs. When both see a change in the same block, the lead is `corroborated`. A
slot change with no log is a silent change. A monitor that reads only events
misses it. The lead says so.

## Source checks (any folder)

The pre-pass also reads `src/**/*.sol` with our own text checks. They need no lab world.
A real Foundry folder gets them too. Each lead names the contract, function, file and
line. A lead is never a finding. Slither and Aderyn run on the same source, in Docker with
no network. A lead two engines return is `corroborated`. Slither leads (for example
`uninitialized-state`) and Aderyn leads reach the agent in the brief.

| Check | Impact | What it means |
|-------|--------|---------------|
| `unprotected-control-function` | High | A function that changes an owner, admin, module, role or implementation has no caller check. |
| `unprotected-implementation-write` | High | A function writes the implementation slot with no caller check. |
| `silent-upgrade-path` | Medium | An upgrade path can run with no event. A monitor that reads events will miss it. |
| `uups-authorize-empty` | High | `_authorizeUpgrade` has an empty body and no access modifier. Anyone can upgrade. `internal override onlyOwner {}` is safe and raises no lead. |
| `initializer-unprotected` | High | An `initialize` function has no `initializer` guard or owner check. |
| `implementation-initializable` | Medium | An implementation can be initialized by anyone. |
| `delegatecall-user-target` | High | `delegatecall` goes to an address the caller picks. |
| `unprotected-selfdestruct` | High | `selfdestruct` has no caller check. |
| `tx-origin-auth` | High | `tx.origin` is used as an auth check. |
| `module-no-access-control` | High | `execTransactionFromModule` is callable with no caller check. |
| `ecrecover-zero-address` | High | `ecrecover` returns zero on a bad signature, and the result is not checked. |
| `signature-malleability` | Medium | The `s` value is not bounded, so a second valid signature exists. |
| `signature-replay-no-nonce` | High | A signed message has no nonce. It can be sent again. |
| `signature-no-domain` | Medium | A signed hash has no chain or contract domain. It replays across chains. |
| `hardcoded-private-key` | High | A private key is in the source. The lead shows it redacted. |

Vendored code under `lib`, `node_modules` and `vendor` is skipped.

## Steps

1. Call `chain_state` and `watch_leads`. Read the lab code.
2. List every suspect, worst first.
3. For each suspect, write a Foundry test and run it with `run_poc`. Use at most
   3 attempts per suspect.
4. When a test passes and shows the change and the harm, call `submit_finding`.
5. End with one coverage line per suspect: proven, not exploitable, or not tried.

## Writing the proof

- Deploy the proxy in `setUp`. Fund it with `vm.deal` after creation. Never fund it
  with `{value: ...}` or a transfer from an account: the ETH comes back out and the
  proxy nets to zero, so the oracle sees no harm.
- Make the admin change as the actor the lead names, with `vm.prank`.
- Assert the change: read the slot with `vm.load` or call the getter.
- Assert the harm: the attacker address gained ETH from the proxy.
- A silent upgrade also asserts that `vm.getRecordedLogs()` is empty.

## Oracle

`submit_finding` refuses a test that has not passed in this run. When the run
settles, the engine replays each test once more. A finding is real only when the test passes and the replay shows harm of one kind:

- `funds`: the proxy (a "Deployed contract" row, or the lab proxy address) lost ETH,
  and some other address gained ETH.
- `control`: the replay changed the EIP-1967 implementation slot, the EIP-1967 admin
  slot, or the owner (slot 0) of the lab proxy. In source mode (no lab) the slot-0 owner is not counted.

The engine reads control changes from the replay state diff (`forge test -vvvvv`
storage writes). It does not read the test text. The result shows the field and the
slot that changed. A write made while the test deploys the proxy, a write in a call
that reverted, and `vm.store` do not count.

A test that only reads state is marked failed. An admin change with no path to harm
and no control change in the replay is a note and not a finding.

## Limits

- Local Anvil only. No mainnet, no fork, no live RPC.
- Fixed transaction list. The agent reads a range. It does not send transactions
  on the lab chain.
- Alert delivery (Slack, pager) is not part of this pack. See TOOLS.md.
- Source checks read text, not a compiler tree. Strings and comments are blanked first, in one pass, so a `//` inside a string is safe.
- The caller gate is a small control-flow check. A `require` or `assert` on the caller gates the function wherever it stands, because a revert undoes earlier writes. An `if` gates only when its revert branch, or its block around every state write, dominates the write. A write before a non-reverting `if`, or outside it, is not gated.
- Known limits, documented and not chased: `else if` chains are judged by the text after `else`. A bare call statement counts as a write, so a lead stays alive when unsure. Helper calls such as `_checkOwner(` are trusted and not checked for position. A typehash written only inside a string no longer satisfies `signature-no-domain`. A lookup with the caller in a non-last bracket (`nest[msg.sender][1]`) is not a gate.

## Control harm needs an outsider

The owner or admin of a proxy may change the owner or admin. The engine rejects such a proof. It records the caller of each storage write and the owner and admin the proxy held just before it. A change by a caller that already held that role is not harm. Change control as an outsider, for example through the open `upgradeTo` and then an implementation that writes slot 0.

Authority means who could write the slot at that time, not who the value points at. A write teaches the engine a new owner or admin only when its writer is entitled: the constructor of that contract, a setUp fixture, a writer that already held the role, or the test contract writing an empty slot for the first time. An outsider's takeover is not adopted. So the next write by that outsider is still harm. A UUPS proxy keeps its owner in slot 0 with no admin slot. The same rule covers it, so the owner's own upgrade is clean in source mode.

Known limits: an OpenZeppelin 5 namespaced owner (not slot 0) is not tracked in source mode, so a legitimate owner upgrade there can be flagged. An initialization done as `vm.prank(owner); initialize(owner)` by a caller other than the test contract is not adopted.
