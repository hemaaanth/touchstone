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
import { writePoc, forgeTestJson, FORGE_OUTPUT_CAP } from "./sandbox.mjs";
import { extractControlTrace, controlTakeovers, word, asAddress, isAddressWord, ADMIN_SLOT, IMPLEMENTATION_SLOT } from "./control-trace.mjs";
import { judgePinnedHarm, pinnedTargets } from "./oracle-deployed.mjs";
import { judgeLocked } from "./oracle-locked.mjs";
import { keccak256 } from "ethers";
// The one amount formatter the console and the report share, so the engine never
// shows a harm number cut: exact when it fits six significant decimals, else
// rounded to nearest and marked "≈", dust in wei (see app/src/lib/amount.mjs).
import { formatAmount } from "../../app/src/lib/amount.mjs";

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
      if ((t.kind === "CREATE" || t.kind === "CREATE2") && addr) created.add(addr); // CREATE2 too (a salted deploy is still the test's contract)
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
  return formatAmount(wei.toString(), { signed: true }).text;
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
// source-derived view for older runs. A replay whose output was larger than the
// cap (FORGE_OUTPUT_CAP) returns a failed proof with TRACE_TOO_LARGE as the
// reason, never a verdict on the cut trace.
//
// Every replay runs at full state verbosity (-vvvvv): the harm gate needs the
// storage writes. `stateTrace` only decides whether the large controlTrace is
// kept on the returned delta (packs that judge control harm themselves ask).
export async function proofDelta(ws, { source, contract, timeoutMs = 180_000, stateTrace = false, pin = null } = {}) {
  if (source) writePoc(ws, source);
  const { raw, timedOut, overflow } = await forgeTestJson(ws, { matchContract: contract, timeoutMs, stateTrace: true });
  // The replay output was larger than the cap, so it was cut. A cut trace is never
  // judged: the proof fails, and the reason tells the agent how to repair the PoC.
  if (overflow) return traceTooLarge(contract, timedOut);
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (!parsed) return null;
  const hit = findResult(parsed, contract);
  if (!hit) return null;
  const r = hit.result;
  const flows = netFlows(r.traces);
  const transfers = transferTable(flows, lowerKeys(r.labeled_addresses));
  const controlTrace = extractControlTrace(r.traces);
  // Two oracles, one verdict. The offline channels look for harm to a contract the
  // test deployed from source. When the run carries a chain PIN, the deployed
  // oracle looks for harm to a real address instead (lib/oracle-deployed.mjs), and
  // the two are combined: either may prove, and the pinned one never relaxes the
  // offline rules. A run with no pin takes exactly the old path.
  //
  // The pin is read from the workspace config, not from an argument, so no caller
  // can replay a forked run's proof under the offline rules by forgetting to pass
  // it: the run's own record decides.
  const offline = judgeHarm(r.traces, { scope: scopeCode(ws), controlTrace, layouts: scopeLayouts(ws), balances: scopeBalances(ws) });
  const cfgPin = pin ?? (() => { try { return JSON.parse(readFileSync(join(ws, ".touchstone.json"), "utf8"))?.forkTargets ?? null; } catch { return null; } })();
  const pinned = pinnedTargets(cfgPin);
  const deployed = pinned ? judgePinnedHarm(r.traces, { pinned, net: scanTargets(r.traces, scopeCode(ws)).net, controlTrace }) : null;
  // The locked channel: value that is stuck rather than transferred. It is tried only
  // when the transfer channels found nothing, because a drain that succeeds is
  // already the better finding, and a lock is what is left when nothing moved.
  const locked = offline.ok ? null : judgeLocked(r.traces, { ws, targets: scanTargets(r.traces, scopeCode(ws)).targets });
  const harm = deployed?.ok ? deployed : offline.ok ? offline : locked?.ok ? locked : offline;
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

export const TRACE_TOO_LARGE = `the replay trace is larger than ${FORGE_OUTPUT_CAP / 1048576} MiB, so it was cut and the gate does not judge it. That is the harness ceiling, not a judgement on the bug: the test does an enormous number of state-writing steps. Two ways forward. (1) Keep the same root cause but make the test shorter: attack with ONE decisive call where the contract allows it, or start the fixture in setUp() so the body holds only the attack. A forge-std deal(token, …) in the test BODY costs about 10 MiB per call, so move it to setUp(). (2) If the bug genuinely needs a long loop (a dust theft repeated hundreds of times), record it with submit_candidate and say so: the proof model cannot measure it, but a human can read the loop. Do not discard it.`;
function traceTooLarge(contract, timedOut) {
  const harm = { ok: false, reason: TRACE_TOO_LARGE, targets: [] };
  return { tool: "Foundry", source: "engine-replay", contract, test: null, status: "fail", pass: false, reason: TRACE_TOO_LARGE, gasUsed: null, logs: [], transfers: [], harm, timedOut };
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
//   2. an effect on a scope target the gate accepts as harm, by ANY channel:
//      - funds (ETH):   a target's net native ETH went DOWN during the test body;
//      - funds (token): a target was a net LOSER of an ERC-20 token in the body.
//        The loss is the balance-slot decrease when the compiled layout names that
//        slot (see balanceDrains). A `Transfer` log is only a fallback, and only
//        when it is authenticated (see tokenDrains): the emitter is a scope
//        token (the replay is offline, so no real external ERC-20 can exist —
//        any non-scope emitter was placed by the test) and that token's storage
//        shows the victim's balance slot decreased. A log the test contract
//        emits, or that a contract the test created, etched or cloned emits,
//        proves nothing; or
//      - control: the test body re-pointed one of a target's CONTROL slots to a
//        new address, by a caller that did not already hold that authority (a
//        takeover, not an ordinary write). Which slots are control pointers comes
//        from the compiled storage layout — the named owner/admin/governor address
//        variable of that contract, in WHATEVER slot it lives, plus the EIP-1967
//        admin and implementation slots — so a counter or a flag in slot 0 is
//        never mistaken for an owner, and an owner outside slot 0 is still found.
// Access-control takeovers and proxy hijacks move no ETH; they re-point a control
// pointer, so the control channel proves them. A benign state write — a deposit's
// balance, a counter, a flag — touches no control slot and proves nothing.
//
// A scope target is a contract the replay CREATEd from code compiled out of the
// scope: src/ (a lab) or vendor/ (fetched members). Contracts defined in the test
// file, forge-std, the test contract and the cheatcode VM are never targets. A
// target overwritten with vm.etch — in the test body OR in setUp() — is no longer
// the scope's code, so it stops being a target.
//
// Known limits, on purpose for this cycle:
// - The token channel measures fungible ERC-20 value only. An NFT (ERC-721) theft
//   emits a Transfer with an indexed tokenId and no value, so it is not counted as
//   a drain; per-token-id accounting is a later cycle.
// - A control variable packed ABOVE offset 0 in its slot (an address sharing a
//   slot with another field) is left out: we only read a clean 20-byte address
//   word, so we miss an exotic packing rather than misread it. This keeps the gate
//   free of false takeovers at the cost of a rare miss.
// - Control slots are judged from the layout only when the build artifact carries
//   one (`--extra-output storageLayout`). An older artifact with no layout falls
//   back to the EIP-1967-only view in control-trace.mjs. Packs with a lab model
//   (keys, chain-watch) still pass their own judge to proveFindings.
// - A test that funds the target itself in setUp() and withdraws only its own
//   balance in the body is accepted as funds. Setup funding is left out of the net
//   on purpose: that exclusion is what keeps victim-funded drains provable, so do
//   not "fix" it by netting setUp flows in. The same holds for a token: a balance
//   minted in setUp and moved out in the body still counts, because the body's
//   SSTORE carries the funded balance as its old value.
// - The Transfer-log fallback, used when the layout does not name the balance,
//   only searches mapping bases 0..31. A namespaced (ERC-7201) or higher base on
//   an external token is missed rather than trusting an unverified log.

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

// The access-control roots a storage variable name can carry. A contract's
// authority lives behind one of these: the owner, the admin, the governor. We
// match the NAME, not a slot position, so an owner in any slot is found and a
// same-shaped counter in slot 0 is not. Leading underscores (OZ `_owner`) are
// stripped before the test.
const CONTROL_NAMES = /^(owner|pendingowner|admin|proxyadmin|governor|governance|authority|guardian)$/;

// Read the compiled storage layout of every scope contract (forge wrote it with
// `--extra-output storageLayout`, see lib/sandbox.mjs). Returns a Map
//   contract name -> Set of 32-byte slot words that hold an ADDRESS-typed control
//   variable (owner/admin/governor) packed at offset 0.
// This is the sound signal the harm gate uses to tell a control pointer from an
// ordinary state word: a uint counter and an address are indistinguishable at the
// word level, but the layout names the type. A slot that packs the address above
// offset 0 is left out on purpose — we only extract a clean 20-byte address word,
// so we would rather miss an exotic packing than misread it. An empty map (older
// artifacts without a layout) makes the gate fall back to its EIP-1967-only view.
export function scopeLayouts(ws) {
  const dir = outDir(ws);
  const byName = new Map();
  if (!existsSync(dir)) return byName;
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
      if (!path || !name || !SCOPE_ROOTS.some((r) => path.startsWith(r))) continue;
      const layout = art?.storageLayout;
      if (!layout || !Array.isArray(layout.storage)) continue;
      const slots = new Set();
      // How many variables share each slot. An owner at offset 0 is only a clean
      // 32-byte address word when it has the slot to ITSELF; if another field
      // (e.g. `bool paused`) packs in above it, the live word is owner|otherField,
      // which is not address-shaped and defeats both the takeover compare and the
      // SLOAD entitlement fold. We skip those on purpose, same as offset != 0.
      const slotCount = new Map();
      for (const s of layout.storage) slotCount.set(String(s.slot), (slotCount.get(String(s.slot)) ?? 0) + 1);
      for (const s of layout.storage) {
        if (Number(s.offset) !== 0) continue; // only a clean, unpacked address word
        if ((slotCount.get(String(s.slot)) ?? 1) > 1) continue; // a field packs in above the owner — not a clean address word
        const varName = String(s.label ?? "").replace(/^_+/, "").toLowerCase();
        if (!CONTROL_NAMES.test(varName)) continue;
        const t = layout.types?.[s.type];
        if (!t || t.encoding !== "inplace") continue; // not a mapping / dynamic / struct member
        const tl = String(t.label ?? "");
        if (tl !== "address" && tl !== "address payable" && !tl.startsWith("contract ")) continue; // must be address-typed (incl. `address payable`)
        let slotWord;
        try { slotWord = word("0x" + BigInt(s.slot).toString(16)); } catch { continue; }
        slots.add(slotWord);
      }
      if (slots.size) byName.set(name, slots);
    }
  };
  walk(dir, 0);
  return byName;
}

