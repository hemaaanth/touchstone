# Contracts: integration research

This is the worked example of the table in `packs/README.md`. Licenses marked
"check" must be confirmed against the upstream repo before a release.

## Wrapped today

| Tool | License | Runs as | Offline | Input | Output | Lead | Proof | Overlap | Lift | Crypto gap | Verdict |
|------|------|------|------|------|------|------|------|------|------|------|------|
| Foundry (forge) | MIT or Apache-2.0 | `ghcr.io/foundry-rs/foundry:latest`, 865 MB | Yes, with the warmed solc volume | Workspace with `test/` | `forge test --json -vvvv` | The proof itself, not a lead | `forge`: the test replays green; the trace shows funds move | None | Cheatcodes and trace format | We add the per-finding gate and the money-moved table | wrap |
| Slither | AGPL-3.0 | `ghcr.io/trailofbits/eth-security-toolbox:nightly`, 1.38 GB | Yes | `src/` as one unit | `--json` | detector → check, impact, lines | `forge` | Aderyn | Detector list as check names | No economic or cross-contract logic | ensemble |
| Aderyn | GPL-3.0 (check) | Pinned host binary `tools/bin/aderyn` | Yes | Whole project via `foundry.toml` | JSON report | issue → check, impact, lines | `forge` | Slither | None yet | Same as Slither | ensemble |
| Echidna | AGPL-3.0 | Toolbox image | Yes | Generated invariant harness | Text, parsed | broken property → check, call sequence | `forge` | Medusa | None yet | Only the invariants our template writes | ensemble |
| Medusa | AGPL-3.0 | Toolbox image | Yes | Same harness, `medusa.json` | Text, parsed | Same as Echidna | `forge` | Echidna | None yet | Same as Echidna | ensemble |

## Gaps in our wrapping

- Aderyn runs on the host, not in Docker. Untrusted code is parsed outside the
  sandbox. Move it into a container.
- The fuzz template covers vault accounting only. Other targets get no fuzz leads.

## Candidates from the research (03-capabilities.md M5–M8, 04-crypto-coverage.md, 07-gap-3)

To fill in before the Contracts wave adds them.

| Tool | Why | Open questions |
|------|-----|----------------|
| Halmos | Symbolic tests in Foundry syntax. Proves or refutes a property. | Image, run time, output format. |
| Mythril | Symbolic execution on bytecode. Finds paths Slither misses. | Speed on real repos. Noise. |
| Heimdall | Decompiles bytecode when there is no source. | Lead quality. |
| Wake | Python test and detector framework. | Overlap with Slither. |
| Chimera (Recon) | One property suite runs on Echidna, Medusa, Halmos and Foundry. Fixes the vault-only fuzz template. | License. Whether the agent can write properties well. |
| Semgrep (Solidity rules) | Fast pattern rules. Custom crypto rules are easy to add. | Rule pack license. |
| 4naly3er | Gas and low findings report. | Low value for exploits. Maybe skip. |
| Vyper, Move, Cairo, Rust (NEAR, Solana) analyzers | Non-EVM chains. | One row per chain. See 07-gap-3 for ZK and MPC. |
