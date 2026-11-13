// Read control-relevant facts out of a forge replay trace (`forge test --json -vvvvv`).
//
// At verbosity 5 every EVM step carries a `storage_change`. That is the state diff of
// the replay: the engine reads it, not the test source. This file only extracts. It
// does not decide what counts as harm. Packs read the result (see packs/keys/control.mjs).
//
// What we keep:
// - etches: calls to the cheatcode `etch(address,bytes)`, plus `cloneAccount(source,target)`
//   recorded as an etch of its target and `mockFunction(callee,target,data)` recorded as an
//   etch of its callee, read from EVERY trace, `Setup` included, and for
//   any call kind (a cheatcode declared `view` is reached by STATICCALL). A setUp() etch
//   swaps a target's code before the test body runs, so the harm gate must still exclude
//   the address; the record is not itself harm. Every entry is recorded, also in a frame
//   that reverted, with `kept`: true when the call and every ancestor frame succeeded. The
//   harm gate drops the target for every entry (fail closed); packs/keys/control.mjs reads
//   only kept entries, because it proves a change from the code that landed. `index` is the
//   out.calls offset the etch applies to.
// - writes (from the "Execution" trace only): a real SSTORE (value changed) in a call
//   that did not revert and outside any contract constructor. A write made under a Safe
//   `setup` call carries `setup: true`. A setUp write is fixture, not an exploit step.
//   The storage owner is the address that ran the code: the caller for DELEGATECALL,
//   the callee for CALL.
// - pranks: the impersonated msg.sender (first address argument), and for the origin
//   overloads also the pranked tx.origin (second), of every cheatcode in
//   the trace that sets msg.sender or tx.origin — the whole vm.prank / vm.startPrank
//   family (including the two-arg origin and the delegateCall `bool` overloads) and
//   vm.broadcast / vm.startBroadcast with an explicit address. Recorded for any call kind
//   and even in a frame that reverted: forge keeps prank state in its inspector, so a
//   revert does not undo it. A target the test impersonated is no target at all (not a
//   victim, token or takeover context): the move is the test acting as that target, not
//   an exploit (see lib/proof.mjs).
// - expects: each expectRevert / expectPartialRevert with the call it was armed for:
//   { selector, name, where, armed: { index, success } | null }.
// - backstop: VM calls whose selector is not in lib/vm-cheatcodes.json, or whose class
//   makes the trace untrustworthy: { selector, name, class, where, kept }. `cheatTable` is
//   "missing" when that file could not be read.
// - ethFunded: the accounts that vm.deal or vm.coinbase acted on, in any trace and frame,
//   as { target, amount }: amount is the dealt balance for vm.deal, null for vm.coinbase.
// - tampers: cheatcodes that write a contract's storage or fake its call answers, with the
//   address they act on: { target, how, slot?, kept }. `store` also keeps its slot. Read from
//   EVERY trace, for any call kind, kept or not (fail closed: an entry can only drop a target).
//   `loadAllocs` can write any account, so its target is "*". The harm gate refuses a scope
//   target in this list as the source of proven harm (see lib/proof.mjs). vm.store and
//   vm.mockCall leave no SSTORE step, so the call itself is the only trace of them.
// - calls (from the "Execution" trace only): successful CALL nodes, in order, to see
//   what ran after an etch.
// What we keep from every trace: the set of created contracts and the selectors each
// address received. The address-shaped words in its storage come from Execution only.
// - writeMeta[i] = { caller, authority, held } for writes[i] (kept apart so `writes` keeps its shape): who the contract saw as msg.sender; the owner
//   (slot 0) and EIP-1967 admin the contract held just before the write (`authority`, slot-0/admin only, entitlement-filtered for packs/keys/control.mjs); and
//   `held`, a layout-free snapshot { [slot]: address } of EVERY address-valued slot the contract held just before the write. They come from the
//   SSTOREs of every trace, constructors included. A write whose caller already held
//   authority is a legitimate change, not a takeover. control.mjs reads `authority`; the forge
//   harm gate (lib/proof.mjs) reads `held` with the compiled storage layout. control.mjs decides.
import { readFileSync } from "node:fs";
import { keccak256, toUtf8Bytes } from "ethers";
const VM = "0x7109709ecfa91a80626ff3989d68f67f5b1dd12d";
const ETCH = "0xb4d6c782";
// vm.cloneAccount(address source, address target) copies source's code (and
// storage, balance, nonce) onto target. For the harm gate that is an etch of
// the SECOND argument: target is no longer the scope's compiled code, so it
// must stop being a scope target, exactly as a plain etch does.
const CLONE_ACCOUNT = "0x533d61c9";
// vm.mockFunction(address callee, address target, bytes data) makes a call to
// callee with matching data run target's code in callee's storage. For the harm
// gate that is an etch of the FIRST argument: callee no longer runs only the
// scope's compiled code, so it must stop being a scope target.
const MOCK_FUNCTION = "0xadf84d21";
// Cheatcodes that set msg.sender (and sometimes tx.origin) for the following
// call(s). If a test impersonates a scope target and then moves that target's
// funds, the "drain" is the test acting as the victim, not an exploit — the harm
// gate drops such a victim. We derive the 4-byte selectors from the known list of
// impersonation signatures below rather than hard-coding hex: a new overload is
// one line, and no enumerated-by-hand selector can be silently missed. The whole
// prank/startPrank family is covered — the two-arg (sender, origin) and the
// delegateCall `bool` overloads included — plus vm.broadcast / vm.startBroadcast
// with an explicit address. The impersonated sender is the FIRST address argument
// in every one of these, so a single extraction (data.slice(24, 64)) reads them all.
const selector4 = (sig) => keccak256(toUtf8Bytes(sig)).slice(0, 10);
const IMPERSONATION_SIGS = [
  "prank(address)",
  "prank(address,address)",
  "prank(address,bool)",
  "prank(address,address,bool)",
  "startPrank(address)",
  "startPrank(address,address)",
  "startPrank(address,bool)",
  "startPrank(address,address,bool)",
  "broadcast(address)",
  "startBroadcast(address)",
];
const IMPERSONATE = new Set(IMPERSONATION_SIGS.map(selector4));
// The overloads whose SECOND address argument is the pranked tx.origin. A scope
// contract can never be a real tx.origin, so an origin prank AS a target is the
// test acting as that target too: record it as well (fail closed).
const WITH_ORIGIN = new Set(IMPERSONATION_SIGS.filter((s) => s.includes("(address,address")).map(selector4));
// Cheatcodes that write storage or fake call answers: [signature, how, index of the address
// argument (in 32-byte words), or -1 for "any account"]. From the pinned forge-std Vm.sol,
// plus the bytes4 and bool overloads newer forge accepts. A test may declare its own
// interface, so the selector is what counts.
const TAMPER_SIGS = [
  ["store(address,bytes32,bytes32)", "store", 0],
  ["copyStorage(address,address)", "copyStorage", 1], // writes `to`, the second address
  ["setArbitraryStorage(address)", "setArbitraryStorage", 0],
  ["setArbitraryStorage(address,bool)", "setArbitraryStorage", 0],
  ["loadAllocs(string)", "loadAllocs", -1],
  // The nonce of an account decides the addresses it creates: set by cheatcode on a
  // scope target, it is state the test wrote.
  ["setNonce(address,uint64)", "setNonce", 0],
  ["setNonceUnsafe(address,uint64)", "setNonceUnsafe", 0],
  ["resetNonce(address)", "resetNonce", 0],
  ...["mockCall", "mockCallRevert"].flatMap((name) => [
    `${name}(address,bytes,bytes)`, `${name}(address,uint256,bytes,bytes)`,
    `${name}(address,bytes4,bytes)`, `${name}(address,uint256,bytes4,bytes)`,
  ].map((sig) => [sig, name, 0])),
  ["mockCalls(address,bytes,bytes[])", "mockCalls", 0],
  ["mockCalls(address,uint256,bytes,bytes[])", "mockCalls", 0],
];
const TAMPER = new Map(TAMPER_SIGS.map(([sig, how, arg]) => [selector4(sig), { how, arg }]));
// Cheatcodes that put ETH on an account without a value CALL: vm.deal sets the
// balance, vm.coinbase makes the account receive the block's fees. The harm gate
// counts such ETH as the test's own (see ethLosses in lib/proof.mjs).
const ETH_FUND = new Set(["deal(address,uint256)", "coinbase(address)"].map(selector4));
const DEAL = selector4("deal(address,uint256)"); // the one with a known amount (second word)
// The selectors an existing rule records (for the backstop and its test).
export const HANDLED = new Map([
  [ETCH, "etch"], [CLONE_ACCOUNT, "cloneAccount"], [MOCK_FUNCTION, "mockFunction"],
  ...[...IMPERSONATE].map((s) => [s, "prank"]),
  ...[...ETH_FUND].map((s) => [s, "ethFunded"]),
  ...[...TAMPER.keys()].map((s) => [s, "tamper"]),
]);

