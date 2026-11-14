---
name: contracts
description: Audit Solidity contracts and prove each bug with an offline Foundry test.
tier: P
proof: forge
tools: [list_sources, read_source, static_findings, fuzz_findings, fetch_source, run_poc, submit_finding]
labs: [lab/vault-reentrancy, lab/vault-accounting, lab/vault-multi, lab/vault-bytecode]
---

# Contracts

The agent audits Solidity code that the operator owns. It proves each bug with a
Foundry test that runs offline in Docker. A finding is real only when that test
replays green and shows the harm.

## Inputs

- A lab: the code is in `src/`.
- A brief: the scope section of the agent's instructions links the code. The agent calls `fetch_source`. The code
  lands in `vendor/`.

## Pre-pass

Before the agent starts, two ensembles scan the code. Each gives leads, never
findings.

- Static: Slither and Aderyn, plus our own crypto source checks
  (`packs/keys/source-checks.mjs`, shared by three packs): unprotected privileged
  functions, unprotected initializers, a signature with no domain or nonce, a
  caller-chosen delegatecall. Slither and Aderyn do not model those rules at all,
  so a check only we have can outrank a generic alert. A spot two engines flag
  ranks higher.
- Fuzz: Echidna and Medusa run one invariant harness. An invariant both break
  ranks higher. The lead comes with the call sequence that broke it. The harness
  is the vault-solvency template only: a target that does not match it gets an
  explicit gap, never a silent "nothing broken".

A scan that read no file is reported as a gap (`STATIC_GAP`, `FUZZ_GAP`) in the
agent's first message and in the run's tools row. A gap is not a clean result.

A brief has no local code at the start, so both ensembles are off for a brief.

## Steps

1. Read the code and the leads.
2. Sweep the attack classes. `lib/attack-classes.mjs` lists them with a question
   per class. Answer every class: proven, not present, or not tried.
3. For each suspect, write a Foundry test and run it with `run_poc`. Use at most
   3 attempts per suspect.
4. When a test passes and shows the harm, call `submit_finding` with the class id
   from the sweep. Then go on to the next suspect.
5. End with one coverage line per class: proven, not present, or not tried.

## Oracle

`submit_finding` refuses a test that has not passed in this run. When the run
settles, the engine replays each submitted test once more with `--json -vvvv`.
It records who gained and who lost funds. A test that does not replay green is
not a finding.

Two oracles decide what "harm" means, and the run says which one judged it:

- **Deployed** (`lib/oracle-deployed.mjs`): a contract at a pinned address lost
  native ETH or an ERC-20, and another address gained it. Used when the scope
  carries a fork pin.
- **Scope code**: a contract the test deployed from source lost value or had a
  control slot repointed. Used for every offline run.

A cheatcode that fakes a target's state disqualifies it either way, and a test that
creates code at a pinned address is refused: on a fork those addresses already
exist.

## Limits

- A lab or a folder proves in a local EVM with no fork. A **forked** scope proves
  on a copy of a real chain at a pinned block, read through an RPC: the block is
  required, and the fork is read-only. Either way nothing signs or broadcasts.
- Solidity only. Vyper, Move, Rust (NEAR, Solana) and Cairo are not covered yet.
  See TOOLS.md.