// The address-keyed balance mappings of every scope contract, read from the same
// compiled layout. Returns Map(contract name -> Array of 32-byte base-slot words),
// one entry per `mapping(address => <uint>)` whose NAME looks like a balance or
// share holding. This is the GROUND-TRUTH signal the token-drain gate uses: a
// drain is read straight from the victim's balance storage, so it is proven even
// when the token emits no `Transfer` log — an in-scope token can omit or fake the
// event, but its balance slots cannot lie. Non-balance maps are excluded two ways:
// the name filter (so a nonce/timestamp map is skipped) and the uint-value check
// (so an allowance map, whose value is itself a mapping, is skipped).
// Anchored to the WHOLE name (after stripping underscores), not a prefix: a prefix
// match would also keep `depositTime`, `stakeStart`, `creditLimit` and
// `balanceSnapshotBlock` — uint maps that are not balances — and net a benign reset
// of one as a "drain". We accept the ERC-20 names and their plural/`Of` forms only.
const BALANCE_NAMES = /^(bal|balanceof|balances?|shares?|deposits?|stakes?|holdings?|credits?)$/;
export function scopeBalances(ws) {
  const dir = outDir(ws);
  const byName = new Map();
  if (!existsSync(dir)) return byName;
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
      if (!path || !name || !SCOPE_ROOTS.some((r) => path.startsWith(r))) continue;
      const layout = art?.storageLayout;
      if (!layout || !Array.isArray(layout.storage)) continue;
      const slots = [];
      for (const s of layout.storage) {
        const varName = String(s.label ?? "").replace(/^_+/, "").toLowerCase();
        if (!BALANCE_NAMES.test(varName)) continue;
        const t = layout.types?.[s.type];
        if (!t || t.encoding !== "mapping") continue;
        const kt = layout.types?.[t.key];
        if (!/address/.test(String(kt?.label ?? t.key ?? ""))) continue; // key must be an address
        const vt = layout.types?.[t.value];
        if (!/^uint/.test(String(vt?.label ?? ""))) continue; // value must be a plain uint, not a nested map/struct
        let slotWord;
        try { slotWord = word("0x" + BigInt(s.slot).toString(16)); } catch { continue; }
        slots.push(slotWord);
      }
      if (slots.length) byName.set(name, slots);
    }
  };
  walk(dir, 0);
  return byName;
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

