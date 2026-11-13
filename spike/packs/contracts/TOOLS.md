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
| Chimera (Recon) | Library MIT by `SPDX-License-Identifier` headers only (no LICENSE file, no copyright line; see below). Runners: Echidna AGPL-3.0, Medusa AGPL-3.0, crytic-compile AGPL-3.0, solc GPL-3.0 | `touchstone/chimera:e2.3.3-m1.5.1`, built by `images/build.sh chimera` from `images/Dockerfile.chimera` (base images by digest, Echidna, Medusa and solc by checksum, every pip package pinned) | Yes: `--network none`, `--pull=never`, `FOUNDRY_OFFLINE` | The target's own Chimera suite: one `contract CryticTester` under `test/` that imports `@chimera/` | Echidna `--format text` and Medusa text, parsed by `chimera.mjs` | broken property → `chimera-property-broken` lead with the call sequence and which engines broke it | `forge`, through the agent's PoC. The lead alone never proves | Our fuzz template runs the same two engines, but on our harness, not the target's | None | Checks only properties the target ships; see below | wrap (leads only until the vacuity gate merges) |
| Mythril | MIT. The image also ships, as run-time parts: Python 3.10 (PSF) on Debian 12 (glibc LGPL-2.1+), z3-solver (MIT), py-evm and the eth-* libraries (MIT), numpy, scipy and scikit-learn (BSD-3-Clause), certifi (MPL-2.0), and ethereum-input-decoder (GPL-3.0). From `importlib.metadata` in the local image; the tool runs as a separate program | `touchstone/mythril:0.24.8`, built by `Dockerfile.mythril` (upstream image pinned by digest) | Yes — bytecode only, no solc, no signature lookup | A deployed-bytecode unit: `src/<Name>.runtime.hex` | `analyze --bin-runtime -o jsonv2` | SWC issue → check, impact, the fault opcode's pc, the call sequence | `forge`: the agent still proves the lead with a Foundry test that drains the stub-deployed contract | Slither + Aderyn (but only where source exists) | A source-less target: it names functions (e.g. `sweep(address)`) and finds faults from bytecode alone, which the static engines cannot see | No economic or cross-contract reasoning; only within the per-unit time cap | ensemble (bytecode) |
| Heimdall | MIT. The image also ships, as run-time libraries from Debian 13: libssl3t64 (Apache-2.0), zlib1g (Zlib), libbrotli1 (MIT; installed but not linked, see Gaps), libzstd1 (BSD-3-Clause or GPL-2), libc6 (LGPL-2.1+) and libgcc-s1 (GPL-3+ with the GCC runtime exception). From each package's `/usr/share/doc/*/copyright` in the local image | `touchstone/heimdall:0.9.3`, built by `Dockerfile.heimdall` (pinned release binary, fetched by sha256) | Yes — `--skip-resolving`, so no online signature lookup; the ABI comes from the bytecode alone | A deployed-bytecode unit: `src/<Name>.runtime.hex` | `decompile --skip-resolving --include-sol -o <dir>` → `*-abi.json` | Not a vuln lead — it is evidence: the recovered ABI (each selector, its argument and return types, its state mutability) so the agent can declare the interface to call the contract | `forge`: the ABI only enables the PoC; harm is still proven by a Foundry test on the stub-deployed contract | None — it is a decompiler, not a detector; it complements Mythril's leads on the same source-less target | A source-less target: the only readable `.sol` is the stub, yet Heimdall recovers the full interface (all 6 selectors) that the source tools never see | Recovers the interface, not the economics; names stay `Unresolved_<selector>` offline; no verdict of safe | ensemble (bytecode) |

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
- **Fails closed.** These are a gap, never a clean result: a missing image; a
  timeout (an in-container kill at the limit minus 5 s; if the docker client
  times out first, the result is a gap with `timedOut`, and runTool removes
  the container, including one the daemon creates after the client died; a
  test checks that none is left, not even in state "Created"); a kill by signal 9
  (exit 137 is the time limit or the 2 GB memory limit; we cannot tell which,
  and say so); any non-zero container exit, even with a valid report; a build
  error; no report; an empty or unreadable report; a failed `setUp` (Halmos
  reports an empty list); a solver timeout on one test (exit 2); and a listed
  suite with no entry in the report; a `check_` function the suite file
  declares with no result (one inherited from another file is not checked
  this way; one in a comment or a string, or `internal` or `private`, is not
  counted, because Halmos cannot run it; a comment marker inside a string is
  not a comment, so it hides nothing); a `test/` we cannot walk (for example
  a symlink loop, ELOOP). A report entry for a suite this
  workspace does not list is dropped. When any check is a gap, the run view
  says how many ("1 of 2 checks unchecked (...)"). When no check ran at all,
  the run view shows Halmos as `unavailable`, not `ran`.
- **Does not cover:** properties the target does not ship. Halmos does not
  write properties. We pass `--function check_`, so it runs only `check_*`
  functions. Halmos 0.3.3 also runs `invariant_*` functions by default; we do
  not. Its default loop bound and solver timeouts apply, so a pass is
  bounded even after the gate. Solidity must build with solc 0.8.38, the one
  baked into the image. A brief scope gets nothing, because it has no `test/`
  at start.

