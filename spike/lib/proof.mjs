// Structured proof delta — read straight from the real Foundry replay.
//
// A finding is real only when the agent's own test passes a deterministic replay.
// That replay already happened; here the engine runs it ONE more time in JSON
// trace mode (`forge test --json -vvvv`, see lib/sandbox.mjs) and reads the money
// the EVM actually moved out of the machine's own output — not out of the test's
// source text.
//
// Why this matters for "ours": the app used to reconstruct the balance story by
// regex over the test SOURCE — matching literals like `100 ether` and `.balance,
// 0`. That reads what the test was WRITTEN to assert, not what the chain DID. The
// proof delta instead sums the signed ETH value of every successful call in the
// real trace, per address. The result is the exploit's true economics — who
// gained, who was drained, by how much — computed by the engine from the replay,
// with zero cooperation from the agent's test and no source-string guessing.
import { writePoc, forgeTestJson } from "./sandbox.mjs";
import { extractControlTrace } from "./control-trace.mjs";

// Foundry's fixed framework addresses. These are not economic actors in the
// exploit: the cheatcode VM never holds ETH, so its flows are noise. We keep the
// default test contract and sender in the table (an agent PoC often drives the
// attack FROM the test contract and receives the loot there) but label them so
// the operator reads them as scaffolding, not a third victim.
const VM_CHEATCODE = "0x7109709ecfa91a80626ff3989d68f67f5b1dd12d";

// Parse Foundry's duration/gas and decoded logs for one test result object.
function readGas(kind) {
  if (!kind || typeof kind !== "object") return null;
  // kind is a one-key object: { Unit: { gas } } | { Fuzz: { ... } } | ...
  const inner = Object.values(kind)[0];
  return inner && typeof inner.gas === "number" ? inner.gas : null;
}

// Walk one test's call traces and sum the signed ETH value of every successful
// value-bearing call, per address. The callee gains value; the caller loses it.
// Returns a map address -> net wei (BigInt), plus the set of addresses that were
// CREATEd during execution and the top-level test contract, for labelling.
export function netFlows(traces) {
  const net = new Map();
  const created = new Set();
  let testContract = null;
  const add = (addr, delta) => {
    if (!addr) return;
    const a = addr.toLowerCase();
    net.set(a, (net.get(a) ?? 0n) + delta);
  };
  for (const entry of Array.isArray(traces) ? traces : []) {
    // Each entry is [label, { arena: [node, ...] }].
    const label = Array.isArray(entry) ? entry[0] : null;
    const arena = (Array.isArray(entry) ? entry[1] : entry)?.arena;
    if (!Array.isArray(arena)) continue;
    // A transfer is real only if the WHOLE parent chain returned. A sub-call can
    // succeed and still be rolled back when an ancestor reverts; the EVM undoes
    // its value move, so we must not count it. (Mirrors control-trace.mjs `ok`.)
    const ok = (i) => { for (let n = arena[i]; n; n = arena[n.parent]) if (!n.trace?.success) return false; return true; };
    arena.forEach((node, i) => {
      const t = node?.trace ?? {};
      const addr = (t.address || "").toLowerCase();
      const caller = (t.caller || "").toLowerCase();
      if (label === "Execution" && i === 0 && addr) testContract = addr;
      if (t.kind === "CREATE" && addr) created.add(addr);
      // Only CALL and CREATE move fresh ETH. A DELEGATECALL/CALLCODE/STATICCALL
      // node carries the inherited msg.value of the frame it runs in, which was
      // already counted at the parent CALL — counting it again fabricates flow.
      if (t.kind !== "CALL" && t.kind !== "CREATE" && t.kind !== "CREATE2") return;
      let wei = 0n;
      try { wei = BigInt(t.value ?? "0x0"); } catch { wei = 0n; }
      if (wei > 0n && t.success && ok(i)) { add(addr, wei); add(caller, -wei); }
    });
  }
  return { net, created, testContract };
}