// ERC-20 `Transfer(address indexed from, address indexed to, uint256 value)`.
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topicAddr = (t) => { const h = hex(t); return h.length >= 40 ? "0x" + h.slice(-40) : null; };

// Solidity `mapping(address => uint)` slot: keccak256(abi.encode(holder, base)).
function mappingSlot(holder, base) {
  return word(keccak256(word(holder) + String(base).slice(2)));
}

// The test contract and every contract this replay deployed. The test contract is
// the root call of the Execution trace. It is not always itself a CREATE in the
// trace the gate sees, so "was it created?" is not a substitute for this.
function replayParties(traces) {
  let testContract = null;
  const created = new Set();
  for (const entry of Array.isArray(traces) ? traces : []) {
    const label = Array.isArray(entry) ? entry[0] : null;
    const arena = (Array.isArray(entry) ? entry[1] : entry)?.arena;
    if (!Array.isArray(arena)) continue;
    arena.forEach((node, i) => {
      const t = node?.trace ?? {};
      const addr = lc(t.address);
      if (label === "Execution" && i === 0 && addr) testContract = addr;
      // CREATE2 as well as CREATE. A fake token deployed with a salt is still
      // the test's contract; controlTrace.created only records CREATE.
      if ((t.kind === "CREATE" || t.kind === "CREATE2") && addr) created.add(addr);
    });
  }
  return { testContract, created };
}

// A Transfer log proves a token movement only when its emitter IS the token.
// The test contract can log whatever it likes. So can a contract it deployed
// that is not a scope target (CREATE or CREATE2), and so can an address whose
// code it etched. A scope target is the audited token, including one the test
// deployed in setUp — that is the ONLY emitter we trust.
//
// The replay runs offline, in a fresh sandbox with no fork: no real external
// ERC-20 can exist there. So any emitter that is NOT a scope target was put on
// the chain by the test itself — as the test contract, a CREATE/CREATE2, an
// `etch`, or a `cloneAccount`/7702 delegation that lands code at a "pre-existing"
// address. None of those is the audited token, so none authenticates a drain.
// We therefore trust only a scope target and reject every other emitter. An
// etched or cloned target is no scope target: judgeHarm removes it from
// `targets` before any channel runs, so it fails `targets.has` below.
function realTokenEmitter(token, targets, testContract, created) {
  if (!token || token === testContract) return false;
  if (targets.has(token)) return true;
  if (created.has(token)) return false;
  return false;
}

// Where an address-keyed balance can live. The compiled layout is authoritative
// when it names one for this token: a write to a different base is not that
// balance, and trusting it would let the token point at a slot it never uses.
// With no layout (an external token, or a balance under a name we don't track)
// the ordinary ERC-20 slots are the low ones. Namespaced and high bases are a
// miss, not a reason to trust the log. See the known limit above.
const LOW_BALANCE_BASES = Array.from({ length: 32 }, (_, i) => word("0x" + i.toString(16)));
function balanceBases(token, targets, balances) {
  const known = balances?.get(targets.get(token) ?? "");
  return known?.length ? known : LOW_BALANCE_BASES;
}

// Units of `token` that `holder` lost in the test body, from the balance slots.
// 0 when none decreased. `writes` is controlTrace.writes: body only, success
// gated, constructors excluded. A setUp mint is therefore absent, but the body's
// SSTORE still has the funded balance as `before`, so the decrease counts.
function storedBalanceLoss(writes, token, holder, bases) {
  let loss = 0n;
  for (const base of bases) {
    const slot = mappingSlot(holder, base);
    let net = 0n;
    let saw = false;
    for (const w of writes) {
      if (lc(w.context) !== token || word(w.slot) !== slot) continue;
      saw = true;
      try { net += BigInt(w.after) - BigInt(w.before); } catch { /* malformed word */ }
    }
    if (saw && -net > loss) loss = -net;
  }
  return loss;
}