## Chimera: what it covers and what it does not

- **Runs** in the contracts pre-pass, with the fuzz module, in parallel with
  Halmos, when `test/` has exactly one `.sol` file that declares
  `contract CryticTester` and imports Chimera. It runs that suite under Echidna
  and Medusa, each in its own container (two `runTool()` calls). With no such
  suite it starts no container and adds nothing to the run. With two or more
  `CryticTester` contracts it runs none and reports a gap, because both
  engines pick the contract by name.
- **Assertion mode only.** Chimera's asserts (`t`, `eq`, `gte`, ...) fail with
  `assert(false)`, so Echidna and Medusa run in assertion mode. A property
  written as a bool-returning `echidna_` function is not checked.
- **Budget:** 60 s of fuzzing per engine, at most 50,000 calls, sequences of
  50 calls, 2 workers each. The container limit is that plus 120 s for the
  build. A property that did not break only did not break in this budget.
- **Gives** one lead per broken property: the property, the shortest call
  sequence either engine reported, and which engines broke it (one engine or
  both). The lead goes into the agent's first message (`PROPERTY_BRIEF`), the
  `chimera-scan` event and the run view (row "Chimera"). There is no agent
  tool for it.
- **Lab:** `lab/vault-shares` ships a Chimera suite in `test/recon/` and the
  library in `lib/chimera/`. Both engines break `property_solvent()` with
  deposit then redeem (Echidna shrinks it to `vault_deposit(0)`,
  `vault_redeem(0)`): `redeem` takes shares off `managedAssets`, so the vault
  counts assets it does not hold. Static flags only `deposit` and `addYield`,
  no fuzz template fits, and Halmos's `check_*` functions never call
  `redeem`. So before this wrap the pack had no lead at `redeem`.
  `oracle/ShareVaultExploits.t.sol` replays it.
- **Vacuity gate, fail closed.** The same `suiteTrust()` call site as Halmos.
  Today it returns `trusted: false`, so every Chimera lead has
  `supportsProof: false` and a property that did not break is `unverified`.
  Results are leads only and cannot support proof until the gate merges.
- **Fails closed.** These are a gap, never a clean result: a missing image; a
  timeout (an in-container kill at the limit minus 5 s; if the docker client
  times out first, the engine reports `timedOut`; the result is
  still a gap, and runTool removes the container, including one the daemon
  creates after the client died; a test checks that none is left, not even
  in state "Created"); a kill by signal 9
  (exit 137 is the time limit or the 2 GB memory limit; we cannot tell which,
  and say so); a build error; no report; a report cut short (no summary
  lines); a report with no tests; a test Echidna or Medusa could not run;
  output we cannot read; a `test/` we cannot walk (for example a symlink
  loop, ELOOP). Such a throw is a gap for that scan only; the other
  prepass leads still reach the run.
  - **Exit codes.** Only the documented pairs count: Echidna 0 with no broken
    test or 1 with one, Medusa 0 with no broken test or 7 with one. Any other
    code, or a code that does not match the report, fails that engine.
  - **Bound to the entry contract.** The engines test the `CryticTester` ABI.
    We read that ABI from source: the `CryticTester` in the suite file, then
    each base it inherits, by name, across every `.sol` file in the workspace
    (not `.git`, `node_modules`, `out`, `cache` or `crytic-export`). So a
    property inherited from a file outside the suite's folder still binds.
    A test on a contract other than `CryticTester`, or a function it does not
    have, is dropped (`dropped`) and is a gap, never a lead. Each `property_*`
    function it has that an engine did not report is a gap for that engine.
    One in a comment or a string, or `internal` or `private`, is not counted,
    because the engines call only ABI functions. A comment marker inside a
    string is not a comment, so it hides nothing. Both adapters read the
    source through one scanner, `solidity-source.mjs`. Its line ends follow
    solc 0.8 (checked with 0.8.38): a `//` comment ends at LF, CR or CRLF, so
    a CR-only file is read in full. (VT, FF, NEL, LS and PS also end it, but
    then the file does not compile.) A backslash before a line end inside a
    string continues the string.
    `property_` is a naming convention, so a property with another name is
    checked only if an engine reports it.
    Limits: a base name declared in more than one file gives the union of
    their functions (at worst an extra gap); an aliased import
    (`import {A as B}`) is not followed, so its tests are dropped as gaps.
  - **Run view.** Any gap puts a reason on the "Chimera" row, for example
    "1 of 12 engine checks unchecked (...)". A dropped test counts as
    unchecked. When nothing was checked, the
    row is `unavailable`, not `ran`.
  - One engine down is a gap for that engine; the other engine's results still
    count. Both down: the scan is `unavailable`.
