# FeeVault invariant vacuity gate

A passing invariant suite can be dead. For example, a handler can catch every
failed deposit and leave the vault empty. This fixture-specific gate rejects that
case. It compares every `invariant_*` function of the test file on a healthy
reference, fixed mutants, and the planted `rescue` access-control bug.

## Run

```sh
node spike/packs/contracts/vacuity-gate/gate.mjs \
  --project spike/packs/contracts/vacuity-gate/fixtures/property-spike \
  --test test/ReviewProof.t.sol [--min-kill-rate 0.5]
node --experimental-test-module-mocks --test \
  spike/packs/contracts/vacuity-gate/gate.test.mjs
```

The input project is never edited. The gate rejects symlinks, copies the project
to a temp directory, and writes only inside that copy. `--keep` retains the
copies for inspection. It emits one JSON verdict; exit 0 means `pass: true`.
`--known-bug` is still accepted for old command lines; the known-bug check
always runs. When the flag is given, the verdict's `notes` say so.

The Forge image is pinned to
`ghcr.io/foundry-rs/foundry@sha256:3a392c18f9b16e665e932de159fb6fa9ed972c4b4352f2f76a1a8c7ca9b57d39`.
Install that exact digest and populate a `foundry-svm` or
`touchstone_svm_cache` volume **before** running. Every Forge invocation,
including `forge inspect`, goes through `runTool()` (`spike/lib/wrap.mjs`) with
`--pull=never`, `--network none`, memory/PID/timeout limits, capability drop,
and `no-new-privileges`. The pinned forge-std is a read-only extra mount and
the solc cache a named volume (`runTool`'s `mounts`). The host-path mount keeps
a Daytona run on this host. A missing image or cache is an offline prerequisite error.

## Gate-owned environment

- The gate copies only `.sol` files. It ignores the project's `foundry.toml`,
  `remappings.txt` and `lib/forge-std`, and writes its own `foundry.toml` for
  every run: `ffi = false`, `fs_permissions = []`, `libs = []`, no
  auto-detected remappings, optimizer off, `solc 0.8.38`, offline. The verdict's
  `environment` fields (`ffi`, `fs_permissions`, `offline`, `solc`,
  `dynamic_test_linking`) are read back from that written file, and the gate
  fails closed unless `ffi = false`, `fs_permissions = []` and `offline = true`.
- `forge-std/` resolves only to the pinned, read-only copy in
  `lab/vault-reentrancy/lib/forge-std/src` (the lab copy, forge-std 1.9.4; no
  second copy is kept in the pack; tree sha256
  `bc3cf851aeea54c57710b26436641a985a599ba4d1eaa98fba7317773c3194ca`). The gate
  checks that hash before each run and mounts the copy read-only. An import of a
  file that is not in that copy fails the build.
- Every run uses the same `--fuzz-seed 0x7661637569747921`. The gate sets
  invariant runs and depth itself.

## Target

The target is always `src/FeeVault.sol`, contract `FeeVault`, with sha256
`131fcfda4b5b4fe2d3e1c3653c9d034c4781447afefa31efe83f89742843d615`. Another
hash fails closed. The selected test must compile that file. A decoy contract
cannot become the mutation target.

## Scan of compiled sources

The gate takes the source list and solc AST from Forge build-info. That is the
exact set solc compiled, so remappings or comments cannot hide a file. On the
AST it rejects:

- whole cheatcode groups read from the pinned `Vm.sol`: any name with `code`
  (for example `getCode`, `getDeployedCode`, `deployCode`, `etch`), `read*`,
  `ffi`, `random*`, `env*`, `gas*`, file system, artifact, RPC and time
  cheats;
- `.code` / `.codehash` member access, `gasleft()`, and Yul `extcodesize`,
  `extcodehash`, `extcodecopy`, `codesize`, `codecopy` and `gas`;
- a call to a forge-std function that uses one of those (taint is followed to
  a fixed point).

Strings and comments are not code in the AST, so comment markers inside
strings cannot hide a call.

## Differential check

A fingerprint oracle passes on the exact healthy bytes and fails on anything
else. The scan cannot see every way to read bytes, so the gate also runs the
invariant on a second healthy build **B** and requires the same result.

- **How B is made.** B is `src/FeeVault.sol` with tabs for indents, a source
  comment with a random nonce, and 1 to 3 random dead pads after each
  function's opening brace: `assembly { if lt(0x<random>, 0) { invalid() } }`.
  `lt(x, 0)` is always false, so the branch is never taken. The pad uses no
  memory, storage, logs or calls, and leaves the stack as it was.
- **How B is shown behavior-equal.** Removing the pads from B's text gives A's
  text again. Then, on the compiled artifacts, the gate checks: ABI, method
  identifiers and storage layout are equal; runtime bytes differ; there are
  no immutables; there is no CODESIZE, CODECOPY, EXTCODE* opcode. After the
  gate removes each exact 8-instruction pad block, the runtime and the
  constructor must be the same instruction for instruction. The only values
  allowed to differ are jump targets, and each one must point to the matching
  JUMPDEST. The constructor's code-length constants are matched by name. If a
  data constant happens to equal a jump offset, the check is ambiguous and the
  gate retries with new pads (up to 8 times). Any real difference fails.
- **Rule.** The healthy control must pass on A and on B with the same seed and
  campaign. Pass on A but fail on B is rejected as a fingerprint oracle (or a
  too-strict or flaky invariant). The verdict lists both builds with runtime
  size and hash, and the proof counts.
- The known-bug copy and each mutant get their own padded build, so a test
  cannot recognise the exact mutant bytes either.

## Campaigns

Every `invariant_*` function in the test file is selected. Forge 1.9 checks
all of them in one campaign and reports one result per invariant
(`invariant_predicate_results`). The gate reads those per-invariant results,
and fails closed if they disagree with Forge's aggregate status.

- **Strong healthy run:** 256 runs x depth 32, fixed seed, no `--debug`. Every
  selected invariant must succeed with no skips or execution errors.
- **Score runs:** 32 runs x depth 32, fixed seed, for A, B, the known bug and
  the mutants.
- **Liveness run:** one campaign with `--debug` for traces and storage.
  `forge --debug` replays exactly one test, so this run selects the first
  invariant. The handler calls come from `setUp` and the seed, not from the
  invariant, so on the healthy build the call sequence is the same.

## What counts

- **Healthy control:** every selected invariant must run and succeed on the
  unmutated healthy source. The gate always repairs `FeeVault.rescue` with
  `onlyOwner` in the healthy copy; the input source is the planted-bug copy.
  The repair must match exactly once. An already-failing control cannot score.
  There is no mode without the repair: the target is pinned to this one file,
  so its bug is always present, and an honest suite that catches it would
  otherwise fail its own control.
- **Known bug (always required):** at least one invariant must newly fail on
  the buggy copy. A unit test, `setUp()` failure, skipped test, compiler error,
  or timeout is not a detected invariant bug. `ReviewNoRescue.t.sol` kills the
  fee mutants but never calls `rescue`; the gate refuses it with
  `known-bug: no new invariant Failure`.
- **Mutation kill:** at least one invariant must newly fail on a compiled
  mutant compared with the successful healthy control. The six fixed edits
  include deposit/withdraw guards, rescue transfer failure, fee divisor, fee
  accumulation, and withdraw write order. A kill is credited only for an
  explicit invariant `Failure`, not another test or `Skipped` result.
- **Kill-rate bar:** the gate passes only when at least one mutant is killed
  and `killed / scored >= --min-kill-rate`. The default is `0` (the
  `MIN_KILL_RATE` constant in `gate.mjs`), so the default bar is "at least one
  kill". The owner may raise it. The verdict always reports `killRate`,
  `minKillRate`, `survivingMutants` (each scored mutant no invariant killed) and
  `unscoredMutants`, so a narrow suite is visible even when it passes.
  `ReviewProof` kills 2 of 6 (0.3333): it passes the default bar and is refused
  at `--min-kill-rate 0.5`.
- **Liveness:** handler-call metrics must match the execution traces per
  handler method. Forge may append one replay action, which is excluded from
  state scoring. Calls under reverted actions cannot count as successes. A
  successful action must leave a net target balance or storage-value
  difference from its pre-action state. Intermediate writes, same-value
  `SSTORE`, and deposit-then-withdraw round trips do not count. An incomplete
  trace or absent storage dump fails closed.
- **Dead selectors:** a target selector with no committed success is accepted
  only as a *probe*: at least one of its calls ran the target's code and
  reverted there (a `require`, custom error or panic). An access-control test
  that calls `rescue` as a non-owner is such a probe. A selector whose calls
  never ran the target's code (for example `OutOfFunds` because the pranked
  caller holds no ETH, or out of gas), or that succeeded only inside a
  rolled-back frame, is a dead action and fails the gate. Probes are allowed
  only because other calls change committed state (the rule above). The
  verdict lists `deadSelectors` and `probeSelectors`.

