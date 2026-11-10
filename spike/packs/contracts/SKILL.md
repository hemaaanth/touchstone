---
name: contracts
description: Audit Solidity contracts and prove each bug with an offline Foundry test.
tier: P
proof: forge
tools: [list_sources, read_source, static_findings, fuzz_findings, fetch_source, run_poc, submit_finding]
labs: [lab/vault-reentrancy, lab/vault-accounting, lab/vault-multi]
---

# Contracts

The agent audits Solidity code that the operator owns. It proves each bug with a
Foundry test that runs offline in Docker. A finding is real only when that test
replays green and shows the harm.

## Inputs

- A lab: the code is in `src/`.
- A brief: `BRIEF.md` links the code. The agent calls `fetch_source`. The code
  lands in `vendor/`.

## Pre-pass

Before the agent starts, two ensembles scan the code. Each gives leads, never
findings.

- Static: Slither and Aderyn. A spot both flag ranks higher.
- Fuzz: Echidna and Medusa run one invariant harness. An invariant both break
  ranks higher. The lead comes with the call sequence that broke it.

A brief has no local code at the start, so both ensembles are off for a brief.

## Steps

1. Read the code and the leads. List every suspect root cause, worst first.
2. For each suspect, write a Foundry test and run it with `run_poc`. Use at most
   3 attempts per suspect.
3. When a test passes and shows the harm, call `submit_finding`. Then go on to
   the next suspect.
4. End with one coverage line per suspect: proven, not exploitable, or not tried.

## Oracle

`submit_finding` refuses a test that has not passed in this run. When the run
settles, the engine replays each submitted test once more with `--json -vvvv`.
It records who gained and who lost funds. A test that does not replay green is
not a finding.

## Limits

- No chain fork and no live network. The proof deploys the code in a local EVM.
- Solidity only. Vyper, Move, Rust (NEAR, Solana) and Cairo are not covered yet.
  See TOOLS.md.
