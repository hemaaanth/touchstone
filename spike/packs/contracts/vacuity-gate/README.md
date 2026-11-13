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
- **Liveness:** Forge runs **one entire invariant campaign** using
  `FOUNDRY_INVARIANT_RUNS=1`, rather than treating a debugger replay of one
  run as evidence about the default 256 runs. Its handler-call metrics must
  match the execution traces per handler method. Forge may append one replay
  action, which is excluded from state scoring. Calls under reverted actions
  cannot count as successes. A successful action must leave a net target
  balance or storage-value difference from its pre-action state. Intermediate
  writes, same-value `SSTORE`, and deposit-then-withdraw round trips do not
  count. An incomplete trace or absent storage dump fails closed. Every target
  selector observed in the scored campaign needs a successful committed call.
- **Code fingerprints:** the selected test and its reachable relative,
  non-relative, and remapped project imports are checked for bytecode/codehash
  reads. Such comparisons cannot count as behavioral assertions. Vendored
  `forge-std` imports are treated as trusted library code.

The normal positive fixture is `ReviewProof.t.sol`: it changes target state,
checks fee accounting, detects the unauthorized rescue on the buggy source,
and kills the fee mutants. The old `FeeVaultInvariantsFixed.t.sol` example
is **not accepted**: the repaired rescue cannot succeed under its handler,
and its previous six “kills” were inherited from the buggy baseline. The
withdraw-write-after-call reentrancy mutant is **not** shown killed by that
example; the earlier score provided no evidence about it.

## Scope and limits

This is evidence of non-vacuity **for the selected invariant, the one scored
campaign, the repaired reference, and the fixed mutants**. It is not a claim
that every invariant or fuzz seed is covered, that every bug is detectable, or
that arbitrary Solidity assertions are semantically behavioral. The
fingerprint scan rejects direct code identity checks in reachable project
sources, but does not audit the vendored `forge-std` library or opaque external
calls. Target discovery expects `src/` and a handler in the test directory.
The literal repair and mutants are specific to the supplied `FeeVault` source;
for another contract they must be designed afresh. A suite that only passes
under the one selected random campaign may still fail under other seeds.

Negative fixtures `ReviewFail`, `ReviewGreen`, `ReviewSkip`, `ReviewRollback`,
`ReviewSample`, `ReviewRoundTrip`, `ReviewSetup`, and `ReviewHiddenHash` each
exercise a former false pass. The test also rejects an external symlinked
input before any test-file read. If Docker is unavailable, the integration
checks skip; that is not evidence of a passing gate.
