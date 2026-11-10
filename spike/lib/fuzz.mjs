// Property-fuzzing pass for the Contracts module (submodule: fuzzing).
//
// This is a HYPOTHESIS GENERATOR, not a verdict. Echidna drives the contract
// from many ordinary users and tries to break an invariant we assert about it.
// A broken invariant is a SUSPECT with a concrete call sequence — a strong lead
// for the exploit-proof agent — but it is never a finding on its own. Only a
// passing Foundry replay makes it real, exactly like a Slither alert.
//
// Why fuzzing earns its place next to Slither: the two catch different bug
// classes. Slither owns reentrancy and dangerous data-flow. Fuzzing owns
// ACCOUNTING bugs — rounding, unfunded payouts, solvency invariants that drift
// over many calls — which a pattern matcher cannot see. Echidna finds the
// breaking SEQUENCE, from plain deposits and withdrawals, with no hand-coded
// attacker and no reentrancy.
//
// We only know how to fuzz a shape we have an invariant template for. Today that
// is the "vault solvency" template: a contract that takes deposits, pays
// withdrawals, and tracks a public principal total must always hold at least the
// principal it owes. A target that matches no template yields an honest empty
// scan — we never invent an invariant we cannot justify.
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";

const IMG = "ghcr.io/trailofbits/eth-security-toolbox:nightly";
const SOLC = "0.8.38";

const run = (args, timeoutMs) =>
  new Promise((resolve) => {
    execFile("docker", args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ stdout: String(stdout), stderr: String(stderr), timedOut: err?.killed === true, code: err?.code ?? 0 });
    });
  });

// The vault-solvency invariant template. We can fuzz a source file for solvency
// only when it looks like a deposit/withdraw vault with a payable constructor
// (the reward buffer) and a public principal total we can read back. These are
// the exact things the generated harness and property need; if any is missing
// the template does not apply and we say so honestly.
function detectVaultSolvency(srcText) {
  // Look at CODE, not prose. Strip block and line comments first so a word like
  // "contract" inside a NatSpec sentence can never be mistaken for a declaration.
  const code = srcText.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  // A real contract declaration: the name is followed by `is` or the opening `{`.
  const contract = (code.match(/\bcontract\s+(\w+)\s*(?:is\b|\{)/) || [])[1] || null;
  if (!contract) return null;
  const hasDeposit = /function\s+deposit\s*\(\s*\)\s+external\s+payable/.test(code);
  const hasWithdraw = /function\s+withdraw\s*\(/.test(code);
  const hasPayableCtor = /constructor\s*\([^)]*\)\s+payable/.test(code);
  const totalVar = (code.match(/uint256\s+public\s+(total\w+)/) || [])[1] || null;
  if (!hasDeposit || !hasWithdraw || !hasPayableCtor || !totalVar) return null;
  return { contract, totalVar };
}

// The Echidna harness: three ORDINARY users (no attacker, no reentrancy) share
// one vault, and Echidna picks which user acts and how much they deposit. The
// property is intrinsic solvency: the vault must always cover the principal it
// owes. A correct vault keeps this true forever; the buggy one lets one user's
// withdrawal overdraw into another user's principal, and the fuzzer finds that
// sequence. `importFile` is the basename of the target source, co-located in the
// scratch dir so a plain solc compile (offline) resolves it.
function buildHarness({ contract, totalVar, importFile }) {
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
function weiHexToEth(hex) {
  try {
    const wei = BigInt(hex);
    if (wei === 0n) return "0 ETH";
    // Two decimals of ETH, without floats.
    const whole = wei / 10n ** 18n;
    const frac = (wei % 10n ** 18n) / 10n ** 16n; // hundredths
    return `${whole}.${frac.toString().padStart(2, "0")} ETH`;
  } catch {
    return null;
  }
}

// Parse Echidna's text output: which echidna_* properties broke, and the minimal
// call sequence it shrank to for each. The sequence is the lead the agent reads.
function parseEchidna(text) {
  const props = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/echidna_(\w+):\s*(failed|passing)/);
    if (!m) continue;
    const name = `echidna_${m[1]}`;
    const broke = m[2] === "failed";
    if (!broke) {
      props.push({ name, broke: false, sequence: [] });
      continue;
    }
    // Collect the indented call-sequence lines that follow "Call sequence:".
    const seq = [];
    let j = i + 1;
    while (j < lines.length && !/Call sequence:/.test(lines[j]) && lines[j].trim()) j++;
    if (/Call sequence:/.test(lines[j] || "")) {
      for (j = j + 1; j < lines.length; j++) {
        const raw = lines[j];
        if (!raw.trim() || /^(Traces:|Unique|Corpus|Seed|\[)/.test(raw.trim())) break;
        const call = raw.match(/\w+\.(\w+)\(([^)]*)\)/);
        if (!call) continue;
        const fn = call[1];
        const args = call[2].trim();
        const valueHex = (raw.match(/Value:\s*(0x[0-9a-fA-F]+)/) || [])[1] || null;
        const eth = valueHex ? weiHexToEth(valueHex) : null;
        const who = args !== "" ? `user ${args}` : null;
        let human;
        if (fn === "deposit") human = `${who ?? "a user"} deposits${eth ? ` ${eth}` : ""}`;
        else if (fn === "withdraw") human = `${who ?? "a user"} withdraws`;
        else human = `${fn}(${args})`;
        seq.push(human);
      }
    }
    props.push({ name, broke: true, sequence: seq });
  }
  return props;
}