// The backstop (H1e 1). Every cheatcode of the pinned forge-std Vm.sol is in
// lib/vm-cheatcodes.json with a class (classified and pinned by its own test; this
// file does not classify). A VM call is a backstop hit when its selector is not in
// the table, or when the allow-list below does not allow it. That covers:
// - state (revertTo*): the test restored an earlier state;
// - exec (gas metering): the test changed how the run is metered;
// - fork: the calls after it may run on another chain;
// - an account or mock entry no rule reads (broadcastRawTransaction: it runs a
//   signed raw transaction).
// A hit makes every scope target unusable (see judgeHarm). If the table is missing
// or does not parse, the gate proves nothing. BACKSTOP_CLASSES is kept for the
// coverage test: those classes are refused on purpose, not by omission.
export const BACKSTOP_CLASSES = new Set(["state", "exec", "fork"]);
// outcome (expectRevert, expectPartialRevert) is trusted: the harm channels read the
// TRACE, and the trace marks the expected call as reverted whatever the test sees
// (pinned on real forge by the "expectRevert … (outcome trusted)" tests). One guard
// stays: each outcome call is recorded in `expects` with the call it was armed for,
// and the gate refuses when that call is not a reverted frame (see judgeHarm).
// Cheatcodes of class account or mock that no rule records, and why that is safe.
// The coverage test (harm-gate) fails when the table gains an account or mock entry
// that is neither handled nor here; at runtime such an entry is a backstop hit.
export const TRUSTED_ACCOUNT = new Map([
  ["stopPrank()", "ends a prank"],
  ["stopBroadcast()", "ends a broadcast"],
  ["clearMockedCalls()", "removes mocks"],
  ["broadcast()", "the sender is tx.origin, never a scope contract (an origin prank that changes it is recorded by the prank rule)"],
  ["startBroadcast()", "the sender is tx.origin, never a scope contract (an origin prank that changes it is recorded by the prank rule)"],
  ["broadcast(uint256)", "the sender is the key's EOA; a scope target is a created contract with no key"],
  ["startBroadcast(uint256)", "the sender is the key's EOA; a scope target is a created contract with no key"],
  ["deployCode(string)", "a normal CREATE of a compiled artifact; judged like `new`"],
  ["deployCode(string,bytes)", "a normal CREATE of a compiled artifact; judged like `new`"],
]);
// The runtime is an ALLOW-list (H1e minor 5). A known cheatcode is allowed only when
// its class is trusted, an existing rule records it (HANDLED), or TRUSTED_ACCOUNT
// names it with a reason. Everything else is a backstop hit: a class the table gains
// later, or an account or mock entry with no rule, is refused at runtime, not only by
// a test. outcome is trusted with the armed-call guard (expects).
export const TRUSTED_CLASSES = new Set(["read", "control", "time", "fs", "outcome"]);
function allowedCheat(selector, known) {
  return TRUSTED_CLASSES.has(known.class) || HANDLED.has(selector) || TRUSTED_ACCOUNT.has(known.signature);
}
function loadCheatTable() {
  try {
    const rows = JSON.parse(readFileSync(new URL("./vm-cheatcodes.json", import.meta.url), "utf8"));
    if (!Array.isArray(rows) || !rows.length) return null;
    return new Map(rows.map((r) => [String(r.selector).toLowerCase(), { name: String(r.name), signature: String(r.signature), class: String(r.class) }]));
  } catch {
    return null;
  }
}
export const CHEAT_TABLE = loadCheatTable();
const SAFE_SETUP = "0xb63e800d";
const lc = (v) => String(v ?? "").toLowerCase();
export const word = (v) => "0x" + String(v ?? "0x0").replace(/^0x/, "").padStart(64, "0").toLowerCase();
export const isAddressWord = (w) => /^0x0{24}[0-9a-f]{40}$/.test(w) && !/^0x0{64}$/.test(w);
const OWNER_SLOT = word("0x0");
export const ADMIN_SLOT = word("0x" + (BigInt(keccak256(toUtf8Bytes("eip1967.proxy.admin"))) - 1n).toString(16));
export const IMPLEMENTATION_SLOT = word("0x" + (BigInt(keccak256(toUtf8Bytes("eip1967.proxy.implementation"))) - 1n).toString(16));
const CONTROL_SLOTS = new Set([OWNER_SLOT, ADMIN_SLOT, IMPLEMENTATION_SLOT]);
export const asAddress = (w) => (isAddressWord(w) ? "0x" + w.slice(26) : null);

