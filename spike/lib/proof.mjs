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
import { extractControlTrace, controlTakeovers, word, asAddress, isAddressWord, ADMIN_SLOT, IMPLEMENTATION_SLOT } from "./control-trace.mjs";

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
  const harm = judgeHarm(r.traces, { scope: scopeCode(ws), controlTrace, layouts: scopeLayouts(ws) });
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
//   2. an effect on a scope target the gate accepts as harm, by ANY channel:
//      - funds (ETH):   a target's net native ETH went DOWN during the test body;
//      - funds (token): a target was a net LOSER of an ERC-20 token in the body,
//        read from the real `Transfer` logs the EVM emitted (see tokenDrains); or
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
      for (const s of layout.storage) {
        if (Number(s.offset) !== 0) continue; // only a clean, unpacked address word
        const varName = String(s.label ?? "").replace(/^_+/, "").toLowerCase();
        if (!CONTROL_NAMES.test(varName)) continue;
        const t = layout.types?.[s.type];
        if (!t || t.encoding !== "inplace") continue; // not a mapping / dynamic / struct member
        const tl = String(t.label ?? "");
        if (tl !== "address" && !tl.startsWith("contract ")) continue; // must be address-typed
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

// The token-drain channel. The native-ETH funds channel sees `t.value` only, so a
// drain of ERC-20 balances — the most common DeFi harm — is invisible to it. Here
// we read the real `Transfer` logs the EVM emitted in the test body and net them
// per (token, holder). A scope target that is a net LOSER of a token it does not
// itself issue was drained. Body only, success-gated — the same rules the ETH
// channel uses, so setUp funding is fixture and a rolled-back transfer does not
// count. Returns [{ token, victim, lostUnits }], biggest loss first.
function tokenDrains(traces, targets) {
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
      const token = lc(node?.trace?.address);
      if (!token) return;
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
    for (const [holder, delta] of holders.entries()) {
      if (delta >= 0n || holder === token || !targets.has(holder)) continue;
      drains.push({ token, victim: holder, lostUnits: (-delta).toString() });
    }
  }
  drains.sort((a, b) => (BigInt(a.lostUnits) > BigInt(b.lostUnits) ? -1 : 1));
  return drains;
}

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
export function judgeHarm(traces, { scope = [], controlTrace = null, layouts = null } = {}) {
  const { targets, invoked, net } = scanTargets(traces, scope);
  for (const e of controlTrace?.etches ?? []) targets.delete(lc(e.target));
  const names = [...targets.entries()].map(([address, name]) => ({ address, name }));
  if (!targets.size) return { ok: false, reason: "the replay deployed no contract from the audited scope (src/ or vendor/), so it proves nothing about the target", targets: names };
  if (!invoked) return { ok: false, reason: "the test never made a successful call into a scope target", targets: names };
  const losses = [...net.entries()].filter(([a, w]) => targets.has(a) && w < 0n).sort((a, b) => (a[1] < b[1] ? -1 : 1));
  const takeovers = layouts == null ? controlTakeovers(controlTrace, targets) : layoutTakeovers(controlTrace, targets, layouts);
  if (losses.length) {
    const [victim, wei] = losses[0];
    return { ok: true, kind: "funds", victim, lostWei: (-wei).toString(), targets: names };
  }
  const drains = tokenDrains(traces, targets);
  if (drains.length) {
    const d = drains[0];
    return { ok: true, kind: "funds", asset: "token", victim: d.victim, token: d.token, lostUnits: d.lostUnits, targets: names };
  }
  if (takeovers.length) return { ok: true, kind: "control", victim: lc(takeovers[0].context), writes: takeovers.length, targets: names };
  return { ok: false, reason: "the test called a scope target but moved no ETH out of it and took over none of its control slots (owner, EIP-1967 admin or implementation)", targets: names };
}
