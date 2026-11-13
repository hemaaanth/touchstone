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
| Mythril | MIT | `touchstone/mythril:0.24.8`, built by `Dockerfile.mythril` (upstream image pinned by digest) | Yes — bytecode only, no solc, no signature lookup | A deployed-bytecode unit: `src/<Name>.runtime.hex` | `analyze --bin-runtime -o jsonv2` | SWC issue → check, impact, the fault opcode's pc, the call sequence | `forge`: the agent still proves the lead with a Foundry test that drains the stub-deployed contract | Slither + Aderyn (but only where source exists) | A source-less target: it names functions (e.g. `sweep(address)`) and finds faults from bytecode alone, which the static engines cannot see | No economic or cross-contract reasoning; only within the per-unit time cap | ensemble (bytecode) |
| Heimdall | MIT | `touchstone/heimdall:0.9.3`, built by `Dockerfile.heimdall` (pinned release binary, fetched by sha256) | Yes — `--skip-resolving`, so no online signature lookup; the ABI comes from the bytecode alone | A deployed-bytecode unit: `src/<Name>.runtime.hex` | `decompile --skip-resolving --include-sol -o <dir>` → `*-abi.json` | Not a vuln lead — it is evidence: the recovered ABI (each selector, its argument and return types, its state mutability) so the agent can declare the interface to call the contract | `forge`: the ABI only enables the PoC; harm is still proven by a Foundry test on the stub-deployed contract | None — it is a decompiler, not a detector; it complements Mythril's leads on the same source-less target | A source-less target: the only readable `.sol` is the stub, yet Heimdall recovers the full interface (all 6 selectors) that the source tools never see | Recovers the interface, not the economics; names stay `Unresolved_<selector>` offline; no verdict of safe | ensemble (bytecode) |

## Gaps in our wrapping

- Aderyn runs on the host, not in Docker. Untrusted code is parsed outside the
  sandbox. Move it into a container.
- The fuzz template covers vault accounting only. Other targets get no fuzz leads.

## Evaluated, not wrapped (research-named OSS, 03-capabilities.md M5–M8, 04-crypto-coverage.md, 07-gap-3)

Every OSS tool the research names for this module carries a verdict here, so a
deliberate skip and an un-examined gap stop looking the same. Verdict ∈ {wrap,
ensemble (already in "Wrapped today"), blocked (a named thing that does not
exist yet), backlog (net-new work nobody has decided against), skip (reason)}.
The lab targets always ship Solidity source and are EVM-only; those two facts
drive most of these.

| Tool | Why it was raised | Verdict | Reason |
|------|-------------------|---------|--------|
| Halmos | Symbolic tests in Foundry syntax; proves or refutes a property (M7 formal). | blocked — vacuity gate | A proved or refuted property fits the harm-execution model directly, so this is the right formal tool. It is not worth a green run yet. A blind-agent test wrote 7 correct-looking invariants for `lab/vault-multi` FeeVault. The agent predicted the right bug. The fuzzer passed all 7 anyway. The handler funded itself, not the actor, so every deposit reverted inside a `try/catch` and the vault stayed empty. Every invariant held vacuously. Wiring also needs the image, run time and output format. The gate spike is in progress under `spike/packs/contracts/vacuity-gate/`. |
| Chimera (Recon) | One property suite runs across Echidna, Medusa, Halmos and Foundry. | blocked — vacuity gate and license review | Directly closes the "fuzz template covers vault accounting only" gap above. The same blind-agent test applies, and the fuzzer passed all 7 vacuous invariants, so no suite result counts until the gate exists. License: MIT, declared only by `SPDX-License-Identifier: MIT` headers in its `.sol` files. The repo has no LICENSE text file. `create-chimera-app` has no license at all. That needs licensing review. |
| Mythril | Symbolic execution on bytecode; finds paths Slither misses. | wrapped (see "Wrapped today") | Now has a source-less target: `lab/vault-bytecode` ships only runtime bytecode (`src/<Name>.runtime.hex`) plus a stub that installs it, so the static and fuzz engines see no vault logic. Mythril reads the bytecode, names the functions from its bundled signature DB, and flags the planted unprotected `sweep(address)` as SWC-105 High. The lead is proven the normal way: a Foundry test drains the stub-deployed contract and clears the harm gate (funds channel). What it does NOT cover: it runs only when a `*.runtime.hex` unit exists (no lift on an ordinary source lab), it reasons within a per-unit time cap (a clean result is "no lead", never "safe"), and it does no economic or cross-contract analysis. |
| Heimdall | Decompiles bytecode when there is no source. | wrapped (see "Wrapped today") | Now has a source-less target: `lab/vault-bytecode` ships only runtime bytecode (`src/<Name>.runtime.hex`) plus a stub that installs it, so the readable `.sol` names no vault function. Heimdall decompiles the bytecode offline (`--skip-resolving`) and recovers the full ABI — all 6 selectors with their argument and return types and state mutability — which the agent declares as an interface for its PoC. It is a decompiler, so it gives evidence, not a vuln lead: the recovered ABI never marks anything proven, and a missing image, a timeout or an unparsable ABI fails closed to "unavailable", never a clean result. It still earns its row only on a `*.runtime.hex` unit; an ordinary source lab gives it zero lift. |
| Wake | Python test and detector framework. | skip — overlap (assumed, not tested) | Duplicates Slither + Aderyn as a static detector. No distinct detection was shown; that is an assumption, not a comparison. |
| Semgrep (Solidity rules) | Fast pattern rules; custom crypto rules are easy to add. | skip — overlap (assumed, not tested) | The reason given was cross-pack reuse, which is weak: contracts would need different rules. supply-chain does run Semgrep, but with supply-chain rules. The crypto patterns here are carried by Slither/Aderyn plus our oracles. No distinct catch was shown. Revisit if a crypto rule pack proves one. |
| 4naly3er | Gas and low-severity findings report. | skip — out of model | Gas and low findings are not exploit proof; this pack proves harm, so there is nothing for 4naly3er to prove. |
| Vyper, Move, Cairo, Rust (NEAR, Solana) analyzers | Non-EVM chain static analysis. | blocked — no non-EVM target in scope | The lab is EVM-only and every proof is a local Foundry test. A Move target needs a Move target in scope; each chain also needs its own toolchain and image. One row per chain when a target on that chain exists. See 07-gap-3 for ZK and MPC coverage. |
