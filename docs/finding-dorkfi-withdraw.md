# Finding: `withdraw` ignores the collateral factor, so a borrower drains the pool at 100 % LTV

Target: `DorkFi/df-evm` (`LendingPoolBase._executeWithdraw`, inherited by `LendingPoolETH` and
`LendingPoolERC20`). Proven offline in a per-run Foundry workspace on 2026-11-14 (run
`…-2611141915-2695070011`, proof `forge: pass`).

**Status: real in the EVM source. Not proven on the chain DorkFi's tracked TVL sits on.** Read
"Where it actually runs" before pricing it.

## The defect

`LendingPoolBase` enforces collateral once, on the way in:

```solidity
// LendingPoolBase.sol
uint256 public constant COLLATERAL_FACTOR_BPS = 8000; // 80 %

function _executeBorrow(address user, uint256 amount) internal {
    uint256 maxBorrow = (supplyBalance[user] * COLLATERAL_FACTOR_BPS) / BPS;
    if (newBorrow > maxBorrow) revert InsufficientCollateral();   // :64
```

Nothing re-checks it on the way out:

```solidity
function _executeWithdraw(address user, uint256 amount) internal {
    if (supplyBalance[user] < amount) revert InsufficientBalance();   // :46
    uint256 availableSupply = totalSupply - totalBorrowed;
    if (amount > availableSupply) revert InsufficientLiquidity();     // :49
    supplyBalance[user] -= amount;                                    // :51
    totalSupply -= amount;                                            // :52
}
```

Both gates are about the caller's own balance and the pool's free cash. Neither looks at the
caller's debt. `LendingPoolBase` has no oracle, no interest and **no liquidation function**, so once
the collateral is gone nothing revalues or seizes it.

## The sequence

One transaction, no special conditions:

1. `deposit(D)` — attacker supplies `D`.
2. `borrow(0.8·D)` — the only health check in the system passes at exactly the limit.
3. `withdraw(D)` — passes both withdraw gates, `_push` pays out `D` (`LendingPoolETH.sol:17`).

End state: `supplyBalance`, and therefore collateral, is `0`; `borrowBalance` is `0.8·D`. The cash
for step 3 comes from `totalSupply − totalBorrowed`, i.e. out of other depositors.

Measured in the proof: victim supplies 1000 ETH; attacker supplies 1250, borrows 1000, withdraws
1250. Pool balance 1000 → 0, attacker 2250 after spending 1250. The victim's later `withdraw`
reverts.

## Exposure

- Reachable: **100 % of a pool's free liquidity** (`totalSupply − totalBorrowed`). Looping the
  cycle compounds: capital of about ¼ of the target reaches all of it (measured: `C=300` → 1000
  profit, `C=100` → ceiling 382).
- Left unbacked: **100 % of the attacker's debt** (`0.8·D`, up to `3.2·C` in a loop), with zero
  collateral behind every wei.
- Recovery: none. No liquidation exists, and `_executeRepay` credits the caller only, so neither a
  keeper nor the victim can repay on the borrower's behalf. The attacker must repay voluntarily.
- Once free liquidity is 0, every supplier withdraw reverts at `:49`.

Fix, one line after `:52`:

```solidity
require(borrowBalance[user] * BPS <= supplyBalance[user] * COLLATERAL_FACTOR_BPS);
```

## Why the tests missed it

`test_CannotWithdrawMoreThanSupply` looks like it covers this. It deposits 10, borrows 5, then
expects `InsufficientLiquidity` on `withdraw(6)` and passes — but that is the *liquidity* gate. The
next line, `withdraw(5)`, leaves supply 5 against debt 5, i.e. 100 % LTV, and nothing notices.
`testFuzz_DepositWithdraw` never borrows; `test_Withdraw` asserts balances only. The invariant
`borrowBalance ≤ supplyBalance·CF/BPS` is asserted nowhere.

## Where it actually runs

This is the part that decides whether the finding has money behind it.

| Question | Answer | Evidence |
|---|---|---|
| What chains does DefiLlama track for `dorkfi`? | Algorand, Voi Network — both AVM, not EVM | `api.llama.fi/protocol/dorkfi` |
| What is the audited code? | Algorand Python contracts, ARC4/ARC200 | Entersoft audit, Nov 2025, §2.2 Scope |
| What is `df-evm`? | A separate EVM implementation with Base mainnet, Hedera and Monad deploy scripts (chain-8453 assert) | `script/LendingPoolV2BaseMainnet.s.sol`, `docs/deployment/*` |
| Is `LendingPoolV2` (the Base deploy path) affected? | **No.** `_withdraw` re-checks `HealthFactorWouldViolate` inline | `LendingPoolV2.sol:743-806` |
| Is a legacy pool deployment live? | Not recorded in the repo; the live app names Algorand and Sepolia | `app.dork.fi` |

So: the bug is real in shipped EVM source, is *not* in the newer V2 the Base script deploys, and the
tracked TVL sits on a different (AVM) implementation that our Foundry proof cannot execute.

## TVL at risk

Tracked supplied TVL is ~$220 k (Algorand $149.3 k, Voi $70.6 k); borrowed $43.6 k. Free liquidity,
the amount a full drain could take, is about **$176 k**.

That number applies *if* the AVM code has the same hole. Entersoft already reported a close relative
there — "Redeem Function Accounting Bypass: users will be able to withdraw assets while the protocol
still considers their collateral locked", with the same consequence list (insolvency, liquidation
failure, protocol drain). Ours is an independent, source-proven instance on the EVM side, with a
one-line fix and a working regression test; whether the AVM deploy was remediated is not public.

## Verify

```sh
gh repo clone DorkFi/df-evm && cd df-evm
forge test --match-contract LegacyWithdrawNoHealthTest -vv
```

Read `LendingPoolBase.sol:44-55` for the two missing lines, and `LendingPoolV2.sol:743` for the
version that does it right.