// The token-drain channel. The native-ETH funds channel sees `t.value` only, so a
// drain of ERC-20 balances — the most common DeFi harm — is invisible to it. Here
// we read Transfer logs the EVM emitted in the test body and net them per
// (token, holder). A log is not itself the harm. It counts only when
// `realTokenEmitter` accepts the emitter AND that token's storage shows the
// victim's balance slot decreased by a real SSTORE in the body. The reported
// loss is the smaller of the two, so a log cannot inflate a one-unit write and
// a write cannot inflate a one-unit log. A scope target that is then a net LOSER
// of a token it does not itself issue was drained. Body only, success-gated —
// the same rules the ETH channel uses, so setUp funding is fixture and a
// rolled-back transfer does not count. Returns [{ token, victim, lostUnits }],
// biggest loss first.
function tokenDrains(traces, targets, controlTrace, balances) {
  const { testContract, created } = replayParties(traces);
  const writes = controlTrace?.writes ?? [];
  const net = new Map(); // token -> Map(holder -> signed units)
  const bump = (token, holder, delta) => {
    if (!holder) return;
    const m = net.get(token) ?? new Map();
    m.set(holder, (m.get(holder) ?? 0n) + delta);
    net.set(token, m);
  };
  for (const entry of Array.isArray(traces) ? traces : []) {
    if ((Array.isArray(entry) ? entry[0] : null) !== "Execution") continue;
    const arena = (Array.isArray(entry) ? entry[1] : entry)?.arena;
    if (!Array.isArray(arena)) continue;
    const ok = (i) => { for (let n = arena[i]; n; n = arena[n.parent]) if (!n.trace?.success) return false; return true; };
    arena.forEach((node, i) => {
      if (!ok(i)) return;
      const t = node?.trace ?? {};
      // LOG's address is the account whose code is executing. A DELEGATECALL
      // runs the callee's code in the caller's account, which is also where
      // extractControlTrace records the SSTORE (the storage context).
      const token = (t.kind === "DELEGATECALL" || t.kind === "CALLCODE") ? lc(t.caller) : lc(t.address);
      if (!token || !realTokenEmitter(token, targets, testContract, created)) return;
      for (const log of node?.logs ?? []) {
        const raw = log?.raw_log ?? log;
        const topics = raw?.topics;
        if (!Array.isArray(topics) || topics.length < 3 || lc(topics[0]) !== TRANSFER_TOPIC) continue;
        let amount = 0n;
        try { amount = BigInt(raw.data ?? "0x0"); } catch { amount = 0n; }
        if (amount <= 0n) continue; // a 0-value or NFT (indexed tokenId, empty data) transfer is not a fungible drain
        bump(token, topicAddr(topics[1]), -amount);
        bump(token, topicAddr(topics[2]), amount);
      }
    });
  }
  const drains = [];
  for (const [token, holders] of net.entries()) {
    const bases = balanceBases(token, targets, balances);
    for (const [holder, delta] of holders.entries()) {
      if (delta >= 0n || holder === token || !targets.has(holder)) continue;
      const stored = storedBalanceLoss(writes, token, holder, bases);
      if (stored <= 0n) continue;
      const logged = -delta;
      drains.push({ token, victim: holder, lostUnits: (stored < logged ? stored : logged).toString() });
    }
  }
  drains.sort((a, b) => (BigInt(a.lostUnits) > BigInt(b.lostUnits) ? -1 : 1));
  return drains;
}

// The storage token-drain channel — ground truth, event-independent. The event
// channel above will not take a Transfer log as proof unless the balance slot
// moved; a hostile or sloppy in-scope token need not emit one at all, and a harm
// gate must not depend on an advisory event.
// Here we read the drain from the balance mappings themselves. For each scope
// target token K with a balance mapping at base slot p (from scopeBalances), and
// each scope-target holder H, the live balance sits at keccak256(pad32(H).pad32(p)).
// We net every execution SSTORE to that slot — controlTrace.writes is already body
// only and success-gated, the same rules the ETH and event channels use, so setUp
// funding is fixture and a reverted write does not count. A scope target that nets
// a LOSS of a token it does not itself issue was drained. `balances` is
// scopeBalances(ws); an empty map (no layout, e.g. synthetic unit traces) yields
// no drains and the gate falls through to the event channel. Returns
// [{ token, victim, lostUnits }], biggest loss first.
function balanceDrains(controlTrace, targets, balances) {
  if (!balances || !balances.size) return [];
  const writes = controlTrace?.writes ?? [];
  const index = new Map(); // `${token}:${slotWord}` -> holder address
  for (const [addr, name] of targets.entries()) {
    const bases = balances.get(name);
    if (!bases) continue; // this target issues no scope-tracked balance
    for (const base of bases) {
      for (const holder of targets.keys()) {
        const slot = mappingSlot(holder, base);
        index.set(`${addr}:${slot}`, holder);
      }
    }
  }
  if (!index.size) return [];
  const net = new Map(); // token -> Map(holder -> signed units)
  for (const w of writes) {
    const token = lc(w.context);
    const holder = index.get(`${token}:${word(w.slot)}`);
    if (!holder) continue;
    let before = 0n, after = 0n;
    try { before = BigInt(w.before); after = BigInt(w.after); } catch { continue; }
    const delta = after - before;
    if (delta === 0n) continue;
    const m = net.get(token) ?? new Map();
    m.set(holder, (m.get(holder) ?? 0n) + delta);
    net.set(token, m);
  }
  const drains = [];
  for (const [token, holders] of net.entries()) {
    for (const [holder, delta] of holders.entries()) {
      if (delta >= 0n || holder === token) continue; // only a scope target that LOST a token it does not issue
      drains.push({ token, victim: holder, lostUnits: (-delta).toString() });
    }
  }
  drains.sort((a, b) => (BigInt(a.lostUnits) > BigInt(b.lostUnits) ? -1 : 1));
  return drains;
}

