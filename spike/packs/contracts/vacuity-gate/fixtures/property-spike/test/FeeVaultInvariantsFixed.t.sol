// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {FeeVault} from "../src/FeeVault.sol";

/// @title Handler
/// @notice Same dispatch as the agent's vacuous suite, with the deposit funding
///         bug fixed: `vm.prank(actor)` makes the actor the msg.sender, so the
///         actor must hold the ETH that `deposit{value: amount}` forwards.
contract Handler is Test {
    FeeVault public immutable vault;

    address[] public actors;

    // --- ghost accounting (ground truth) ---
    uint256 public ghost_sumDeposited; // total principal ever deposited by users
    uint256 public ghost_sumWithdrawn; // total principal ever withdrawn by users
    uint256 public ghost_sumFeesCharged; // sum of all withdrawal fees levied
    uint256 public ghost_sumFeesCollected; // sum of all fees swept by the owner
    uint256 public ghost_sumPaidOut; // actual ETH wired back to users (amount-fee)
    uint256 public ghost_sumRescued; // ETH removed via rescue()

    // per-user net principal: deposits minus withdrawals
    mapping(address => uint256) public netPrincipal;

    constructor() {
        vault = new FeeVault(); // msg.sender == this handler -> owner == handler
        for (uint256 i = 0; i < 4; i++) {
            actors.push(address(uint160(0x1000 + i)));
        }
    }

    function numActors() external view returns (uint256) {
        return actors.length;
    }

    /// Sum of every tracked actor's on-book balance.
    function totalUserBalances() public view returns (uint256 total) {
        for (uint256 i = 0; i < actors.length; i++) {
            total += vault.balanceOf(actors[i]);
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    // -------------------------------------------------------------------------
    // Actions
    // -------------------------------------------------------------------------

    function deposit(uint256 actorSeed, uint256 amount) public {
        address actor = _actor(actorSeed);
        amount = bound(amount, 1, 100 ether);
        // The fix: fund the actor, because the prank makes the actor the payer.
        vm.deal(actor, actor.balance + amount);
        vm.prank(actor);
        try vault.deposit{value: amount}() {
            ghost_sumDeposited += amount;
            netPrincipal[actor] += amount;
        } catch {}
    }

    function withdraw(uint256 actorSeed, uint256 amount) public {
        address actor = _actor(actorSeed);
        uint256 bal = vault.balanceOf(actor);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        uint256 fee = (amount * vault.feeBps()) / 10_000;
        vm.prank(actor);
        try vault.withdraw(amount) {
            ghost_sumWithdrawn += amount;
            netPrincipal[actor] -= amount;
            ghost_sumFeesCharged += fee;
            ghost_sumPaidOut += amount - fee;
        } catch {}
    }

    function withdrawAll(uint256 actorSeed) public {
        address actor = _actor(actorSeed);
        uint256 bal = vault.balanceOf(actor);
        if (bal == 0) return;
        uint256 fee = (bal * vault.feeBps()) / 10_000;
        vm.prank(actor);
        try vault.withdrawAll() {
            ghost_sumWithdrawn += bal;
            netPrincipal[actor] -= bal;
            ghost_sumFeesCharged += fee;
            ghost_sumPaidOut += bal - fee;
        } catch {}
    }

    /// Owner-gated. Handler is the owner, so this is the legitimate caller.
    function setFeeBps(uint256 bps) public {
        bps = bound(bps, 0, 100);
        try vault.setFeeBps(bps) {} catch {}
    }

    /// Owner-gated. Handler is the owner.
    function collectFees() public {
        uint256 f = vault.feesAccrued();
        try vault.collectFees() {
            ghost_sumFeesCollected += f;
        } catch {}
    }

    /// Intended by its NatSpec as an owner-only rescue of mistakenly-sent ETH.
    /// We deliberately call it from an unprivileged actor to let the fuzzer
    /// discover whether that is actually enforced.
    function rescue(uint256 actorSeed, uint256 toSeed, uint256 amount) public {
        address actor = _actor(actorSeed);
        address payable to = payable(_actor(toSeed));
        uint256 vb = address(vault).balance;
        if (vb == 0) return;
        amount = bound(amount, 1, vb);
        vm.prank(actor);
        try vault.rescue(to, amount) {
            ghost_sumRescued += amount;
        } catch {}
    }

    receive() external payable {} // receive swept fees as owner, or rescued ETH
}

/// @title FeeVaultInvariantsFixed
/// @notice The agent suite with the deposit funding fixed. Everything else is
///         unchanged, so the gate's known-bug control can show that funding the
///         actor makes `invariant_solvency` fail on the unguarded `rescue`.
contract FeeVaultInvariantsFixed is StdInvariant, Test {
    Handler internal handler;
    FeeVault internal vault;

    function setUp() public {
        handler = new Handler();
        vault = handler.vault();

        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = Handler.deposit.selector;
        selectors[1] = Handler.withdraw.selector;
        selectors[2] = Handler.withdrawAll.selector;
        selectors[3] = Handler.setFeeBps.selector;
        selectors[4] = Handler.collectFees.selector;
        selectors[5] = Handler.rescue.selector;
        selectors[6] = Handler.deposit.selector; // weight deposits a little heavier

        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice SOLVENCY: the vault must always hold at least what it owes —
    ///         the sum of every user's claimable balance plus accrued fees.
    ///         If this breaks, someone can be left unable to withdraw funds
    ///         the vault's books still say they own.
    function invariant_solvency() public view {
        uint256 owed = handler.totalUserBalances() + vault.feesAccrued();
        assertGe(address(vault).balance, owed, "vault insolvent: balance < owed");
    }

    /// @notice INTERNAL ACCOUNTING: the sum of on-book user balances must equal
    ///         total principal deposited minus total principal withdrawn. Catches
    ///         any drift between the vault's bookkeeping and ground truth.
    function invariant_userBalanceAccounting() public view {
        assertEq(
            handler.totalUserBalances(),
            handler.ghost_sumDeposited() - handler.ghost_sumWithdrawn(),
            "user balance bookkeeping drifted"
        );
    }

    /// @notice ISOLATION: each user's on-book balance must exactly equal their
    ///         own net principal (their deposits minus their withdrawals). No
    ///         other actor's activity may move it.
    function invariant_perUserBalanceIsolated() public view {
        uint256 n = handler.numActors();
        for (uint256 i = 0; i < n; i++) {
            address a = handler.actors(i);
            assertEq(
                vault.balanceOf(a),
                handler.netPrincipal(a),
                "a user's balance diverged from their net principal"
            );
        }
    }

    /// @notice FEE BOUND: the fee rate can never exceed the 1% cap the setter
    ///         enforces, no matter who sets it or in what order.
    function invariant_feeBpsBounded() public view {
        assertLe(vault.feeBps(), 100, "feeBps exceeded cap");
    }

    /// @notice FEE ACCOUNTING: accrued-but-uncollected fees must equal total
    ///         fees ever charged minus total fees ever collected. Catches
    ///         double counting, lost fees, or fees charged inconsistently.
    function invariant_feeAccounting() public view {
        assertEq(
            vault.feesAccrued(),
            handler.ghost_sumFeesCharged() - handler.ghost_sumFeesCollected(),
            "feesAccrued inconsistent with charged-minus-collected"
        );
    }

    /// @notice ACCRUED FEES ARE BACKED: accrued fees alone can never exceed the
    ///         vault's ETH balance (a weaker, standalone corollary of solvency
    ///         targeting the owner's claim specifically).
    function invariant_feesAccruedBacked() public view {
        assertLe(vault.feesAccrued(), address(vault).balance, "accrued fees not backed by balance");
    }

    /// @notice OWNERSHIP IS IMMUTABLE: no reachable path reassigns ownership,
    ///         so the owner must remain the deployer for all time.
    function invariant_ownerImmutable() public view {
        assertEq(vault.owner(), address(handler), "owner changed unexpectedly");
    }
}
