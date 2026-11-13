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
| Halmos | AGPL-3.0 (LICENSE in the wheel); image also carries z3 (MIT) and yices (GPL-3.0) | `touchstone/halmos:0.3.3`, built by `images/build.sh halmos` from `images/Dockerfile.halmos` (base images by digest, solc by checksum, every pip package pinned) | Yes: `--network none`, `--pull=never`, `FOUNDRY_OFFLINE` | The target's own `test/**/*.sol` with `check_*` functions | `--json-output`, parsed by `halmos.mjs` | counterexample → `symbolic-counterexample` lead with the argument values | `forge`, through the agent's PoC. The lead alone never proves | None for symbolic; Echidna/Medusa sample the same space | None | Checks only properties the target ships; see below | wrap (leads only until the vacuity gate merges) |

## Halmos: what it covers and what it does not

- **Runs** in the contracts pre-pass, with the fuzz module, when the workspace
  has at least one `check_*` function under `test/`. `makeWorkspace` now copies
  a target's `test/` (never `oracle/`). With no `check_` function it does not
  start a container and adds nothing to the run.
- **Gives** one lead per counterexample: the property name, the suite, and the
  argument values. The lead goes into the agent's first message
  (`SYMBOLIC_BRIEF`), the `symbolic-scan` event and the run view. There is no
  agent tool for it.
- **Lab:** `lab/vault-shares`. Halmos finds `withdraw` burning zero shares
  (counterexample `assets = 2^40`, below one share's value). Static flags only
  `deposit` and `addYield`, and no fuzz template fits, so before this wrap the
  pack had no lead at `withdraw`. `oracle/ShareVaultExploits.t.sol` replays it.
- **Vacuity gate, fail closed.** `suite-trust.mjs` `suiteTrust()` is the one
  call site. Until the gate on `pack/contracts-vacuity` is merged it returns
  `trusted: false` for every suite. So every Halmos lead has
  `supportsProof: false`, and a pass is reported as `unverified`, never as
  "holds" or "not exploitable". Results are leads only and cannot support proof.
  Why: a blind-agent test wrote 7 correct-looking invariants for
  `lab/vault-multi` FeeVault. The fuzzer passed all 7. The handler funded
  itself, not the actor, so every deposit reverted inside a `try/catch` and
  the vault stayed empty. Every invariant held vacuously.
- **Fails closed.** A missing image, a timeout (an in-container kill at the
  limit minus 5 s, so no container outlives it), a build error, no report,
  unreadable output, a failed `setUp` (Halmos reports an empty list) or a
  solver timeout on one test (exit 2) is a gap, never a clean result.
- **Does not cover:** properties the target does not ship. Halmos does not
  write properties. It checks only `check_*` functions, not `invariant_*`
  functions. Its default loop bound and solver timeouts apply, so a pass is
  bounded even after the gate. Solidity must build with solc 0.8.38, the one
  baked into the image. A brief scope gets nothing, because it has no `test/`
  at start.

## Gaps in our wrapping

- Aderyn runs on the host, not in Docker. Untrusted code is parsed outside the
  sandbox. Move it into a container.
- The fuzz template covers vault accounting only. Other targets get no fuzz leads.
- Halmos runs only properties the target ships. A target with no `check_*`
  functions gets no symbolic leads.

## Evaluated, not wrapped (research-named OSS, 03-capabilities.md M5–M8, 04-crypto-coverage.md, 07-gap-3)

Every OSS tool the research names for this module carries a verdict here, so a
deliberate skip and an un-examined gap stop looking the same. Verdict ∈ {wrap,
ensemble (already in "Wrapped today"), blocked (a named thing that does not
exist yet), backlog (net-new work nobody has decided against), skip (reason)}.
The lab targets always ship Solidity source and are EVM-only; those two facts
drive most of these.

| Tool | Why it was raised | Verdict | Reason |
|------|-------------------|---------|--------|
| Chimera (Recon) | One property suite runs across Echidna, Medusa, Halmos and Foundry. | blocked — vacuity gate and license review | Directly closes the "fuzz template covers vault accounting only" gap above. The blind-agent test in the Halmos section applies: the fuzzer passed all 7 vacuous invariants, so no suite result counts until the gate exists. License: MIT, declared only by `SPDX-License-Identifier: MIT` headers in its `.sol` files. The repo has no LICENSE text file. `create-chimera-app` has no license at all. That needs licensing review. |
| Mythril | Symbolic execution on bytecode; finds paths Slither misses. | blocked — no source-less live target | Lab targets ship source, so Slither + Aderyn already cover those paths. Mythril's bytecode-only path finding adds lift only against a target that ships bytecode without source. That target kind does not exist yet: lab code is under `src/`, and a brief scope only fetches the GitHub links it names. Wire it as an ensemble lead engine when such a target exists. |
| Heimdall | Decompiles bytecode when there is no source. | blocked — no source-less live target | The lab always has source, so Heimdall has zero lift today. It earns a row only when a target ships bytecode without source, and no scope kind produces such a target: brief scopes fetch GitHub source only. |
| Wake | Python test and detector framework. | skip — overlap (assumed, not tested) | Duplicates Slither + Aderyn as a static detector. No distinct detection was shown; that is an assumption, not a comparison. |
| Semgrep (Solidity rules) | Fast pattern rules; custom crypto rules are easy to add. | skip — overlap (assumed, not tested) | The reason given was cross-pack reuse, which is weak: contracts would need different rules. supply-chain does run Semgrep, but with supply-chain rules. The crypto patterns here are carried by Slither/Aderyn plus our oracles. No distinct catch was shown. Revisit if a crypto rule pack proves one. |
| 4naly3er | Gas and low-severity findings report. | skip — out of model | Gas and low findings are not exploit proof; this pack proves harm, so there is nothing for 4naly3er to prove. |
| Vyper, Move, Cairo, Rust (NEAR, Solana) analyzers | Non-EVM chain static analysis. | blocked — no non-EVM target in scope | The lab is EVM-only and every proof is a local Foundry test. A Move target needs a Move target in scope; each chain also needs its own toolchain and image. One row per chain when a target on that chain exists. See 07-gap-3 for ZK and MPC coverage. |