// KNOWN LIMITS of this control channel (documented, not silently overclaimed).
// These are cases a code review raised that the gate does NOT yet judge perfectly;
// each fails toward UNDER-claiming (a missed finding), not a false "proven":
//   - An Ownable2Step `acceptOwnership` can read as a takeover: OZ clears the
//     pending-owner slot BEFORE it writes the owner, so the new owner is not in the
//     pre-write authority snapshot. (A benign 2-step hand-over flagged — narrow,
//     needs that exact OZ flow run as a PoC.)
//   - A legit UUPS/Transparent upgrade whose admin/owner check reads from the
//     implementation's own or OZ-v5 namespaced storage (never SLOADing a slot in
//     the proxy's own layout) leaves the authority set empty, so an in-scope
//     proxy's upgrade can read as a hijack.
//   - An owner that lives in the IMPLEMENTATION's layout but in PROXY storage is not
//     a named control slot of the proxy, so a takeover through the proxy is missed.
//   - Control roles under non-standard names (controller/manager/minter/keeper) and
//     balances under non-standard names (_rOwned, struct-wrapped amounts) are not in
//     CONTROL_NAMES / BALANCE_NAMES; those token drains fall back to Transfer logs
//     authenticated by a balance-slot decrease. An event-less token, or a log whose
//     emitter is not the token, defeats that fallback on purpose.
//
// The layout-aware control channel. A storage write is a TAKEOVER only when it
// re-points a control pointer the writer was not entitled to set. Which slots are
// control pointers comes from the compiled storage layout (`layouts`, a Map
// name -> Set of address-control slot words), NOT from a slot-position guess:
//   - the named owner/admin/governor address variables of THIS contract, plus
//   - the EIP-1967 admin and implementation slots (control pointers by definition).
// Entitlement is read from the REAL slot values the contract held just before the
// write (writeMeta[i].held, filled across setUp/constructor too): the current
// owner and admin are the authority. A write whose caller already holds authority
// is a legitimate hand-over; a write by anyone else to a control slot, re-pointing
// it to a different address, is a takeover. The implementation slot is a control
// target but not itself a source of authority. `targets` maps address -> name.
function layoutTakeovers(controlTrace, targets, layouts) {
  const writes = controlTrace?.writes ?? [];
  const meta = controlTrace?.writeMeta ?? [];
  return writes.filter((w, i) => {
    const ctx = lc(w.context);
    if (!targets.has(ctx)) return false;
    const named = layouts?.get(targets.get(ctx)) ?? new Set();
    const controlSlots = new Set([...named, ADMIN_SLOT, IMPLEMENTATION_SLOT]);
    const slot = word(w.slot);
    if (!controlSlots.has(slot)) return false;
    const after = word(w.after), before = word(w.before);
    if (!isAddressWord(after) || after === before) return false; // must re-point to a DIFFERENT address
    const held = meta[i]?.held ?? {};
    const authoritySlots = [...named, ADMIN_SLOT]; // IMPL is controlled, not a controller
    const authority = new Set(authoritySlots.map((s) => held[s]).filter(Boolean).map(lc));
    const caller = lc(meta[i]?.caller ?? "");
    if (caller && authority.has(caller)) return false; // the writer already held control: a legitimate change
    return true;
  });
}

// The generic harm verdict for one forge replay. Pure: traces + scope code in,
// { ok, kind, targets, ... } out. `controlTrace` is extractControlTrace(traces);
// `layouts` is scopeLayouts(ws). When `layouts` is null (unit traces with no
// compiled artifacts) the gate falls back to the slot-0/EIP-1967 heuristic in
// control-trace.mjs; a real replay always passes the layout, so production harm
// is judged from the layout, never a position guess.
// The ETH channel, net per counterparty (H1f). `net` is the old measure: each
// target's net ETH in the test body. That alone counts a setUp() deposit and the
// same address's own withdraw in the body as a drain. So a loss counts only as the
// excess of what a counterparty took out of the target over what that same
// counterparty put in, across setUp() AND the body (value CALLs, and the value of
// a CREATE). The reported loss is the smaller of the two measures, so it can only
// shrink: a verdict the old measure did not prove stays not proven.
// Counterparties:
// - The test contract and every non-scope contract it deployed are ONE party, "the
//   test": they all run the test's code.
// - Every other address (a pranked EOA, a makeAddr user) is its own party. The gate
//   cannot tell an attacker address from an honest user: both are pranked
//   addresses. So a deposit by one address and a withdraw by another counts.
// - ETH that the test put on a target without a value CALL (vm.deal, vm.coinbase)
//   is the test's own. The test side's take from that target is not counted. A
//   selfdestruct by a test contract does the same for every target, because the
//   trace does not name its beneficiary.
// Returns [{ victim, lostWei, gross }] for every target the old measure saw lose ETH.
const TEST_PARTY = "the test";
// The party an address belongs to: the test contract and every non-scope contract
// it deployed are one party; every other address is its own.
function partyOf(traces, targets) {
  const { testContract, created } = replayParties(traces);
  return { testContract, side: (a) => (a && (a === testContract || (created.has(a) && !targets.has(a))) ? TEST_PARTY : a) };
}

