// Read control-relevant facts out of a forge replay trace (`forge test --json -vvvvv`).
//
// At verbosity 5 every EVM step carries a `storage_change`. That is the state diff of
// the replay: the engine reads it, not the test source. This file only extracts. It
// does not decide what counts as harm. Packs read the result (see packs/keys/control.mjs).
//
// What we keep, from the "Execution" trace only:
// - writes: a real SSTORE (value changed) in a call that did not revert and outside any
//   contract constructor. A write made under a Safe `setup` call carries `setup: true`.
//   The storage owner is the address that ran the code: the caller for DELEGATECALL,
//   the callee for CALL.
// - etches: calls to the cheatcode `etch(address,bytes)` that stayed in the trace.
// - calls: successful CALL nodes, in order, to see what ran after an etch.
// What we keep from every trace: the set of created contracts, the selectors each
// address received, and the address-shaped words seen in its storage.
const VM = "0x7109709ecfa91a80626ff3989d68f67f5b1dd12d";
const ETCH = "0xb4d6c782";
const SAFE_SETUP = "0xb63e800d";
const lc = (v) => String(v ?? "").toLowerCase();
const word = (v) => "0x" + String(v ?? "0x0").replace(/^0x/, "").padStart(64, "0").toLowerCase();
const isAddressWord = (w) => /^0x0{24}[0-9a-f]{40}$/.test(w) && !/^0x0{64}$/.test(w);

export function extractControlTrace(traces) {
  const out = { created: [], testContract: null, selectors: {}, words: {}, writes: [], etches: [], calls: [] };
  const created = new Set();
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
      if (label !== "Execution") return;
      const context = t.kind === "DELEGATECALL" || t.kind === "CALLCODE" ? caller : address;
      for (const step of t.steps ?? []) {
        const change = step.storage_change;
        if (!change) continue;
        for (const w of [word(change.value), word(change.had_value)]) if (isAddressWord(w)) (out.words[context] ??= new Set()).add("0x" + w.slice(26));
        if (change.reason !== "SSTORE" || word(change.value) === word(change.had_value)) continue;
        if (!ok(i) || under(i, (x) => x.kind === "CREATE")) continue;
        const setup = under(i, (x) => lc(String(x.data ?? "").slice(0, 10)) === SAFE_SETUP);
        out.writes.push({ context, slot: word(change.key), before: word(change.had_value), after: word(change.value), ...(setup ? { setup: true } : {}) });
      }
      if (t.kind === "CALL" && t.success && ok(i)) {
        if (address === VM && selector === ETCH) {
          const data = String(t.data).slice(10);
          const target = "0x" + data.slice(24, 64);
          const length = parseInt(data.slice(128, 192) || "0", 16);
          out.etches.push({ index: out.calls.length, target, code: "0x" + data.slice(192, 192 + length * 2) });
        } else if (address !== VM) out.calls.push({ address, caller });
      }
    });
  }
  out.created = [...created];
  out.selectors = Object.fromEntries(Object.entries(out.selectors).map(([k, v]) => [k, [...v]]));
  out.words = Object.fromEntries(Object.entries(out.words).map(([k, v]) => [k, [...v]]));
  out.calls = out.calls.slice(-4000);
  return out;
}
