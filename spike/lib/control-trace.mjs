// Read control-relevant facts out of a forge replay trace (`forge test --json -vvvvv`).
//
// At verbosity 5 every EVM step carries a `storage_change`. That is the state diff of
// the replay: the engine reads it, not the test source. This file only extracts. It
// does not decide what counts as harm. Packs read the result (see packs/keys/control.mjs).
//
// What we keep:
// - etches: calls to the cheatcode `etch(address,bytes)`, plus `cloneAccount(source,target)`
//   recorded as an etch of its target, that stayed in the trace, read from EVERY trace,
//   `Setup` included. A setUp() etch swaps a target's code before the test body runs, so
//   the harm gate must still exclude the address; the record is not itself harm. `index`
//   is the out.calls offset the etch applies to.
// - writes (from the "Execution" trace only): a real SSTORE (value changed) in a call
//   that did not revert and outside any contract constructor. A write made under a Safe
//   `setup` call carries `setup: true`. A setUp write is fixture, not an exploit step.
//   The storage owner is the address that ran the code: the caller for DELEGATECALL,
//   the callee for CALL.
// - pranks: the impersonated msg.sender (first address argument) of every vm.prank /
//   vm.startPrank in the trace. A target the test pranked AS cannot be a drain victim:
//   the move is the test acting as that target, not an exploit (see lib/proof.mjs).
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
import { keccak256, toUtf8Bytes } from "ethers";
const VM = "0x7109709ecfa91a80626ff3989d68f67f5b1dd12d";
const ETCH = "0xb4d6c782";
// vm.cloneAccount(address source, address target) copies source's code (and
// storage, balance, nonce) onto target. For the harm gate that is an etch of
// the SECOND argument: target is no longer the scope's compiled code, so it
// must stop being a scope target, exactly as a plain etch does.
const CLONE_ACCOUNT = "0x533d61c9";
// vm.prank / vm.startPrank set msg.sender for the following call(s). The sender
// to impersonate is always the FIRST address argument. If a test pranks AS a
// scope target and then moves that target's funds, the "drain" is the test
// acting as the victim, not an exploit — the harm gate drops such a victim.
// Single- and two-arg (sender, origin) forms; the first word is the sender.
const PRANK = new Set(["0xca669fa7", "0x06447d56", "0x47e50cce", "0x45b56078"]);
const SAFE_SETUP = "0xb63e800d";
const lc = (v) => String(v ?? "").toLowerCase();
export const word = (v) => "0x" + String(v ?? "0x0").replace(/^0x/, "").padStart(64, "0").toLowerCase();
export const isAddressWord = (w) => /^0x0{24}[0-9a-f]{40}$/.test(w) && !/^0x0{64}$/.test(w);
const OWNER_SLOT = word("0x0");
export const ADMIN_SLOT = word("0x" + (BigInt(keccak256(toUtf8Bytes("eip1967.proxy.admin"))) - 1n).toString(16));
export const IMPLEMENTATION_SLOT = word("0x" + (BigInt(keccak256(toUtf8Bytes("eip1967.proxy.implementation"))) - 1n).toString(16));
const CONTROL_SLOTS = new Set([OWNER_SLOT, ADMIN_SLOT, IMPLEMENTATION_SLOT]);
export const asAddress = (w) => (isAddressWord(w) ? "0x" + w.slice(26) : null);

export function extractControlTrace(traces) {
  const out = { created: [], testContract: null, selectors: {}, words: {}, writes: [], writeMeta: [], etches: [], pranks: [], calls: [] };
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
      if (t.kind !== "CALL" || !t.success || !ok(i)) return;
      if (address === VM && selector === ETCH) {
        const data = String(t.data).slice(10);
        const target = "0x" + data.slice(24, 64);
        const length = parseInt(data.slice(128, 192) || "0", 16);
        out.etches.push({ index: out.calls.length, target, code: "0x" + data.slice(192, 192 + length * 2) });
      } else if (address === VM && selector === CLONE_ACCOUNT) {
        // cloneAccount(source, target): the SECOND word is the target whose code
        // was replaced. The cloned bytes come from source's live code, not the
        // calldata, so we record no code — the harm gate reads only `target`.
        const data = String(t.data).slice(10);
        const target = "0x" + data.slice(88, 128);
        out.etches.push({ index: out.calls.length, target, code: "0x" });
      } else if (address === VM && PRANK.has(selector)) {
        // The impersonated msg.sender is the first address argument.
        const data = String(t.data).slice(10);
        out.pranks.push("0x" + data.slice(24, 64));
      } else if (execution && address !== VM) out.calls.push({ address, caller });
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