function ethLosses(traces, targets, net, controlTrace) {
  const TEST = TEST_PARTY;
  const { side } = partyOf(traces, targets);
  const flows = new Map(); // target -> Map(party -> put in minus took out)
  const bump = (target, party, wei) => {
    const m = flows.get(target) ?? new Map();
    m.set(party, (m.get(party) ?? 0n) + wei);
    flows.set(target, m);
  };
  // vm.deal(target, x) credits x to the test party as "put in" for that target (the
  // test gave the target this ETH, so the test taking it back is not a drain). Sum
  // the dealt balances per target. A deal with an unknown amount (none today) or
  // vm.coinbase (no amount) marks the target `forcedUnknown`: the test party's whole
  // take is dropped, as before. A selfdestruct of a test contract names no target or
  // amount, so it drops the test take from EVERY target (strict).
  const dealt = new Map(); // target -> summed dealt balance credited to the test party
  const forcedUnknown = new Set();
  for (const e of controlTrace?.ethFunded ?? []) {
    const target = lc(e?.target ?? e);
    if (e && typeof e === "object" && e.amount != null) {
      try { dealt.set(target, (dealt.get(target) ?? 0n) + BigInt(e.amount)); } catch { forcedUnknown.add(target); }
    } else forcedUnknown.add(target);
  }
  let selfDestructed = false;
  for (const entry of Array.isArray(traces) ? traces : []) {
    const arena = (Array.isArray(entry) ? entry[1] : entry)?.arena;
    if (!Array.isArray(arena)) continue;
    const ok = (i) => { for (let n = arena[i]; n; n = arena[n.parent]) if (!n.trace?.success) return false; return true; };
    arena.forEach((node, i) => {
      const t = node?.trace ?? {};
      if (!ok(i)) return;
      const to = lc(t.address), from = lc(t.caller);
      if (t.status === "SelfDestruct" && side(to) === TEST) selfDestructed = true;
      let wei = 0n;
      try { wei = BigInt(t.value ?? "0x0"); } catch { wei = 0n; }
      if (wei <= 0n) return;
      if (t.kind === "CALL" || t.kind === "CREATE" || t.kind === "CREATE2") {
        if (targets.has(to)) bump(to, side(from), wei);
        if (t.kind === "CALL" && targets.has(from)) bump(from, side(to), -wei);
      }
    });
  }
  const out = [];
  for (const [victim, w] of net.entries()) {
    if (!targets.has(victim) || w >= 0n) continue;
    const gross = -w;
    let excess = 0n;
    for (const [party, v] of flows.get(victim) ?? []) {
      // The test party credits the ETH it dealt to the victim as "put in". When the
      // amount is unknown (coinbase, or a selfdestruct into a test contract), the
      // whole test take is dropped (strict, fail closed).
      const put = party === TEST ? v + (dealt.get(victim) ?? 0n) : v;
      if (put >= 0n) continue;
      if (party === TEST && (selfDestructed || forcedUnknown.has(victim))) continue;
      excess += -put;
    }
    out.push({ victim, lostWei: excess < gross ? excess : gross, gross });
  }
  return out.sort((a, b) => (a.lostWei > b.lostWei ? -1 : a.lostWei < b.lostWei ? 1 : 0));
}

// The token channels, net per counterparty (H1f B). A drain is a real drop of a
// holder's balance slot; the storage channel does not know where the tokens went.
// The recipient comes from the token's authenticated Transfer logs (the emitter is
// the scope token itself, as in tokenDrains), read from setUp() AND the body:
// - `bodyOut`: the units the body's logs moved out of the holder. The part of the
//   drop they do not cover has no recipient: it stays counted, as before (the drop
//   is real; a token that logs nothing keeps the old measure).
// - The covered part counts only as the per-party excess: what a party took out of
//   the holder over what it put in, across both traces. The test is one party (see
//   partyOf), and tokens an exempt funding store put on the holder are the test's own.
// The result is never more than the drop, so a loss can only shrink.
function netTokenDrains(drains, traces, targets, funded) {
  if (!drains.length) return drains;
  const { testContract, side } = partyOf(traces, targets);
  const rec = new Map(); // "token:holder" -> { parties: Map(party -> put in minus took out), bodyOut }
  const get = (k) => { let r = rec.get(k); if (!r) { r = { parties: new Map(), bodyOut: 0n }; rec.set(k, r); } return r; };
  for (const entry of Array.isArray(traces) ? traces : []) {
    const label = Array.isArray(entry) ? entry[0] : null;
    const arena = (Array.isArray(entry) ? entry[1] : entry)?.arena;
    if (!Array.isArray(arena)) continue;
    const ok = (i) => { for (let n = arena[i]; n; n = arena[n.parent]) if (!n.trace?.success) return false; return true; };
    arena.forEach((node, i) => {
      if (!ok(i)) return;
      const t = node?.trace ?? {};
      const token = (t.kind === "DELEGATECALL" || t.kind === "CALLCODE") ? lc(t.caller) : lc(t.address);
      if (!token || token === testContract || !targets.has(token)) return;
      for (const log of node?.logs ?? []) {
        const raw = log?.raw_log ?? log;
        const topics = raw?.topics;
        if (!Array.isArray(topics) || topics.length < 3 || lc(topics[0]) !== TRANSFER_TOPIC) continue;
        let amount = 0n;
        try { amount = BigInt(raw.data ?? "0x0"); } catch { amount = 0n; }
        if (amount <= 0n) continue;
        const from = topicAddr(topics[1]), to = topicAddr(topics[2]);
        if (to && targets.has(to)) { const r = get(`${token}:${to}`); r.parties.set(side(from), (r.parties.get(side(from)) ?? 0n) + amount); }
        if (from && targets.has(from)) {
          const r = get(`${token}:${from}`);
          r.parties.set(side(to), (r.parties.get(side(to)) ?? 0n) - amount);
          if (label === "Execution") r.bodyOut += amount;
        }
      }
    });
  }
  const out = drains.map((d) => {
    const key = `${d.token}:${d.victim}`;
    const r = rec.get(key);
    const drop = BigInt(d.lostUnits);
    if (!r) return d;
    const unmatched = drop > r.bodyOut ? drop - r.bodyOut : 0n;
    let excess = 0n;
    for (const [party, v] of r.parties) {
      if (v >= 0n || (party === TEST_PARTY && funded.has(key))) continue;
      excess += -v;
    }
    let lost = unmatched + (excess < r.bodyOut ? excess : r.bodyOut);
    if (lost > drop) lost = drop;
    return { ...d, lostUnits: lost.toString() };
  });
  return out.sort((a, b) => (BigInt(a.lostUnits) > BigInt(b.lostUnits) ? -1 : BigInt(a.lostUnits) < BigInt(b.lostUnits) ? 1 : 0));
}