// Render a wei BigInt as a signed ETH figure for the money-moved table.
function ethStr(wei) {
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const whole = abs / 10n ** 18n;
  const frac = (abs % 10n ** 18n) / 10n ** 14n; // 4 decimal places
  const body = frac === 0n ? `${whole}` : `${whole}.${frac.toString().padStart(4, "0").replace(/0+$/, "")}`;
  return `${neg ? "-" : "+"}${body} ETH`;
}

// Turn the net-flow map into a labelled, signed transfer table: one row per
// address that ended up with a different balance, biggest gain first, framework
// cheatcode dropped. Each row is the REAL net ETH that address moved during the
// proven exploit.
function transferTable({ net, created, testContract }, labeled = {}) {
  const rows = [];
  for (const [addr, wei] of net.entries()) {
    if (addr === VM_CHEATCODE || wei === 0n) continue;
    let label;
    if (labeled[addr]) label = labeled[addr];
    else if (addr === testContract) label = "Exploit test contract";
    else if (created.has(addr)) label = "Deployed contract";
    else label = "Account";
    rows.push({ address: addr, label, net: ethStr(wei), netWei: wei.toString(), gained: wei > 0n });
  }
  // Biggest mover first by absolute size, gains before losses on ties.
  rows.sort((a, b) => {
    const av = BigInt(a.netWei), bv = BigInt(b.netWei);
    const aa = av < 0n ? -av : av, ba = bv < 0n ? -bv : bv;
    if (aa !== ba) return aa > ba ? -1 : 1;
    return a.gained === b.gained ? 0 : a.gained ? -1 : 1;
  });
  return rows;
}

// Find the one test result for the proving contract inside forge's JSON. The
// top-level keys are "path:Contract"; each holds test_results keyed by function
// signature. We take the contract the finding named so the delta binds to the
// SUBMITTED proof, not any test that happened to run.
function findResult(parsed, contract) {
  for (const [suite, sd] of Object.entries(parsed || {})) {
    const name = suite.split(":").pop();
    if (contract && name !== contract) continue;
    const results = sd?.test_results ?? {};
    // Prefer a passing test; otherwise the first one, so a failed replay still
    // reports honestly.
    const entries = Object.entries(results);
    const pass = entries.find(([, r]) => r?.status === "Success");
    const chosen = pass ?? entries[0];
    if (chosen) return { suite, test: chosen[0], result: chosen[1] };
  }
  return null;
}

// Run the engine's structured proof pass against a prepared workspace that
// already holds the proving test, and return the real proof delta. `contract` is
// the submitted test contract. Returns null when the replay produced no parsable
// JSON (e.g. the test no longer compiles) so the caller can fall back to the
// source-derived view for older runs.
export async function proofDelta(ws, { source, contract, timeoutMs = 180_000, stateTrace = false } = {}) {
  if (source) writePoc(ws, source);
  const { raw, timedOut } = await forgeTestJson(ws, { matchContract: contract, timeoutMs, stateTrace });
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (!parsed) return null;
  const hit = findResult(parsed, contract);
  if (!hit) return null;
  const r = hit.result;
  const flows = netFlows(r.traces);
  const transfers = transferTable(flows, lowerKeys(r.labeled_addresses));
  return {
    tool: "Foundry",
    source: "engine-replay",
    contract,
    test: hit.test,
    status: r.status === "Success" ? "pass" : "fail",
    pass: r.status === "Success",
    reason: r.reason || null,
    gasUsed: readGas(r.kind),
    // The real runtime log lines the test emitted, verbatim — machine output,
    // never source.
    logs: Array.isArray(r.decoded_logs) ? r.decoded_logs : [],
    // The signed money-moved table, computed from the real trace.
    transfers,
    // Only when asked: the replay state diff, for packs that judge control harm.
    ...(stateTrace ? { controlTrace: extractControlTrace(r.traces) } : {}),
    timedOut,
  };
}

function lowerKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[k.toLowerCase()] = v;
  return out;
}
