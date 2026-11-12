// Read control-relevant facts out of a forge replay trace (`forge test --json -vvvvv`).
//
// At verbosity 5 every EVM step carries a `storage_change`. That is the state diff of
// the replay: the engine reads it, not the test source. This file only extracts. It
// does not decide what counts as harm. Packs read the result (see packs/keys/control.mjs).
//
// What we keep:
// - etches: calls to the cheatcode `etch(address,bytes)` that stayed in the trace, read
//   from EVERY trace, `Setup` included. A setUp() etch swaps a target's code before the
//   test body runs, so the harm gate must still exclude the address; the record is not
//   itself harm. `index` is the out.calls offset the etch applies to.
// - writes (from the "Execution" trace only): a real SSTORE (value changed) in a call
//   that did not revert and outside any contract constructor. A write made under a Safe
//   `setup` call carries `setup: true`. A setUp write is fixture, not an exploit step.
//   The storage owner is the address that ran the code: the caller for DELEGATECALL,
//   the callee for CALL.
// - calls (from the "Execution" trace only): successful CALL nodes, in order, to see
//   what ran after an etch.
// What we keep from every trace: the set of created contracts and the selectors each
// address received. The address-shaped words in its storage come from Execution only.
// - writeMeta[i] = { caller, authority } for writes[i] (kept apart so `writes` keeps its shape): who the contract saw as msg.sender, and the owner
//   (slot 0) and EIP-1967 admin the contract held just before the write. They come from the
//   SSTOREs of every trace, constructors included. A write whose caller already held
//   authority is a legitimate change, not a takeover. control.mjs decides.
import { keccak256, toUtf8Bytes } from "ethers";
const VM = "0x7109709ecfa91a80626ff3989d68f67f5b1dd12d";
const ETCH = "0xb4d6c782";
const SAFE_SETUP = "0xb63e800d";
const lc = (v) => String(v ?? "").toLowerCase();
const word = (v) => "0x" + String(v ?? "0x0").replace(/^0x/, "").padStart(64, "0").toLowerCase();
const isAddressWord = (w) => /^0x0{24}[0-9a-f]{40}$/.test(w) && !/^0x0{64}$/.test(w);
const OWNER_SLOT = word("0x0");
const ADMIN_SLOT = word("0x" + (BigInt(keccak256(toUtf8Bytes("eip1967.proxy.admin"))) - 1n).toString(16));
const asAddress = (w) => (isAddressWord(w) ? "0x" + w.slice(26) : null);

export function extractControlTrace(traces) {
  const out = { created: [], testContract: null, selectors: {}, words: {}, writes: [], writeMeta: [], etches: [], calls: [] };
  const created = new Set();
  const held = {}; // context -> { [slot]: word } for the owner and admin slots only
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
        if (change.reason !== "SSTORE" || word(change.value) === word(change.had_value)) continue;
        if (!ok(i)) continue;
        const mine = held[context] ?? {};
        const authority = [asAddress(mine[OWNER_SLOT]), asAddress(mine[ADMIN_SLOT])].filter(Boolean);
        const caller = senderOf();
        if (execution && !under(i, (x) => x.kind === "CREATE")) {
          const setup = under(i, (x) => lc(String(x.data ?? "").slice(0, 10)) === SAFE_SETUP);
          out.writes.push({ context, slot: key, before: word(change.had_value), after: word(change.value), ...(setup ? { setup: true } : {}) });
          out.writeMeta.push({ caller, authority });
        }
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
      } else if (execution && address !== VM) out.calls.push({ address, caller });
    });
  }
  out.created = [...created];
  out.selectors = Object.fromEntries(Object.entries(out.selectors).map(([k, v]) => [k, [...v]]));
  out.words = Object.fromEntries(Object.entries(out.words).map(([k, v]) => [k, [...v]]));
  out.calls = out.calls.slice(-4000);
  return out;
}