// The backstop reason, or null. Each hit names the cheatcode and how to repair.
const BACKSTOP_FIX = {
  state: "do not restore an earlier state inside the proof test",
  exec: "remove gas metering cheatcodes from the proof test",
  fork: "do not roll, re-select or replay a transaction inside the test body (a fork may be created once in setUp)",
  account: "the gate has no rule for this cheatcode: keep it out of the proof test",
  mock: "the gate has no rule for this cheatcode: keep it out of the proof test",
  unknown: "use only the cheatcodes of the pinned forge-std Vm.sol",
};
function backstopNote(controlTrace) {
  if (controlTrace?.cheatTable === "missing") return "the gate's cheatcode table (spike/lib/vm-cheatcodes.json) is missing or does not parse, so it cannot check the cheatcodes the test used; nothing is proven.";
  // outcome is trusted, with one guard: the call an expectation was armed for must
  // be a reverted frame. If the trace shows it successful, or no call followed, the
  // trace and the test disagree: refuse.
  const broken = (controlTrace?.expects ?? []).filter((e) => !e.armed || e.armed.success);
  if (broken.length && broken.every((e) => e.creation)) {
    const what = [...new Set(broken.map((e) => `vm.${e.name} (in ${e.where})`))].join(", ");
    return `the test used ${what} on the creation of a contract (new X(…)). Forge makes that creation a cheatcode call (deployCode), so the expectation does not apply to a call the trace can show as reverted, and no scope target counts. To repair: create the contract in an external helper call (for example this.make(…)) under the expectation, or use try/catch.`;
  }
  if (broken.length) {
    const what = [...new Set(broken.map((e) => `vm.${e.name} (in ${e.where})`))].join(", ");
    return `the test used ${what}, but the trace shows no reverted call for it to expect (the call it was armed for succeeded, or no call followed), so the trace and the test disagree and no scope target counts. To repair: make the expected call really revert, or remove the expectation from the proof test.`;
  }
  // A `fork` hit is NOT fatal on a forked run, and the two cases differ sharply:
  //   - setUp may create and select the fork. That is the point of a forked run,
  //     and it grants no state to the body: the fork is read from the chain.
  //   - the BODY must not roll, re-select or replay. A rollFork/rollFork-tx inside
  //     the attack is how a test rewinds time to make a loss look bigger, so it
  //     stays refused.
  // So a fork hit only counts when it happened in the test BODY. Each entry says
  // `where: "body" | "setUp"` (control-trace.mjs), which is exactly the split.
  const hits = (controlTrace?.backstop ?? []).filter((h) => !(h.class === "fork" && h.where === "setUp"));
  if (!hits.length) return null;
  const seen = new Map();
  for (const h of hits) {
    const label = h.name ? `vm.${h.name} (${h.class}, in ${h.where})` : `the unknown cheatcode ${h.selector} (in ${h.where})`;
    if (!seen.has(label)) seen.set(label, h.name ? (BACKSTOP_FIX[h.class] ?? BACKSTOP_FIX.account) : BACKSTOP_FIX.unknown);
  }
  const list = [...seen.keys()].join(", ");
  const fixes = [...new Set(seen.values())].join("; ");
  return `the test used ${list}; after it the replay trace no longer tells what really happened, so no scope target counts. To repair: ${fixes}.`;
}

// The scope targets the test tampered with: address -> "0x… (Name) via vm.how[, vm.how]".
// One store is exempt: a write of a scope token's balance slot, at a base the
// compiled layout names, for a holder that is itself a scope target. That is how
// forge-std deal(token, holder, amount) funds the victim in a fixture; it only
// sets what the victim holds, and the gate measures the loss from that value.
// A balance written for any other holder (the attacker, the test) is refused:
// in a share token it would be a forged claim on the victim's assets.
function tamperedTargets(controlTrace, targets, balances, funded = new Set()) {
  const out = new Map();
  const scope = [...targets.keys()];
  // `funded` gets "token:holder" for every exempt store: tokens the test put on
  // that holder (see netTokenDrains).
  const funding = (t) => {
    if (t.how !== "store" || !t.slot) return false;
    const bases = balances?.get(targets.get(lc(t.target)) ?? "") ?? [];
    const holder = scope.find((h) => bases.some((base) => mappingSlot(h, base) === word(t.slot)));
    if (holder) funded.add(`${lc(t.target)}:${holder}`);
    return Boolean(holder);
  };
  for (const t of controlTrace?.tampers ?? []) {
    const hit = t.target === "*" ? scope : [lc(t.target)].filter((a) => targets.has(a));
    for (const a of hit) {
      if (funding(t)) continue;
      const prev = out.get(a);
      if (!prev) out.set(a, `${a} (${targets.get(a)}) via vm.${t.how}`);
      else if (!prev.includes(`vm.${t.how}`)) out.set(a, `${prev}, vm.${t.how}`);
    }
  }
  return out;
}

