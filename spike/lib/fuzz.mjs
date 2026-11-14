// Property-fuzzing pass for the Contracts module (submodule: fuzzing).
//
// This is a HYPOTHESIS GENERATOR, not a verdict. Two independent property
// fuzzers drive the contract from many ordinary users and try to break an
// invariant we assert about it. A broken invariant is a SUSPECT with a concrete
// call sequence — a strong lead for the exploit-proof agent — but it is never a
// finding on its own. Only a passing Foundry replay makes it real, exactly like
// a static alert.
//
// Why fuzzing earns its place next to the static engines: they catch different
// bug classes. Static analysis owns reentrancy and dangerous data-flow; fuzzing
// owns ACCOUNTING bugs — rounding, unfunded payouts, solvency invariants that
// drift over many calls — which a pattern matcher cannot see. The fuzzers find
// the breaking SEQUENCE, from plain deposits and withdrawals, with no hand-coded
// attacker and no reentrancy.
//
// Why TWO fuzzers: Echidna (Haskell) and Medusa (Go) share no code and shrink
// differently. We drive both against the SAME generated harness (lib/harness.mjs)
// and merge their results in our ensemble layer (lib/ensemble.mjs). When both
// break the same invariant, that agreement raises the suspect's rank — it never
// substitutes for the replay that makes a finding real.
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runDocker } from "./wrap.mjs";
import { IMG, SOLC, HARNESS_WEI, prepareFuzzProject, weiHexToEth } from "./harness.mjs";
import { medusaScan } from "./medusa.mjs";
import { mergeFuzz } from "./ensemble.mjs";

// Honors the execution backend (local Docker or Daytona), like runTool.
const run = (args, timeoutMs, ws, opts = {}) => runDocker(args, { ws, timeoutMs, maxBuffer: 16 * 1024 * 1024, ...opts });

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

// Run Echidna against the prepared fuzz project and return its broken-invariant
// leads in the normalized fuzz-lead shape (engine-tagged for the ensemble).
// root is the run workspace. The scratch dir is outside it, so the Daytona
// backend needs it to pick that run's machine.
async function echidnaScan(scratch, target, { timeoutMs = 240_000, testLimit = 50_000, root = null } = {}) {
  writeFileSync(
    join(scratch, "echidna.yaml"),
    `testMode: property\ntestLimit: ${testLimit}\nbalanceContract: ${HARNESS_WEI.toString()}\n`,
  );
  const args = [
    "run", "--rm", "--pull=never", "--network", "none",
    "-v", `${scratch}:/work`, "-w", "/work", "--entrypoint", "sh",
    IMG,
    "-c",
    `solc-select use ${SOLC} --always-install >/dev/null 2>&1; echidna Harness.sol --contract Harness --config echidna.yaml --format text 2>&1`,
  ];
  const r = await run(args, timeoutMs, scratch, { root });
  const out = r.stdout + r.stderr;
  // No property line at all means the harness never compiled/ran — honest empty.
  if (!/echidna_\w+:/.test(out)) {
    return { tool: "Echidna", available: false, reason: r.timedOut ? "timed out" : "no result", leads: [], timedOut: r.timedOut };
  }
  const leads = parseEchidna(out)
    .filter((p) => p.broke)
    .map((p) => ({
      engine: "Echidna",
      check: "solvency-violation",
      impact: "High",
      property: p.name,
      where: `${target.contract}.withdraw`,
      contract: target.contract,
      description:
        `The vault's solvency invariant broke under Echidna: it ended holding ` +
        `less than the principal it owes (address(this).balance < ${target.totalVar}). ` +
        `The fuzzer reached this with ordinary deposits and a withdrawal — no ` +
        `attacker contract and no reentrancy.`,
      sequence: p.sequence,
    }));
  return { tool: "Echidna", available: true, leads, timedOut: r.timedOut };
}

// The public fuzz pass: build one harness, drive it with both fuzzers, and merge
// their broken invariants into one ranked suspect list. An invariant both engines
// break is corroborated and ranks first. Returns an honest empty-but-applicable
// scan when the fuzzers broke nothing, or applicable:false when no template fit
// the target — never a fabricated suspect.
export async function fuzzScan(ws, { timeoutMs = 240_000, testLimit = 50_000 } = {}) {
  const proj = prepareFuzzProject(ws);
  if (!proj) {
    return { tool: "Echidna + Medusa", engines: [], template: null, applicable: false, broken: false, findings: [] };
  }
  const { scratch, target } = proj;
  try {
    // Run the two fuzzers in sequence — both invoke crytic-compile into the same
    // scratch, so they must not write over each other concurrently.
    const ech = await echidnaScan(scratch, target, { timeoutMs, testLimit, root: ws }).catch(() => ({ available: false, leads: [] }));
    const med = await medusaScan(scratch, target, { timeoutMs, testLimit: Math.min(testLimit, 20_000), root: ws }).catch(() => ({ available: false, leads: [] }));

    const engines = [];
    if (ech.available) engines.push("Echidna");
    if (med.available) engines.push("Medusa");

    const findings = mergeFuzz([...ech.leads, ...med.leads]);
    return {
      tool: engines.length ? engines.join(" + ") : "Echidna + Medusa",
      engines,
      template: "vault-solvency",
      applicable: true,
      broken: findings.length > 0,
      findings,
      timedOut: Boolean(ech.timedOut || med.timedOut),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// A compact brief the agent reads before it starts hunting. Mirrors staticBrief:
// short, ranked, and explicit that a broken invariant is only a lead. Marks the
// invariants both fuzzers broke. Empty string when nothing broke.
export function fuzzBrief(scan) {
  if (!scan || !scan.findings.length) return "";
  const lines = scan.findings.slice(0, 6).map((f, i) => {
    const seq = f.sequence.length ? `\n     sequence: ${f.sequence.join(" → ")}` : "";
    const agree = f.corroborated ? ` — ${(f.engines || []).join(" + ")} agree` : "";
    return `${i + 1}. [${f.impact}] ${f.check} at \`${f.where}\` (property ${f.property})${agree}${seq}`;
  });
  const who = scan.engines.length ? scan.engines.join(" + ") : "Echidna + Medusa";
  return `Property fuzzing (${who}) broke ${scan.findings.length} invariant(s):\n${lines.join("\n")}`;
}

// The honest caveat for a fuzz pass that could not run. `applicable:false` means
// no invariant template fit the target's shape — the single vault-solvency
// template is the only one that ships — so zero broken invariants is not evidence
// of solvency. The agent must be told, because its own fuzz_findings tool would
// otherwise read "no lead". Returns "" when the pass really did explore.
export function fuzzGap(scan) {
  if (!scan) return "";
  if (scan.applicable !== false) {
    if (scan.timedOut) return "Property fuzzing reached its time limit. Keep any leads it found; zero broken invariants is not a completed pass.";
    return scan.engines?.length ? "" : "Property fuzzing did not run on this target: neither Echidna nor Medusa was available. Zero broken invariants is not a clean result.";
  }
  return `Property fuzzing did not run on this target: the only invariant template we ship is a deposit/withdraw vault (a payable constructor plus a public total), and this code does not match it. Zero broken invariants here says nothing about this code. Do not read it as "solvent" or "safe". Reason about the accounting invariants yourself and prove any break with run_poc.`;
}