// Run Echidna's property fuzzer over the target. Returns a scan describing which
// invariant was tested and whether the fuzzer broke it, with the breaking
// sequence. Returns an empty-but-honest scan when no template applies or the
// harness could not be built/compiled — never a fabricated suspect.
export async function fuzzScan(ws, { timeoutMs = 240_000, testLimit = 50_000 } = {}) {
  const srcDir = join(ws, "src");
  let files = [];
  try { files = readdirSync(srcDir).filter((f) => f.endsWith(".sol")); } catch { files = []; }

  // Find the first source file the solvency template applies to.
  let target = null;
  for (const f of files) {
    let text = "";
    try { text = readFileSync(join(srcDir, f), "utf8"); } catch { continue; }
    const det = detectVaultSolvency(text);
    if (det) { target = { file: f, ...det }; break; }
  }
  if (!target) {
    return { tool: "Echidna", template: null, applicable: false, broken: false, findings: [] };
  }

  // Scratch project: all src files flat (so sibling imports resolve) plus the
  // generated harness and an Echidna config. Offline, property mode.
  const scratch = mkdtempSync(join(tmpdir(), "redteam-fuzz-"));
  try {
    for (const f of files) copyFileSync(join(srcDir, f), join(scratch, f));
    writeFileSync(join(scratch, "Harness.sol"), buildHarness({ ...target, importFile: target.file }));
    writeFileSync(
      join(scratch, "echidna.yaml"),
      `testMode: property\ntestLimit: ${testLimit}\nbalanceContract: 100000000000000000000\n`,
    );

    const args = [
      "run", "--rm", "--network", "none",
      "-v", `${scratch}:/work`, "-w", "/work", "--entrypoint", "sh",
      IMG,
      "-c",
      `solc-select use ${SOLC} --always-install >/dev/null 2>&1; echidna Harness.sol --contract Harness --config echidna.yaml --format text 2>&1`,
    ];
    const r = await run(args, timeoutMs);
    const out = r.stdout + r.stderr;

    // No property line at all means the harness never compiled/ran — honest empty.
    if (!/echidna_\w+:/.test(out)) {
      return { tool: "Echidna", template: "vault-solvency", applicable: true, broken: false, findings: [], timedOut: r.timedOut };
    }

    const props = parseEchidna(out);
    const findings = props
      .filter((p) => p.broke)
      .map((p) => ({
        check: "solvency-violation",
        impact: "High",
        property: p.name,
        where: `${target.contract}.withdraw`,
        contract: target.contract,
        description:
          `The vault's solvency invariant broke: it ended holding less than the ` +
          `principal it owes (address(this).balance < ${target.totalVar}). The ` +
          `fuzzer reached this with ordinary deposits and a withdrawal — no ` +
          `attacker contract and no reentrancy.`,
        sequence: p.sequence,
      }));

    return { tool: "Echidna", template: "vault-solvency", applicable: true, broken: findings.length > 0, findings, timedOut: r.timedOut };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// A compact brief the agent reads before it starts hunting. Mirrors staticBrief:
// short, ranked, and explicit that a broken invariant is only a lead. Empty
// string when nothing broke, so the caller can skip the section cleanly.
export function fuzzBrief(scan) {
  if (!scan || !scan.findings.length) return "";
  const lines = scan.findings.slice(0, 6).map((f, i) => {
    const seq = f.sequence.length ? `\n     sequence: ${f.sequence.join(" → ")}` : "";
    return `${i + 1}. [${f.impact}] ${f.check} at \`${f.where}\` (property ${f.property})${seq}`;
  });
  return `Property fuzzing (Echidna) broke ${scan.findings.length} invariant(s):\n${lines.join("\n")}`;
}