export function judgeHarm(traces, { scope = [], controlTrace = null, layouts = null, balances = null } = {}) {
  const { targets, invoked, net } = scanTargets(traces, scope);
  for (const e of controlTrace?.etches ?? []) targets.delete(lc(e.target));
  // A target the test impersonated is no target at all: not a victim, not a token,
  // not a takeover context. A prank (or broadcast) AS a target lets the test move
  // that target's funds as the target itself, and with the delegateCall bool, run
  // its own code in that target's storage — the token's balances or an owner slot.
  // A legitimate PoC pranks the attacker or an outside address, never a scope
  // contract. A prank in setUp() counts too: the gate cannot tell a fixture prank
  // from one that approves the attacker, so it fails closed.
  const impersonated = [];
  for (const p of controlTrace?.pranks ?? []) {
    const a = lc(p);
    if (targets.has(a)) { impersonated.push(`${a} (${targets.get(a)})`); targets.delete(a); }
  }
  // A target whose storage the test wrote with a cheatcode (vm.store, copyStorage,
  // setArbitraryStorage, loadAllocs), or whose call answers it faked (vm.mockCall,
  // mockCalls, mockCallRevert), cannot be the source of proven harm: the loss may be
  // what the cheatcode granted (an allowance, an owner slot, a credit). Kept or not,
  // in setUp() or the body: fail closed, like an etch.
  const funded = new Set();
  const tampered = tamperedTargets(controlTrace, targets, balances, funded);
  for (const a of tampered.keys()) targets.delete(a);
  // The backstop (H1e 1): a cheatcode the table does not know, or one after which
  // the trace no longer tells what happened, makes EVERY scope target unusable.
  const unusable = backstopNote(controlTrace);
  if (unusable) targets.clear();
  const names = [...targets.entries()].map(([address, name]) => ({ address, name }));
  // Not proven. When the test impersonated or tampered with a target, say so first,
  // so the agent can repair its PoC; then keep the base reason, which may be the
  // true cause.
  const notes = [];
  if (unusable) notes.push(unusable);
  if (impersonated.length) notes.push(`the test impersonated scope target ${impersonated.join(", ")} with a prank or broadcast cheatcode; a target the test acts as cannot be the victim (nor the token or the contract taken over), so it is not counted. Prank the attacker or an outside address, never a scope contract, also not in setUp().`);
  if (tampered.size) notes.push(`the test set the state of scope target ${[...tampered.values()].join(", ")}; a target whose storage or call answers the test wrote cannot be the source of proven harm, so it is not counted. Build the fixture through the target's own functions (fund a holder through a pranked user's deposit), or use vm.store / vm.mockCall only on contracts outside the scope. Drain with a pranked attacker address or an attacker contract — what counts is that the victim's funds came from another party. A deal() that funds a scope contract's token balance is counted as the test's own, so do not drain that balance from the test side.`);
  const refuse = (reason) => ({
    ok: false,
    reason: notes.length ? `${notes.join(" ")} Without that target: ${reason}` : reason,
    targets: names,
  });
  if (!targets.size) return refuse("the replay deployed no contract from the audited scope (src/ or vendor/), so it proves nothing about the target");
  if (!invoked) return refuse("the test never made a successful call into a scope target");
  const eth = ethLosses(traces, targets, net, controlTrace);
  const takeovers = layouts == null ? controlTakeovers(controlTrace, targets) : layoutTakeovers(controlTrace, targets, layouts);
  if (eth.length && eth[0].lostWei > 0n) {
    return { ok: true, kind: "funds", victim: eth[0].victim, lostWei: eth[0].lostWei.toString(), targets: names };
  }
  // ETH left a target, but only back to addresses that had put it in.
  const returned = eth.map((e) => `${e.victim} (${targets.get(e.victim)})`);
  // Prefer the ground-truth storage read. Fall back to Transfer logs only for a
  // token the layout does not cover (a real external ERC-20, or a balance under
  // a name we don't track). The fallback still requires the balance slot to have
  // moved in that token — a log on its own is not a drain.
  // Then net each drop per counterparty (H1f B), after the channel is chosen, so
  // the choice is the same as before and a loss can only shrink.
  const storageDrains = balanceDrains(controlTrace, targets, balances);
  const netted = netTokenDrains(storageDrains.length ? storageDrains : tokenDrains(traces, targets, controlTrace, balances), traces, targets, funded);
  const drains = netted.filter((d) => BigInt(d.lostUnits) > 0n);
  if (drains.length) {
    const d = drains[0];
    return { ok: true, kind: "funds", asset: "token", victim: d.victim, token: d.token, lostUnits: d.lostUnits, targets: names };
  }
  for (const d of netted) returned.push(`${d.victim} (${targets.get(d.victim)}, token ${d.token})`);
  if (takeovers.length) return { ok: true, kind: "control", victim: lc(takeovers[0].context), writes: takeovers.length, targets: names };
  if (returned.length) return refuse(`ETH or tokens left scope target ${returned.join(", ")} in the test body, but no address took out more than it had put in, across setUp() and the body (the test contract and the contracts it deployed count as one party, and what the test put on a target with vm.deal, vm.coinbase, a selfdestruct or a funding deal() counts as the test's own). Taking back a deposit is not a drain: fund the victim through a pranked user's deposit, then drain it with a pranked attacker address or an attacker contract — what counts is that the victim's funds came from another party, not from vm.deal, deal() or a constructor value, whose funds count as the test's own. It took over none of its control slots either`);
  return refuse("the test called a scope target but moved no ETH out of it and took over none of its control slots (owner, EIP-1967 admin or implementation)");
}
