# Vacuity gate

A green invariant suite is not evidence until it can fail. This spike gates a
Foundry suite on three things: the handler reaches the target, the suite kills
small mutants, and the suite fails on a known bug. The target story is
`FeeVault`; an agent wrote seven invariants, all passed, and the contract was
fully drainable. The handler did `vm.deal(address(this), x)`, then `vm.prank(actor)`,
then `deposit{value: x}()`. The prank made the actor the payer, the actor had no
ETH, every deposit reverted, and the handler's `try/catch` hid it. The vault
stayed empty, so all seven invariants held over the initial state. The gate
exists to reject that suite.

## What it checks

1. **Liveness.** From Forge's execution traces it counts calls to the target,
   failed calls, successful value-bearing calls, storage writes, and per-selector
   success. The suite fails if the handler never calls the target, if the target
   state never moves, or if any selector that was called never succeeded. A
   silently caught revert is still visible in the trace.
2. **Mutation kill.** It applies six fixed text mutants to the target source on
   a throwaway copy: remove the deposit guard, remove the withdraw guard, ignore
   a failed `rescue` transfer, divide fees by 1,000 instead of 10,000, overwrite
   `feesAccrued` instead of adding, and move the `withdraw` state write after the
   external call. It runs the suite on each mutant. Zero kills fail the gate.
3. **Known-bug control.** With `--known-bug`, it runs the suite on the untouched
   buggy source and reports every failing invariant. Not detecting the planted
   bug fails the gate.

The gate never edits the input project. Every run happens in a temp copy under
the system temp dir.

## How to run

```
cd spike/packs/contracts/vacuity-gate
node gate.mjs --project fixtures/property-spike \
  --test test/FeeVaultInvariants.t.sol --known-bug
```

The command prints one JSON verdict to stdout. Exit code is 0 only when every
check passes. `--keep` keeps the temp copy for inspection.

Docker is `ghcr.io/foundry-rs/foundry:latest`, `--network none`, host uid, the
solc cache volume mounted at `/home/foundry/.svm`. The volume is `foundry-svm`
(the brief names `touchstone_svm_cache`; that volume exists but is empty today,
so the runner tries both). `runDocker()` from `spike/lib/wrap.mjs` is used, but
not `runTool()`, because `runTool()` has no extra-volume parameter for the solc
cache.

## Result A: the vacuous agent suite

Command:

```
node gate.mjs --project fixtures/property-spike \
  --test test/FeeVaultInvariants.t.sol --known-bug
```

Real verdict, exit code 1:

```json
{
  "pass": false,
  "liveness": {
    "pass": false,
    "targetCalls": 39,
    "successfulTargetCalls": 26,
    "failedTargetCalls": 13,
    "successfulValueCalls": 0,
    "storageWrites": 9,
    "targetCallSuccessRate": 0.6667,
    "deadSelectors": ["deposit()"],
    "reasons": ["liveness: 1 selector(s) never succeeded"]
  },
  "killRate": 0,
  "knownBug": { "planted": true, "detected": false, "failingInvariants": [] },
  "reasons": [
    "liveness: 1 selector(s) never succeeded",
    "known-bug: the suite passed on the original buggy source",
    "mutants: killed 0 of 6 applied mutants"
  ]
}
```

The gate rejects it on liveness. `deposit()` was called and never succeeded,
and no successful call ever carried ETH. All six mutants survived because owner
paths (`setFeeBps`, `collectFees`) still execute, but no user state moves.

## Result B: the fixed suite

The fixed copy changes one line: `vm.deal(actor, actor.balance + amount)` funds
the payer instead of the handler. Everything else is unchanged.

Command:

```
node gate.mjs --project fixtures/property-spike \
  --test test/FeeVaultInvariantsFixed.t.sol --known-bug
```

Real verdict, exit code 0:

```json
{
  "pass": true,
  "liveness": {
    "pass": true,
    "targetCalls": 7,
    "successfulTargetCalls": 7,
    "failedTargetCalls": 0,
    "successfulValueCalls": 1,
    "storageWrites": 1,
    "targetCallSuccessRate": 1,
    "deadSelectors": [],
    "reasons": []
  },
  "killRate": 1,
  "knownBug": {
    "planted": true,
    "detected": true,
    "failingInvariants": ["invariant_solvency()"]
  },
  "reasons": []
}
```

Liveness passes and the known-bug control names `invariant_solvency` on the
unguarded `rescue`. All six mutants were killed.

## Limits

- The mutation set is six fixed literal edits for `FeeVault`. A target with
  different source needs its own list; patterns that do not match once are
  reported as not applied and left out of the kill rate.
- Reentrancy mutants do not kill unless the suite's actor can receive ETH and
  re-enter. `withdraw-write-after-call` survives here for that reason.
- Liveness reads traces from one invariant campaign. A suite whose first
  invariant has unusual setup can under-sample; the dead-selector rule still
  catches a selector that is called and never succeeds.
- The known-bug control needs `--known-bug`. Without it the gate only proves
  liveness and mutation kill.
- Because the fixed suite already fails on the buggy source, every mutant run
  fails too and the kill rate is trivially 1. On a target whose baseline passes,
  the kill rate is the real signal.
- Target discovery assumes the target is deployed from `src/` and the handler
  lives in the test directory. One suite contract per test file is required by
  `forge test --debug`.
- The gate proves the suite is not vacuous for the exercised paths. It does not
  prove the invariants are complete.