export function extractControlTrace(traces, { cheatTable = CHEAT_TABLE } = {}) {
  const out = { created: [], testContract: null, selectors: {}, words: {}, writes: [], writeMeta: [], etches: [], pranks: [], tampers: [], ethFunded: [], backstop: [], expects: [], cheatTable: cheatTable ? "ok" : "missing", calls: [] };
  const created = new Set();
  const held = {}; // context -> { [slot]: word } for the owner and admin slots only
  const addrHeld = {}; // context -> { [slot]: address } — every address-valued slot, across all traces (for the layout-aware harm gate)
  for (const entry of Array.isArray(traces) ? traces : []) {
    const label = Array.isArray(entry) ? entry[0] : null;
    const arena = (Array.isArray(entry) ? entry[1] : entry)?.arena;
    if (!Array.isArray(arena)) continue;
    const ok = (i) => { for (let n = arena[i]; n; n = arena[n.parent]) if (!n.trace?.success) return false; return true; };
    const under = (i, test) => { for (let n = arena[i]; n; n = arena[n.parent]) if (test(n.trace)) return true; return false; };
    arena.forEach((node, i) => {
      const t = node.trace ?? {};
      const address = lc(t.address), caller = lc(t.caller), selector = lc(String(t.data ?? "").slice(0, 10));
      if (label === "Execution" && i === 0 && address) out.testContract = address;
      if (t.kind === "CREATE" && address) created.add(address);
      if (address && t.kind !== "CREATE") (out.selectors[address] ??= new Set()).add(selector);
      const execution = label === "Execution";
      const context = t.kind === "DELEGATECALL" || t.kind === "CALLCODE" ? caller : address;
      // msg.sender: a DELEGATECALL keeps the sender of the frame that made it.
      const senderOf = () => { let n = arena[i]; while (n?.trace?.kind === "DELEGATECALL" && arena[n.parent]) n = arena[n.parent]; return lc(n?.trace?.caller); };
      for (const step of t.steps ?? []) {
        const change = step.storage_change;
        if (!change) continue;
        const key = word(change.key);
        if (execution) for (const w of [word(change.value), word(change.had_value)]) if (isAddressWord(w)) (out.words[context] ??= new Set()).add("0x" + w.slice(26));
        // An SLOAD reveals a slot's CURRENT address value. It is the ONLY way to see an
        // owner/admin that setUp (or a constructor) set, because forge emits no per-step
        // storage changes for the Setup trace — only the Execution trace carries them. A
        // read tells us who the owner IS; it never grants the caller authority. We fold it
        // into addrHeld so the next write's snapshot knows the real pre-existing owner. A
        // genuine owner check (`require(msg.sender == owner)`) SLOADs the slot right before
        // the write, so the snapshot is populated in time; an unprotected write reads nothing
        // and is correctly left with no entitled owner.
        if (change.reason === "SLOAD" && ok(i)) { const sv = asAddress(word(change.value)); if (sv) (addrHeld[context] ??= {})[key] = sv; }
        if (change.reason !== "SSTORE" || word(change.value) === word(change.had_value)) continue;
        if (!ok(i)) continue;
        const mine = held[context] ?? {};
        const authority = [asAddress(mine[OWNER_SLOT]), asAddress(mine[ADMIN_SLOT])].filter(Boolean);
        const caller = senderOf();
        // Generic layout-free snapshot: the address value every slot of this contract held
        // just BEFORE this write, across all traces (constructor, setUp, body). The forge harm
        // gate pairs it with the compiled storage layout to read the real owner/admin of a
        // target even when it was set in setUp — see lib/proof.mjs. We snapshot here, then
        // record this write's own effect below, so the snapshot is the pre-write state.
        const heldSnap = { ...(addrHeld[context] ?? {}) };
        if (execution && !under(i, (x) => x.kind === "CREATE")) {
          const setup = under(i, (x) => lc(String(x.data ?? "").slice(0, 10)) === SAFE_SETUP);
          out.writes.push({ context, slot: key, before: word(change.had_value), after: word(change.value), ...(setup ? { setup: true } : {}) });
          out.writeMeta.push({ caller, authority, held: heldSnap });
        }
        // Track the live address value at this slot for the NEXT write's snapshot. A write to a
        // non-address value (a renounce to 0, a scalar) clears the slot: it holds no address now.
        const av = asAddress(word(change.value));
        if (av) (addrHeld[context] ??= {})[key] = av;
        else if (addrHeld[context]) delete addrHeld[context][key];
        if (key !== OWNER_SLOT && key !== ADMIN_SLOT) continue;
        // Authority is who COULD write this slot, not who the current value points at. A write
        // teaches the snapshot only when its writer is entitled to make it:
        // - a constructor of the contract itself (another contract's constructor never is);
        // - fixture: any write in a Setup trace;
        // - a writer that already held authority (a legitimate hand-over);
        // - the first write to an empty slot by the test contract (its own initialization).
        // An outsider's takeover is NOT adopted, so it cannot hide the writes that follow it.
        let building = null;
        for (let n = arena[i]; n && !building; n = arena[n.parent]) if (n.trace?.kind === "CREATE") building = lc(n.trace.address);
        const first = word(change.had_value) === word("0x0") && caller === out.testContract;
        const entitled = building !== null ? building === context : !execution || authority.includes(caller) || first;
        if (entitled) (held[context] ??= {})[key] = word(change.value);
      }
      if (address === VM) {
        // A cheatcode is recorded for ANY call kind. A test can declare a cheatcode
        // `view`; Solidity then reaches the VM by STATICCALL, and forge still runs it.
        const data = String(t.data).slice(10);
        // `kept`: the call succeeded and no ancestor frame reverted.
        const kept = t.success && ok(i);
        // The backstop: any frame, kept or not (an entry can only drop targets).
        if (cheatTable) {
          const known = cheatTable.get(selector);
          // The call an expectation is armed for: forge checks it when a call ends at
          // the depth of the cheatcode's caller or shallower. So it is the first later
          // non-VM node at most as deep as this VM call node. None found: null.
          if (known?.class === "outcome") {
            const depth = (j) => { let d = 0; for (let n = arena[j]; n && n.parent != null; n = arena[n.parent]) d++; return d; };
            const mine = depth(i);
            let armed = null;
            let nextCheat = null; // the first later VM call at that depth
            for (let j = i + 1; j < arena.length; j++) {
              if (depth(j) > mine) continue;
              if (lc(arena[j]?.trace?.address) === VM) { nextCheat ??= lc(String(arena[j]?.trace?.data ?? "").slice(0, 10)); continue; }
              armed = { index: j, success: arena[j]?.trace?.success === true };
              break;
            }
            // `new ScopeContract(…)` under expectRevert: forge makes the creation a
            // deployCode cheatcode call, so no call follows for the expectation.
            const creation = !armed && cheatTable.get(nextCheat)?.name === "deployCode";
            out.expects.push({ selector, name: known.name, where: execution ? "body" : "setUp", armed, ...(creation ? { creation: true } : {}) });
          }
          if (!known) out.backstop.push({ selector, name: null, class: "unknown", where: execution ? "body" : "setUp", kept });
          else if (!allowedCheat(selector, known)) out.backstop.push({ selector, name: known.name, class: known.class, where: execution ? "body" : "setUp", kept });
        }
        // Every etch-like cheatcode is recorded, kept or not, with a `kept` flag. The
        // harm gate drops the target for EVERY entry, so it does not depend on how
        // forge journals the change (fail closed). packs/keys/control.mjs proves a
        // 7702 delegation from `code`, so it reads only the kept entries.
        if (selector === ETCH) {
          const target = "0x" + data.slice(24, 64);
          const length = parseInt(data.slice(128, 192) || "0", 16);
          out.etches.push({ index: out.calls.length, target, code: "0x" + data.slice(192, 192 + length * 2), kept });
        } else if (selector === CLONE_ACCOUNT) {
          // cloneAccount(source, target): the SECOND word is the target whose code
          // was replaced. The cloned bytes come from source's live code, not the
          // calldata, so we record no code — the harm gate reads only `target`.
          // The empty code is never a 7702 designator for packs/keys/control.mjs.
          out.etches.push({ index: out.calls.length, target: "0x" + data.slice(88, 128), code: "0x", kept });
        } else if (selector === MOCK_FUNCTION) {
          // mockFunction(callee, target, data): the FIRST word is the callee whose
          // code is replaced. No code is recorded, as for cloneAccount.
          out.etches.push({ index: out.calls.length, target: "0x" + data.slice(24, 64), code: "0x", kept });
        } else if (ETH_FUND.has(selector)) {
          // Recorded kept or not, like a tamper: an entry can only shrink a loss.
          // vm.deal(addr, x) sets the balance to x, which the harm gate credits to the
          // test party as "put in" (H1e minor 2). vm.coinbase has no amount: `amount`
          // is null, and the gate stays strict (the party's whole take is the test's).
          let amount = null;
          if (selector === DEAL) { try { amount = BigInt("0x" + data.slice(64, 128)); } catch { amount = null; } }
          out.ethFunded.push({ target: "0x" + data.slice(24, 64), amount: amount === null ? null : amount.toString() });
        } else if (TAMPER.has(selector)) {
          // Forge writes the state DB (or keeps the mock in its inspector) directly. Record
          // it whether or not the frame was kept: an entry can only drop a target.
          const { how, arg } = TAMPER.get(selector);
          const target = arg < 0 ? "*" : "0x" + data.slice(arg * 64 + 24, arg * 64 + 64);
          out.tampers.push({ target, how, ...(how === "store" ? { slot: "0x" + data.slice(64, 128) } : {}), kept });
        } else if (IMPERSONATE.has(selector)) {
          // The impersonated msg.sender is the first address argument. Forge keeps
          // prank state in its inspector, not in EVM state, so a revert does NOT
          // undo it: record it whether or not the frame was kept.
          out.pranks.push("0x" + data.slice(24, 64));
          if (WITH_ORIGIN.has(selector)) out.pranks.push("0x" + data.slice(88, 128));
        }
        return;
      }
      if (t.kind !== "CALL" || !t.success || !ok(i)) return;
      if (execution) out.calls.push({ address, caller });
    });
  }
  out.created = [...created];
  out.selectors = Object.fromEntries(Object.entries(out.selectors).map(([k, v]) => [k, [...v]]));
  out.words = Object.fromEntries(Object.entries(out.words).map(([k, v]) => [k, [...v]]));
  out.calls = out.calls.slice(-4000);
  return out;
}

