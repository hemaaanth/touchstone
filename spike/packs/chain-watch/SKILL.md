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
  implementation, and a drain implementation.
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
settles, the engine replays each test once more. A finding is real only when:

- The test passes.
- The proxy (a "Deployed contract" row) lost ETH.
- Some other address gained ETH.

An admin change with no path to harm is a note and not a finding.

## Limits

- Local Anvil only. No mainnet, no fork, no live RPC.
- Fixed transaction list. The agent reads a range. It does not send transactions
  on the lab chain.
- Alert delivery (Slack, pager) is not part of this pack. See TOOLS.md.
