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

The code is from **GitHub**, not from a chain: the public repo `github.com/DorkFi/df-evm`, reached
from the DefiLlama entry, stored as the scope's member URL and cloned by the run. Nothing here was
decompiled or read from an explorer — so everything below is a claim about that repository.

| Question | Answer | Evidence |
|---|---|---|
| Where did the code come from? | `github.com/DorkFi/df-evm`, public | scope `scope-dorkfi-df-evm-d3cf98d9` |
| Does DefiLlama track DorkFi on any EVM chain? | No — Algorand and Voi only | `api.llama.fi/protocol/dorkfi` |
| Does the live app offer any EVM chain? | No. 31 "algorand" / 34 "voi" hits, zero `0x` addresses, zero chain ids in its bundle | `app.dork.fi` |
| Is any EVM contract deployed? | Yes, on **testnets** only: Base Sepolia `LendingPoolV2` `0xd344…3605` has code, unverified on the explorer | Base Sepolia RPC, `docs/deployment/base-sepolia.md` |
| Is that deployed contract affected? | No — it is V2, which re-checks health inline | `LendingPoolV2.sol:743` |
| Is a **Base mainnet** deployment recorded? | No address in the repo, only a deploy command that asserts chain 8453 | `script/LendingPoolV2BaseMainnet.s.sol` |
| Is a **phase-0** pool (the affected code) deployed anywhere? | No address recorded; `script/LendingPool.s.sol` is chain-agnostic | repo-wide search |

So the honest shape: **source-level finding.** The vulnerable contracts are Phase 0, superseded by
V2, and no deployment of them is recorded. The one EVM deployment that is recorded is a testnet V2.

Why "on Base" was said at all: the repo ships a Base mainnet deploy script and a
`docs/deployment/base-mainnet.md` production guide. That is intent, not evidence of a deployment.
A free Etherscan key serves `getsourcecode` on 8453 but refuses `txlist` ("Free API access is not
supported for this chain"), so a deployer scan needs a paid plan.

## TVL at risk

Nothing is at risk on the EVM side today that is documented: no live phase-0 deployment is recorded.

For scale, the protocol's tracked supplied TVL is ~$220 k (Algorand $149.3 k, Voi $70.6 k), borrowed
$43.6 k, free liquidity about **$176 k** — all of it on the AVM implementation. That number applies
to this finding only *if* the AVM code has the same hole. Entersoft already reported a close relative
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
