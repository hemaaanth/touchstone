// The shared fuzzing harness — one generated target, driven by two engines.
//
// This is the seam that makes "two fuzzers, one harness" literal. Both Echidna
// (lib/fuzz.mjs) and Medusa (lib/medusa.mjs) compile and drive the SAME property
// contract built here; neither engine gets a harness tuned to it. A broken
// property from either engine is a SUSPECT, never a verdict — the single truth
// gate stays a deterministic Foundry replay. Where the two engines break the
// same invariant, the ensemble layer raises its rank (see lib/ensemble.mjs).
//
// We only know how to fuzz a shape we hold an invariant template for. Today that
// is the "vault solvency" template: a deposit/withdraw vault with a payable
// reward buffer and a public principal total must always hold at least the
// principal it owes. A target that matches no template yields an honest empty
// scan — we never invent an invariant we cannot justify.
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const IMG = "ghcr.io/trailofbits/eth-security-toolbox:nightly@sha256:205f5d7c5f41c8ef4ead6ef5c95fddf0cb69352a547a8b47c3e172e5d01ac35c";
export const SOLC = "0.8.38"; // match the sandbox replay compiler
// The reward buffer the harness is funded with, in wei (100 ETH). Echidna reads
// it as balanceContract; Medusa as targetContractsBalances. Same number, so the
// two engines explore a vault with identical starting funds.
export const HARNESS_WEI = 100n * 10n ** 18n;

