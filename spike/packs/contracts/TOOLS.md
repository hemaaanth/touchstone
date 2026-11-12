# Contracts: integration research

This is the worked example of the table in `packs/README.md`. Licenses marked
"check" must be confirmed against the upstream repo before a release.

## Wrapped today

| Tool | License | Runs as | Offline | Input | Output | Lead | Proof | Overlap | Lift | Crypto gap | Verdict |
|------|------|------|------|------|------|------|------|------|------|------|------|
| Foundry (forge) | MIT or Apache-2.0 | `ghcr.io/foundry-rs/foundry:latest`, 865 MB | Yes, with the warmed solc volume | Workspace with `test/` | `forge test --json -vvvv` | The proof itself, not a lead | `forge`: the test replays green; the trace shows funds move | None | Cheatcodes and trace format | We add the per-finding gate and the money-moved table | wrap |
| Slither | AGPL-3.0 | `ghcr.io/trailofbits/eth-security-toolbox:nightly`, 1.38 GB | Yes | `src/` as one unit | `--json` | detector → check, impact, lines | `forge` | Aderyn | Detector list as check names | No economic or cross-contract logic | ensemble |
| Aderyn | GPL-3.0 (check) | `touchstone/aderyn:0.6.8`, built by `tools/build-aderyn-image.sh` (pinned binary, solc baked in) | Yes | Whole project via `foundry.toml` | JSON report | issue → check, impact, lines | `forge` | Slither | None yet | Same as Slither | ensemble |
| Echidna | AGPL-3.0 | Toolbox image | Yes | Generated invariant harness | Text, parsed | broken property → check, call sequence | `forge` | Medusa | None yet | Only the invariants our template writes | ensemble |
| Medusa | AGPL-3.0 | Toolbox image | Yes | Same harness, `medusa.json` | Text, parsed | Same as Echidna | `forge` | Echidna | None yet | Same as Echidna | ensemble |

## Gaps in our wrapping

- Aderyn runs on the host, not in Docker. Untrusted code is parsed outside the
  sandbox. Move it into a container.
- The fuzz template covers vault accounting only. Other targets get no fuzz leads.

## Evaluated, not wrapped (research-named OSS, 03-capabilities.md M5–M8, 04-crypto-coverage.md, 07-gap-3)

Every OSS tool the research names for this module carries a verdict here, so a
deliberate skip and an un-examined gap stop looking the same. Verdict ∈ {wrap,
ensemble (already in "Wrapped today"), defer (a real gap, named for a wave),
skip (reason)}. The lab targets always ship Solidity source and are EVM-only;
those two facts drive most of these.

| Tool | Why it was raised | Verdict | Reason |
|------|-------------------|---------|--------|
| Halmos | Symbolic tests in Foundry syntax; proves or refutes a property (M7 formal). | defer — Contracts wave | The only formal-verification tool in the research even reached as a candidate, and a proved/refuted property fits the harm-execution model directly. Not silent: blocked only on image, run time, and output-format work. |
| Chimera (Recon) | One property suite runs across Echidna, Medusa, Halmos and Foundry. | defer — Contracts wave | Directly closes the "fuzz template covers vault accounting only" gap above. Blocked on license check and on whether the agent writes good properties unaided. |
| Mythril | Symbolic execution on bytecode; finds paths Slither misses. | skip for this lab; defer for live | Lab targets ship source, so Slither + Aderyn already cover those paths. Mythril's bytecode-only path finding adds lift only against a no-source live target — wire it as an ensemble lead engine when live contract targets land. |
| Heimdall | Decompiles bytecode when there is no source. | skip for this lab; defer for live no-source | The lab always has source, so Heimdall has zero lift today. It earns a row only when a live target ships bytecode without source. |
| Wake | Python test and detector framework. | skip — overlap | Duplicates Slither + Aderyn as a static detector; no distinct detection shown to justify a third static engine in the ensemble. |
| Semgrep (Solidity rules) | Fast pattern rules; custom crypto rules are easy to add. | skip — overlap | supply-chain already runs Semgrep with our own rules, and for contracts the crypto patterns are carried by Slither/Aderyn plus our oracles. Revisit if a custom crypto rule pack proves a distinct catch. |
| 4naly3er | Gas and low-severity findings report. | skip — out of model | Gas and low findings are not exploit proof; this pack proves harm, so there is nothing for 4naly3er to prove. |
| Vyper, Move, Cairo, Rust (NEAR, Solana) analyzers | Non-EVM chain static analysis. | defer — per target chain | The lab is EVM-only. Each non-EVM chain is one row to add when a target on that chain is in scope. See 07-gap-3 for ZK and MPC coverage. |
