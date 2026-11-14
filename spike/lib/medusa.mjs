// Medusa adapter — the second fuzz engine.
//
// Medusa (Crytic/Trail of Bits) is a Go property fuzzer. We treat it exactly
// like Echidna: a black-box subprocess that drives the SAME generated harness
// (lib/harness.mjs) and tries to break the same echidna_ property. We port no
// source; we run the real binary, hand it the identical property contract by
// pointing its testPrefixes at "echidna_", and translate its text report into
// the one normalized fuzz-lead shape the ensemble merges (lib/ensemble.mjs).
//
// Why a second fuzzer at all: Echidna and Medusa have different internals —
// different mutation, different coverage, different shrinking. When both break
// the same solvency invariant from ordinary calls, that agreement is the
// strongest lead the pipeline can hand the agent short of a proof. The agreement
// raises rank; the deterministic Foundry replay is still the only thing that
// turns a broken invariant into a finding.
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runDocker } from "./wrap.mjs";
import { IMG, SOLC, HARNESS_WEI, weiHexToEth } from "./harness.mjs";

// Honors the execution backend (local Docker or Daytona), like runTool.
const run = (args, timeoutMs, ws, opts = {}) => runDocker(args, { ws, timeoutMs, maxBuffer: 16 * 1024 * 1024, ...opts });

// Medusa's config. We mirror the Echidna run: property mode only (no assertion or
// optimization noise), the harness funded with the same reward buffer, and the
// test prefix pointed at echidna_ so the identical property contract is driven.
// Coverage must stay enabled — Medusa 1.5.1 nil-derefs its coverage tracer when
// it is off — but we route the corpus into the scratch dir and emit no coverage
// report files, so nothing leaks out of the throwaway project.
function medusaConfig(testLimit) {
  return {
    fuzzing: {
      workers: 4,
      testLimit,
      callSequenceLength: 100,
      corpusDirectory: "medusa-corpus",
      coverageEnabled: true,
      coverageFormats: [],
      targetContracts: ["Harness"],
      targetContractsBalances: ["0x" + HARNESS_WEI.toString(16)],
      testing: {
        stopOnFailedTest: true,
        stopOnNoTests: true,
        testViewMethods: true,
        verbosity: 1,
        assertionTesting: { enabled: false },
        propertyTesting: { enabled: true, testPrefixes: ["echidna_"] },
        optimizationTesting: { enabled: false },
      },
    },
    compilation: { platform: "crytic-compile", platformConfig: { target: "Harness.sol" } },
    // We run offline (--network none); never let Medusa reach out to run Slither.
    slither: { useSlither: false },
    logging: { level: "info", noColor: true },
  };
}

// One call in Medusa's reported sequence, rendered like Echidna's so a reader
// sees the same story from either engine. Medusa prints the sequence as
// "N) Harness.deposit(uint8)(11) (block=.., value=<decimal wei>, sender=0x..)".
// The trailing (N) is the actual argument — which of the three users acted — and
// value is the deposit amount in decimal wei.
function renderCall(line) {
  const m = line.match(/^\s*\d+\)\s+Harness\.(\w+)\([^)]*\)\(([^)]*)\)\s*\((.*)\)\s*$/);
  if (!m) return null;
  const fn = m[1];
  const who = m[2].trim();
  const meta = m[3];
  const valDec = (meta.match(/value=(\d+)/) || [])[1];
  const eth = valDec ? weiHexToEth("0x" + BigInt(valDec).toString(16)) : null;
  const user = who !== "" ? `user ${who}` : "a user";
  if (fn === "deposit") return `${user} deposits${eth ? ` ${eth}` : ""}`;
  if (fn === "withdraw") return `${user} withdraws`;
  return `${fn}(${who})`;
}

// Parse Medusa's text report: which echidna_ properties it broke, and the shrunk
// call sequence for each. We read only the [Call Sequence] block (the lead the
// agent reads), stopping at the execution trace that follows it.
function parseMedusa(text) {
  const lines = text.split("\n");
  const props = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(/\[FAILED\]\s+Property Test:\s+Harness\.(echidna_\w+)\(\)/);
    if (!head) continue;
    const name = head[1];
    // Advance to the [Call Sequence] marker, then collect its numbered lines.
    let j = i + 1;
    while (j < lines.length && !/\[Call Sequence\]/.test(lines[j])) j++;
    const seq = [];
    for (j = j + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (!t || /^\[/.test(t)) break; // [Execution Trace] / [Property Test...] ends it
      const human = renderCall(lines[j]);
      if (human) seq.push(human);
    }
    props.push({ name, sequence: seq });
  }
  return props;
}

// Run Medusa over the prepared fuzz project and return its broken-invariant leads
// in the normalized fuzz-lead shape. `scratch` is the shared project built by
// prepareFuzzProject — the SAME sources and Harness.sol Echidna ran against.
// Returns an honest empty result (available true, leads []) when Medusa ran but
// broke nothing, or available false when it never produced a result at all.
// root is the run workspace (see echidnaScan in fuzz.mjs).
export async function medusaScan(scratch, target, { timeoutMs = 240_000, testLimit = 20_000, root = null } = {}) {
  writeFileSync(join(scratch, "medusa.json"), JSON.stringify(medusaConfig(testLimit), null, 2));
  const args = [
    "run", "--rm", "--pull=never", "--network", "none",
    "-v", `${scratch}:/work`, "-w", "/work", "--entrypoint", "sh",
    IMG,
    "-c",
    `solc-select use ${SOLC} --always-install >/dev/null 2>&1; medusa fuzz --config medusa.json 2>&1`,
  ];
  const r = await run(args, timeoutMs, scratch, { skipBack: ["medusa-corpus"], root });
  const out = r.stdout + r.stderr;
  // Clear the corpus Medusa wrote into the scratch so a later engine or rerun
  // starts clean; the whole scratch is removed by the caller regardless.
  rmSync(join(scratch, "medusa-corpus"), { recursive: true, force: true });

  // A clean "test summary" with no FAILED line means Medusa ran but broke nothing.
  // No summary at all means it never compiled/ran — report unavailable so the
  // ensemble notes only one fuzzer ran rather than implying the vault is sound.
  const ran = /Test summary:/.test(out) || /\[(PASSED|FAILED)\]\s+Property Test/.test(out);
  if (!ran) return { tool: "Medusa", available: false, reason: r.timedOut ? "timed out" : "no result", leads: [], timedOut: r.timedOut };

  const leads = parseMedusa(out).map((p) => ({
    engine: "Medusa",
    check: "solvency-violation",
    impact: "High",
    property: p.name,
    where: `${target.contract}.withdraw`,
    contract: target.contract,
    description:
      `The vault's solvency invariant broke under Medusa: it ended holding less ` +
      `than the principal it owes (address(this).balance < ${target.totalVar}). ` +
      `A second, independent fuzzer reached this from ordinary deposits and a ` +
      `withdrawal — no attacker contract and no reentrancy.`,
    sequence: p.sequence,
  }));
  return { tool: "Medusa", available: true, leads, timedOut: r.timedOut };
}