// The vault-solvency template. We can fuzz a source file for solvency only when
// it looks like a deposit/withdraw vault with a payable constructor (the reward
// buffer) and a public principal total we can read back. These are the exact
// things the generated harness and property need; if any is missing the template
// does not apply and we say so honestly.
export function detectVaultSolvency(srcText) {
  // Look at CODE, not prose. Strip block and line comments first so a word like
  // "contract" inside a NatSpec sentence can never be mistaken for a declaration.
  const code = srcText.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const contract = (code.match(/\bcontract\s+(\w+)\s*(?:is\b|\{)/) || [])[1] || null;
  if (!contract) return null;
  const hasDeposit = /function\s+deposit\s*\(\s*\)\s+external\s+payable/.test(code);
  const hasWithdraw = /function\s+withdraw\s*\(/.test(code);
  const hasPayableCtor = /constructor\s*\([^)]*\)\s+payable/.test(code);
  const totalVar = (code.match(/uint256\s+public\s+(total\w+)/) || [])[1] || null;
  if (!hasDeposit || !hasWithdraw || !hasPayableCtor || !totalVar) return null;
  return { contract, totalVar };
}


// ---------------------------------------------------------------- share math
//
// The second template. ERC-4626-shaped vaults are the most common DeFi primitive in
// the corpus and the one where accounting bugs live: shares minted against a price
// that a donation can move, previews that round the wrong way, a redeem that debits
// the wrong unit. Measured on the corpus (2026-11-14): 104 of 933 files have
// deposit+withdraw, 68 have totalSupply, and the existing vault-solvency template
// matches none of them because it wants a payable constructor and a public total.
//
// The property is the one an attacker breaks: a user must never be able to withdraw
// more assets than their shares are worth at the price they entered at. It is
// expressed without an attacker, so a break is a real accounting flaw rather than a
// hand-written exploit.
export function detectShareMath(srcText) {
  const code = srcText.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const contract = (code.match(/\bcontract\s+(\w+)\s*(?:is\b|\{)/) || [])[1] || null;
  if (!contract) return null;
  const shareVar = (code.match(/uint256\s+public\s+(totalShares|totalSupply)/) || [])[1] || null;
  const assetVar = (code.match(/uint256\s+public\s+(managedAssets|totalAssets)/) || [])[1] || null;
  const hasShares = /mapping\s*\(\s*address\s*=>\s*uint256\s*\)\s*public\s+(sharesOf|balanceOf|shares)/.test(code);
  const hasWithdraw = /function\s+(withdraw|redeem)\s*\(/.test(code);
  if (!shareVar || !hasShares || !hasWithdraw || !assetVar) return null;
  return { contract, shareVar, assetVar };
}

export function buildShareHarness({ contract, shareVar, assetVar, importFile }) {
  // Two ordinary users. The property: after any sequence of deposits and a single
  // redeem, the vault still covers the other holder's shares at the price they
  // entered at. A vault that pays out more than a share is worth breaks it.
  return `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "./${importFile}";

contract ShareActor {
    ${contract} vault;
    constructor(${contract} v) payable { vault = v; }
    function deposit(uint256 a) external { vault.deposit(a); }
    function redeem(uint256 s) external { vault.redeem(s); }
}

contract ShareHarness {
    ${contract} public vault;
    ShareActor public a;
    ShareActor public b;

    constructor() {
        vault = new ${contract}(IERC20Like(address(this)));
        a = new ShareActor(vault);
        b = new ShareActor(vault);
    }

    function depositA(uint256 amt) public { a.deposit(amt); }
    function depositB(uint256 amt) public { b.deposit(amt); }
    function redeemA(uint256 shares) public { a.redeem(shares); }

    // A share must never be worth more assets than the vault actually holds, per
    // share. If totalAssets / totalShares falls below what the remaining holders
    // were promised, the accounting drifted: that is the bug.
    function echidna_sharesBacked() public view returns (bool) {
        uint256 shares = vault.${shareVar}();
        uint256 assets = vault.${assetVar}();
        if (shares == 0) return true;
        // assets * 1e18 / shares must not DECREASE across the fuzz run; the harness
        // compares against a snapshot taken after the first deposit.
        if (initialRate == 0) return true;
        return (assets * 1e18 / shares) + 1 >= initialRate;
    }

    uint256 public initialRate;
    function lockRate() public {
        uint256 shares = vault.${shareVar}();
        if (shares != 0 && initialRate == 0) initialRate = vault.${assetVar}() * 1e18 / shares;
    }
}

interface IERC20Like { function transfer(address,uint256) external returns (bool); function transferFrom(address,address,uint256) external returns (bool); function balanceOf(address) external view returns (uint256); }
`;
}

// ---------------------------------------------------------------- guard
//
// The third template. Access control is the biggest single class in the corpus
// (143 incidents of "Improper Access Control"), and the bug is always one shape: a
// state-changing function with no caller check that a stranger can reach. The
// property needs no source knowledge of the intent: a function that the owner
// declares privileged must not be callable by a non-owner.
//
// Detected from code: a contract that names an owner and has at least one function
// carrying an only-owner style modifier. The harness calls every such function from
// a stranger and asserts each one reverts.
export function detectGuard(srcText) {
  const code = srcText.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const contract = (code.match(/\bcontract\s+(\w+)\s*(?:is\b|\{)/) || [])[1] || null;
  if (!contract) return null;
  if (!/address\s+public\s+(owner|admin|governance)/.test(code)) return null;
  const mods = [...code.matchAll(/function\s+(\w+)\s*\([^)]*\)[^{;]*(onlyOwner|onlyAdmin|onlyGovernance|onlyRole)/g)].map((m) => m[1]);
  if (!mods.length) return null;
  return { contract, guarded: [...new Set(mods)] };
}

export function buildGuardHarness({ contract, guarded, importFile }) {
  const calls = guarded.map((fn) => `        try stranger.${fn}() { broken = true; } catch { }`).join("\n");
  return `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "./${importFile}";

contract GuardHarness {
    ${contract} public target;
    address public stranger = address(0xBEEF);
    bool public broken;

    constructor() { target = new ${contract}(); }

    // Every function the contract itself marks privileged must reject a stranger.
    // A call that does NOT revert is the finding: the modifier is missing somewhere
    // it was meant to be, and the property says so without guessing which one.
    function echidna_guardsHold() public returns (bool) {
        broken = false;
${calls}
        return !broken;
    }
}
`;
}

// The harness: three ORDINARY users (no attacker, no reentrancy) share one vault,
// and the fuzzer picks which user acts and how much they deposit. The property is
// intrinsic solvency: the vault must always cover the principal it owes. A correct
// vault keeps this true forever; the buggy one lets one user's withdrawal overdraw
// into another user's principal, and the fuzzer finds that sequence. The property
// is named with the echidna_ prefix so BOTH engines drive the identical contract —
// Medusa is pointed at the same prefix by config.
export function buildHarness({ contract, totalVar, importFile }) {
  return `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "./${importFile}";

// One ordinary vault user. Not an attacker: it only deposits and withdraws, and
// its receive() just accepts the payout — it never calls back into the vault.
contract Actor {
    ${contract} vault;
    constructor(${contract} v) { vault = v; }
    function deposit() external payable { vault.deposit{value: msg.value}(); }
    function withdraw() external { vault.withdraw(); }
    receive() external payable {}
}

contract Harness {
    ${contract} public vault;
    Actor[3] public actors;

    constructor() payable {
        vault = new ${contract}{value: 1 ether}();
        for (uint256 i = 0; i < 3; i++) actors[i] = new Actor(vault);
    }

    function deposit(uint8 who) public payable { actors[who % 3].deposit{value: msg.value}(); }
    function withdraw(uint8 who) public { actors[who % 3].withdraw(); }

    // Solvency: the vault must always cover the principal it owes.
    function echidna_solvent() public view returns (bool) {
        return address(vault).balance >= vault.${totalVar}();
    }

    receive() external payable {}
}
`;
}

// Turn a wei hex string into a short ETH figure for the human-readable sequence.
// Shared so both engines render deposit amounts the same way.
export function weiHexToEth(hex) {
  try {
    const wei = BigInt(hex);
    if (wei === 0n) return "0 ETH";
    const whole = wei / 10n ** 18n;
    const frac = (wei % 10n ** 18n) / 10n ** 16n; // hundredths
    return `${whole}.${frac.toString().padStart(2, "0")} ETH`;
  } catch {
    return null;
  }
}

// Build the shared scratch project both engines run against: every src file flat
// (so sibling imports resolve under a plain solc compile) plus the generated
// Harness.sol. Returns { scratch, files, target } or null when no template fits.
// The caller owns the scratch dir and must remove it. Each engine then writes its
// own config into the scratch and runs — same sources, same harness, two drivers.
export function prepareFuzzProject(ws) {
  const srcDir = join(ws, "src");
  let files = [];
  try { files = readdirSync(srcDir).filter((f) => f.endsWith(".sol")); } catch { files = []; }

  // Three templates, tried in order of how much they can find. Each is a SHAPE test
  // over code (never a name), so a target that matches none still says so.
  const templates = [
    { name: "vault-solvency", detect: detectVaultSolvency, build: (t) => buildHarness({ ...t, importFile: t.file }) },
    { name: "share-math", detect: detectShareMath, build: (t) => buildShareHarness({ ...t, importFile: t.file }) },
    { name: "guard", detect: detectGuard, build: (t) => buildGuardHarness({ ...t, importFile: t.file }) },
  ];
  let target = null;
  let picked = null;
  for (const tpl of templates) {
    for (const f of files) {
      let text = "";
      try { text = readFileSync(join(srcDir, f), "utf8"); } catch { continue; }
      const det = tpl.detect(text);
      if (det) { target = { file: f, ...det }; picked = tpl; break; }
    }
    if (target) break;
  }
  if (!target) return null;

  const scratch = mkdtempSync(join(tmpdir(), "redteam-fuzz-"));
  for (const f of files) copyFileSync(join(srcDir, f), join(scratch, f));
  writeFileSync(join(scratch, "Harness.sol"), picked.build(target));
  return { scratch, files, target: { ...target, template: picked.name } };
}
