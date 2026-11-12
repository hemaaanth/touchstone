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
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { writePoc, forgeTestJson } from "./sandbox.mjs";
import { extractControlTrace, controlTakeovers } from "./control-trace.mjs";

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
//
// Every replay runs at full state verbosity (-vvvvv): the harm gate needs the
// storage writes. `stateTrace` only decides whether the large controlTrace is
// kept on the returned delta (packs that judge control harm themselves ask).
export async function proofDelta(ws, { source, contract, timeoutMs = 180_000, stateTrace = false } = {}) {
  if (source) writePoc(ws, source);
  const { raw, timedOut } = await forgeTestJson(ws, { matchContract: contract, timeoutMs, stateTrace: true });
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (!parsed) return null;
  const hit = findResult(parsed, contract);
  if (!hit) return null;
  const r = hit.result;
  const flows = netFlows(r.traces);
  const transfers = transferTable(flows, lowerKeys(r.labeled_addresses));
  const controlTrace = extractControlTrace(r.traces);
  const harm = judgeHarm(r.traces, { scope: scopeCode(ws), controlTrace });
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
    // The engine's harm verdict for this replay. See judgeHarm.
    harm,
    // Only when asked: the replay state diff, for packs that judge control harm.
    ...(stateTrace ? { controlTrace } : {}),
    timedOut,
  };
}

function lowerKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[k.toLowerCase()] = v;
  return out;
}

// ---------------------------------------------------------------- harm gate
//
// A passing test is not a proof. `assertTrue(true)` passes too. A forge finding
// is proven only when the replay shows BOTH:
//   1. the test made a successful call into a scope target, and
//   2. an effect on a scope target the gate accepts as harm, by EITHER channel:
//      - funds:   a target's net ETH went DOWN during the test body, or
//      - control: the test body re-pointed one of a target's CONTROL slots — the
//        owner slot, the EIP-1967 admin or implementation — to a new address, by a
//        caller that did not already hold that authority (a takeover, not a write).
// Access-control takeovers and proxy hijacks move no ETH; they re-point a control
// pointer, so the control channel proves them. A benign state write — a deposit's
// balance, a counter, a flag — is NOT a control takeover and proves nothing.
//
// A scope target is a contract the replay CREATEd from code compiled out of the
// scope: src/ (a lab) or vendor/ (fetched members). Contracts defined in the test
// file, forge-std, the test contract and the cheatcode VM are never targets. A
// target overwritten with vm.etch — in the test body OR in setUp() — is no longer
// the scope's code, so it stops being a target.
//
// Known limits, on purpose for this cycle:
// - The funds channel sees native ETH only. A token-balance move that makes no
//   target storage write (rare: balances live in the token's storage) is not
//   seen. Measuring token balances is a later cycle.
// - The control channel counts ANY target storage write in the test body, so a
//   plain `deposit` also counts. It does not yet tell a privileged or owner write
//   from an ordinary one. The gate rejects tests that touch nothing; it does not
//   judge intent. Packs with a lab model (keys, chain-watch) pass their own
//   stricter judge to proveFindings.
// - A test that funds the target itself in setUp() and withdraws only its own
//   balance in the body is accepted as funds. Setup funding is left out of the net
//   on purpose: that exclusion is what keeps victim-funded drains provable, so do
//   not "fix" it by netting setUp flows in.

const lc = (v) => String(v ?? "").toLowerCase();
const hex = (v) => lc(v).replace(/^0x/, "");
const SCOPE_ROOTS = ["src/", "vendor/"];

// The `out` directory named in foundry.toml, else "out".
function outDir(ws) {
  try {
    const m = readFileSync(join(ws, "foundry.toml"), "utf8").match(/^\s*out\s*=\s*["']([^"']+)["']/m);
    if (m && !m[1].includes("..")) return join(ws, m[1]);
  } catch { /* default below */ }
  return join(ws, "out");
}

