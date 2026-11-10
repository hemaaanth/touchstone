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

export const IMG = "ghcr.io/trailofbits/eth-security-toolbox:nightly";
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

  let target = null;
  for (const f of files) {
    let text = "";
    try { text = readFileSync(join(srcDir, f), "utf8"); } catch { continue; }
    const det = detectVaultSolvency(text);
    if (det) { target = { file: f, ...det }; break; }
  }
  if (!target) return null;

  const scratch = mkdtempSync(join(tmpdir(), "redteam-fuzz-"));
  for (const f of files) copyFileSync(join(srcDir, f), join(scratch, f));
  writeFileSync(join(scratch, "Harness.sol"), buildHarness({ ...target, importFile: target.file }));
  return { scratch, files, target };
}