// The generic takeover filter for the forge harm gate (lib/proof.mjs). A storage
// write is a TAKEOVER only when it re-points a control pointer the writer was not
// entitled to set: a write to a control-significant slot (the owner slot 0, the
// EIP-1967 admin or implementation slot), whose new value is a DIFFERENT address,
// made by a caller who did not already hold that authority. A benign state write
// — a deposit's balance, a counter, a flag — touches no control slot (or writes a
// non-address value) and never qualifies. This mirrors the control-harm standard
// in packs/keys/control.mjs; the funds channel still catches ETH that leaves.
// `targetSet` is anything with a `.has(lowercased-address)` (a Set or the targets
// Map from scanTargets); pass null to skip the scope filter.
export function controlTakeovers(controlTrace, targetSet = null) {
  const writes = controlTrace?.writes ?? [];
  const meta = controlTrace?.writeMeta ?? [];
  return writes.filter((w, i) => {
    if (targetSet && !targetSet.has(lc(w.context))) return false;
    const slot = word(w.slot);
    if (!CONTROL_SLOTS.has(slot)) return false;
    const after = word(w.after), before = word(w.before);
    if (!isAddressWord(after) || after === before) return false; // the new value must be a DIFFERENT address
    // Slot 0 is also where a contract stashes its first scalar (a counter, a flag),
    // and a small integer like 1 is address-shaped. Only count the owner slot when
    // it ALREADY held an address — a genuine re-pointing of an owner, not a scalar
    // init. The EIP-1967 admin and implementation slots are control pointers by
    // definition, so claiming one even from zero is a proxy hijack.
    if (slot === OWNER_SLOT && !isAddressWord(before)) return false;
    const m = meta[i] ?? {};
    const authority = (m.authority ?? []).map(lc);
    if (m.caller && authority.includes(lc(m.caller))) return false; // the writer already held authority: a legitimate hand-over
    return true;
  });
}
