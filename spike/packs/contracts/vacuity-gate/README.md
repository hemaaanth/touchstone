# FeeVault invariant vacuity gate

A passing invariant suite can be dead. For example, a handler can catch every
failed deposit and leave the vault empty. This fixture-specific gate rejects that
case. It compares an invariant on a healthy reference, fixed mutants, and (with
`--known-bug`) the planted `rescue` access-control bug.

## Run

```sh
node spike/packs/contracts/vacuity-gate/gate.mjs \
  --project spike/packs/contracts/vacuity-gate/fixtures/property-spike \
  --test test/ReviewProof.t.sol --known-bug
node --experimental-test-module-mocks --test \
  spike/packs/contracts/vacuity-gate/gate.test.mjs
```

The input project is never edited. The gate rejects symlinks, copies the project
to a temp directory, and writes only inside that copy. `--keep` retains the
copies for inspection. It emits one JSON verdict; exit 0 means `pass: true`.

The Forge image is pinned to
`ghcr.io/foundry-rs/foundry@sha256:3a392c18f9b16e665e932de159fb6fa9ed972c4b4352f2f76a1a8c7ca9b57d39`.
Install that exact digest and populate a `foundry-svm` or
`touchstone_svm_cache` volume **before** running. Every Forge invocation,
including `forge inspect`, uses `runDocker()` with `--pull=never`,
`--network none`, memory/PID/timeout limits, capability drop, and
`no-new-privileges`. A missing image or cache is an offline prerequisite error.

## Gate-owned environment

- The gate copies only `.sol` files. It ignores the project's `foundry.toml`,
  `remappings.txt` and `lib/forge-std`, and writes its own `foundry.toml` for
  every run: `ffi = false`, `fs_permissions = []`, `libs = []`, no
  auto-detected remappings, optimizer off, `solc 0.8.38`, offline.
- `forge-std/` resolves only to the pinned, read-only copy in
  `vendor/forge-std/src` (forge-std 1.9.4, tree sha256
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

- **Strong healthy run:** 256 runs x depth 32, fixed seed, no `--debug`. The
  selected invariant must succeed with no skips or execution errors.
- **Score runs:** 32 runs x depth 32, fixed seed, for A, B, the known bug and
  the mutants.
- **Liveness run:** one full campaign with `--debug` for traces and storage.

## What counts

- **Healthy control:** the selected invariant must run and succeed on the
  unmutated healthy source. `--known-bug` repairs `FeeVault.rescue` with
  `onlyOwner` in the healthy copy; the input source is the planted-bug copy.
  The repair must match exactly once. An already-failing control cannot score.
- **Known bug:** the same named invariant must newly fail on the buggy copy.
  A unit test, `setUp()` failure, skipped test, compiler error, or timeout is
  not a detected invariant bug.
- **Mutation kill:** the same named invariant must newly fail on a compiled
  mutant compared with the successful healthy control. The six fixed edits
  include deposit/withdraw guards, rescue transfer failure, fee divisor, fee
  accumulation, and withdraw write order. A kill is credited only for an
  explicit invariant `Failure`, not another test or `Skipped` result.
- **Liveness:** handler-call metrics must match the execution traces per
  handler method. Forge may append one replay action, which is excluded from
  state scoring. Calls under reverted actions cannot count as successes. A
  successful action must leave a net target balance or storage-value
  difference from its pre-action state. Intermediate writes, same-value
  `SSTORE`, and deposit-then-withdraw round trips do not count. An incomplete
  trace or absent storage dump fails closed. Every target selector observed in
  the campaign needs a successful committed call.

The normal positive fixture is `ReviewProof.t.sol`: it changes target state,
checks fee accounting, detects the unauthorized rescue on the buggy source,
and kills the fee mutants. The old `FeeVaultInvariantsFixed.t.sol` example
is **not accepted**: the repaired rescue cannot succeed under its handler,
and its previous six “kills” were inherited from the buggy baseline.

## Scope and limits

This is evidence of non-vacuity **for the selected invariant, the fixed seed,
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

Negative fixtures `ReviewFail`, `ReviewGreen`, `ReviewSkip`, `ReviewRollback`,
`ReviewSample`, `ReviewRoundTrip`, `ReviewSetup`, `ReviewHiddenHash`, and the
review-finding fixtures B1–M5 each exercise a former false pass.
`ReviewRawCheat` reads the artifact size through a raw cheatcode call that the
scan cannot see; the old gate accepted it, and only build B rejects it. The test also
rejects an external symlinked input before any test-file read. If Docker is
unavailable, the integration checks skip; that is not evidence of a passing
gate.