// Creation bytecode of every contract compiled from the scope roots, read from
// forge's build artifacts after the replay. Returns [{ name, path, code }], code
// as lowercase hex without 0x. An empty list means no target can match, so the
// gate fails closed.
export function scopeCode(ws) {
  const dir = outDir(ws);
  const out = [];
  if (!existsSync(dir)) return out;
  const walk = (d, depth) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "build-info" && depth < 4) walk(p, depth + 1); continue; }
      if (!e.name.endsWith(".json")) continue;
      let art;
      try { art = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
      const target = art?.metadata?.settings?.compilationTarget ?? {};
      const [path, name] = Object.entries(target)[0] ?? [];
      const code = hex(art?.bytecode?.object);
      if (!path || !code || !SCOPE_ROOTS.some((r) => path.startsWith(r))) continue;
      out.push({ name, path, code });
    }
  };
  walk(dir, 0);
  return out;
}

// True when `init` (CREATE input) starts with `code`. A library-link
// placeholder (__$…$__, 40 hex chars) in `code` matches anything.
function startsWithCode(init, code) {
  if (init.length < code.length) return false;
  for (let i = 0; i < code.length; i++) {
    if (code.startsWith("__$", i)) { i += 39; continue; }
    if (code[i] !== init[i]) return false;
  }
  return true;
}

// Walk one replay. Returns the scope targets it created, whether the test body
// called one, and each target's net ETH over the test body only (Setup funding
// is the fixture, not the exploit).
function scanTargets(traces, scope) {
  const targets = new Map(); // address -> contract name
  const bodies = [];
  for (const entry of Array.isArray(traces) ? traces : []) {
    const label = Array.isArray(entry) ? entry[0] : null;
    const arena = (Array.isArray(entry) ? entry[1] : entry)?.arena;
    if (!Array.isArray(arena)) continue;
    for (const node of arena) {
      const t = node?.trace ?? {};
      if (t.kind !== "CREATE" && t.kind !== "CREATE2") continue;
      if (!t.success || !t.address) continue;
      const init = hex(t.data);
      const hit = scope.find((c) => startsWithCode(init, c.code));
      if (hit) targets.set(lc(t.address), hit.name);
    }
    if (label === "Execution") bodies.push(arena);
  }
  let invoked = false;
  const net = new Map();
  for (const arena of bodies) {
    const ok = (i) => { for (let n = arena[i]; n; n = arena[n.parent]) if (!n.trace?.success) return false; return true; };
    arena.forEach((node, i) => {
      const t = node?.trace ?? {};
      if (t.kind === "CREATE" || t.kind === "CREATE2" || !ok(i)) return;
      const to = lc(t.address), from = lc(t.caller);
      if (targets.has(to)) invoked = true;
      let wei = 0n;
      try { wei = BigInt(t.value ?? "0x0"); } catch { wei = 0n; }
      if (wei > 0n && t.kind === "CALL") {
        if (targets.has(to)) net.set(to, (net.get(to) ?? 0n) + wei);
        if (targets.has(from)) net.set(from, (net.get(from) ?? 0n) - wei);
      }
    });
  }
  return { targets, invoked, net };
}

// The generic harm verdict for one forge replay. Pure: traces + scope code in,
// { ok, kind, targets, ... } out. `controlTrace` is extractControlTrace(traces).
export function judgeHarm(traces, { scope = [], controlTrace = null } = {}) {
  const { targets, invoked, net } = scanTargets(traces, scope);
  for (const e of controlTrace?.etches ?? []) targets.delete(lc(e.target));
  const names = [...targets.entries()].map(([address, name]) => ({ address, name }));
  if (!targets.size) return { ok: false, reason: "the replay deployed no contract from the audited scope (src/ or vendor/), so it proves nothing about the target", targets: names };
  if (!invoked) return { ok: false, reason: "the test never made a successful call into a scope target", targets: names };
  const losses = [...net.entries()].filter(([a, w]) => targets.has(a) && w < 0n).sort((a, b) => (a[1] < b[1] ? -1 : 1));
  const takeovers = controlTakeovers(controlTrace, targets);
  if (losses.length) {
    const [victim, wei] = losses[0];
    return { ok: true, kind: "funds", victim, lostWei: (-wei).toString(), targets: names, ...(takeovers.length ? { writes: takeovers.length } : {}) };
  }
  if (takeovers.length) return { ok: true, kind: "control", victim: lc(takeovers[0].context), writes: takeovers.length, targets: names };
  return { ok: false, reason: "the test called a scope target but moved no ETH out of it and took over none of its control slots (owner, EIP-1967 admin or implementation)", targets: names };
}