- **Text, not JSON.** Echidna 2.3.3 `--format json` names every test "name",
  leaves the contract empty and mixes log lines into stdout, so we parse the
  text report. A change to either engine's text format makes the parser throw,
  which is a gap, not a pass. The fixtures in `spike/test/fixtures/chimera/`
  are real output from this image.
- **Does not cover:** properties the target does not ship. Chimera does not
  write properties. Foundry and Halmos entry points of the same suite
  (`CryticToFoundry`, `HalmosAsserts`) are not run here. Slither is not in
  the image, so Echidna gets no Slither constants. Solidity must build with
  solc 0.8.38. A brief scope gets nothing.
- **License.** Every `src/*.sol` file at tag 0.1.4
  (`0d37c2b8998756680e76d859c343e01c4fc1e006`) says
  `SPDX-License-Identifier: MIT`. The repo has no LICENSE file and no
  copyright line, and GitHub reports no license. We run the target's copy; the
  pack ships none of it. Only the lab vendors it, unchanged, in
  `lab/vault-shares/lib/chimera/`. This still needs a licensing review before
  any release that includes the lab.

## Gaps in our wrapping

- Aderyn runs on the host, not in Docker. Untrusted code is parsed outside the
  sandbox. Move it into a container.
- The fuzz template covers vault accounting only. Other targets get no fuzz leads.
- Halmos runs only properties the target ships. A target with no `check_*`
  functions gets no symbolic leads.
- Chimera runs only a suite the target ships. Most targets ship none, so they
  get no Chimera leads. Generating a Chimera suite is not done.
- Follow-up: `Dockerfile.heimdall` installs `libbrotli1`, but Heimdall does not
  use it (`ldd` in `touchstone/heimdall:0.9.3` shows only OpenSSL, zlib, zstd,
  libgcc and libc). Remove it from the `apt-get install` line at the next image
  rebuild, then drop it from the licence list above.

## Evaluated, not wrapped (research-named OSS, 03-capabilities.md M5–M8, 04-crypto-coverage.md, 07-gap-3)

Every OSS tool the research names for this module carries a verdict here, so a
deliberate skip and an un-examined gap stop looking the same. Verdict ∈ {wrap,
ensemble (already in "Wrapped today"), blocked (a named thing that does not
exist yet), backlog (net-new work nobody has decided against), skip (reason)}.
The lab targets always ship Solidity source and are EVM-only; those two facts
drive most of these.

| Tool | Why it was raised | Verdict | Reason |
|------|-------------------|---------|--------|
| Mythril | Symbolic execution on bytecode; finds paths Slither misses. | wrapped (see "Wrapped today") | Now has a source-less target: `lab/vault-bytecode` ships only runtime bytecode (`src/<Name>.runtime.hex`) plus a stub that installs it, so the static and fuzz engines see no vault logic. Mythril reads the bytecode, names the functions from its bundled signature DB, and flags the planted unprotected `sweep(address)` as SWC-105 High. The lead is proven the normal way: a Foundry test drains the stub-deployed contract and clears the harm gate (funds channel). What it does NOT cover: it runs only when a `*.runtime.hex` unit exists (no lift on an ordinary source lab), it reasons within a per-unit time cap (a clean result is "no lead", never "safe"), and it does no economic or cross-contract analysis. |
| Heimdall | Decompiles bytecode when there is no source. | wrapped (see "Wrapped today") | Now has a source-less target: `lab/vault-bytecode` ships only runtime bytecode (`src/<Name>.runtime.hex`) plus a stub that installs it, so the readable `.sol` names no vault function. Heimdall decompiles the bytecode offline (`--skip-resolving`) and recovers the full ABI — all 6 selectors with their argument and return types and state mutability — which the agent declares as an interface for its PoC. It is a decompiler, so it gives evidence, not a vuln lead: the recovered ABI never marks anything proven, and a missing image, a timeout or an unparsable ABI fails closed to "unavailable", never a clean result. It still earns its row only on a `*.runtime.hex` unit; an ordinary source lab gives it zero lift. |
| Wake | Python test and detector framework. | skip — overlap (assumed, not tested) | Duplicates Slither + Aderyn as a static detector. No distinct detection was shown; that is an assumption, not a comparison. |
| Semgrep (Solidity rules) | Fast pattern rules; custom crypto rules are easy to add. | skip — overlap (assumed, not tested) | The reason given was cross-pack reuse, which is weak: contracts would need different rules. supply-chain does run Semgrep, but with supply-chain rules. The crypto patterns here are carried by Slither/Aderyn plus our oracles. No distinct catch was shown. Revisit if a crypto rule pack proves one. |
| 4naly3er | Gas and low-severity findings report. | skip — out of model | Gas and low findings are not exploit proof; this pack proves harm, so there is nothing for 4naly3er to prove. |
| Vyper, Move, Cairo, Rust (NEAR, Solana) analyzers | Non-EVM chain static analysis. | blocked — no non-EVM target in scope | The lab is EVM-only and every proof is a local Foundry test. A Move target needs a Move target in scope; each chain also needs its own toolchain and image. One row per chain when a target on that chain exists. See 07-gap-3 for ZK and MPC coverage. |