There are two positive fixtures:

- `ReviewProof.t.sol` changes target state, checks fee accounting, detects the
  unauthorized rescue on the buggy source, and kills the fee mutants.
- `FeeVaultInvariantsFixed.t.sol` uses ghost variables and bounded actors, and
  calls `rescue` only from non-owners. On the repaired reference every such
  call reverts in the target, so `rescue` is a probe. Its first invariant,
  `invariant_solvency`, kills no mutant; `invariant_feeAccounting` kills the
  two fee mutants, and `invariant_solvency` and `invariant_feesAccruedBacked`
  detect the known bug.

`FeeVaultInvariants.t.sol` is the dead suite by design. Its handler funds
itself but pranks an unfunded actor, so every `deposit()` ends `OutOfFunds`
before the target runs. The gate rejects it as a dead selector.

## Scope and limits

This is evidence of non-vacuity **for the selected invariants, the fixed seed,
the repaired reference, and the fixed mutants**. It is not a claim that every
seed is covered, that every bug is detectable, or that arbitrary Solidity
assertions are behavioral. Known gaps:

- B changes size, gas and jump offsets at random. An oracle that keys on a
  property B happens to share with A (for example a size threshold that both
  builds cross) can still pass. Random pads make this unlikely, not
  impossible.
- A cheatcode called through a raw address and selector, without a `vm.`
  name, is not seen by the scan. The gate config (`ffi = false`, no file
  permissions) blocks the dangerous ones; the differential check is the main
  defence for the rest.
- The fuzzer's dictionary is built from bytecode, so A and B may see slightly
  different inputs. An invariant that is flaky under the seed can fail on B;
  the gate rejects that case too.
- Gas-dependent behavior is not proven equal (the pads cost gas).
- The behavior-equal proof assumes solc's runtime output has no
  layout-dependent value except jump targets, CODE* opcodes and immutables;
  the last two are rejected outright.
- The pinned forge-std is checked by tree hash, not against an upstream git
  commit.
- The repair and mutants are written for this `FeeVault` source only.

Negative fixtures `FeeVaultInvariants`, `ReviewFail`, `ReviewGreen`, `ReviewSkip`, `ReviewRollback`,
`ReviewSample`, `ReviewRoundTrip`, `ReviewSetup`, `ReviewHiddenHash`, `ReviewNoRescue`, and the
review-finding fixtures B1–M5 each exercise a former false pass.
`ReviewRawCheat` reads the artifact size through a raw cheatcode call that the
scan cannot see; the old gate accepted it, and only build B rejects it. The test also
rejects an external symlinked input before any test-file read. If Docker is
unavailable, the integration checks skip; that is not evidence of a passing
gate.
