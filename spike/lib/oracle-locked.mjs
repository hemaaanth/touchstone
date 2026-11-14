// The `locked` channel: value that is stuck, not stolen.
//
// WHY THIS IS A SEPARATE CHANNEL. Every other harm channel measures a transfer:
// ETH leaves, a token leaves, a control slot is re-pointed. A whole class of real
// incidents moves nothing. The holder still has their receipt (shares, a deposit
// record, a balance) and simply cannot turn it into assets any more. Measured on
// the DefiLlama feed (2025+): 14 incidents name it directly, and it is the second
// half of the vault-share bug we ship in `lab/vault-shares` — the lab's own
// reference exploit proves it with `vm.expectRevert()`, and the gate scores that
// as "no harm" today.
//
// WHAT COUNTS. A withdrawal the holder was ENTITLED to, reverting in the replay
// body, while the holder keeps a non-zero claim. Three parts, and all three are
// needed:
//
//   1. the call was made by a non-test party (the holder, or someone on their
//      behalf) — the test withdrawing its own fixture is not a victim;
//   2. the call REVERTED. A successful withdrawal is the funds channel's business;
//   3. the holder still has a claim afterwards, read from the target's own storage
//      (a share or deposit slot from the compiled layout) or from a public getter
//      the replay observed.
//
// WHY NOT "ANY REVERT". A revert is the most common event in a test: a guard
// working correctly is a revert. So this channel is deliberately narrow:
//   - the call must target a SCOPE contract (the victim is code we hold);
//   - the function name must be a withdrawal family member, from the compiled ABI;
//   - the caller must not be the test or a contract the test created;
//   - `vm.expectRevert` does not make a revert into harm, and does not make it not
//     one: the trace marks the frame, and that is what is read.
//
// WHAT IT CANNOT CATCH, said plainly: a lock with no attempted withdrawal in the
// test (nothing to observe); a protocol that never lets the holder ask (the test
// must attempt it); an insolvency the test cannot reach from the pin.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// The function names that mean "give me what I am owed". Read from the compiled ABI
// so the selector maps to a real function, not to a guess.
const WITHDRAWAL_NAMES = /^(withdraw|withdrawall|redeem|unstake|exit|claim|unwind|unbond|cooldown|requestwithdrawal|emergencywithdraw|removeLiquidity\w*|burn)$/i;

// The storage variable names that hold a claim. Same idea as BALANCE_NAMES in
// lib/proof.mjs, narrowed to the things a holder is owed.
const CLAIM_NAMES = /^(shares?|sharesof|balanceof|balances?|deposits?|principal|stakes?|credits?|receipts?|locked)$/;

const lc = (v) => String(v ?? "").toLowerCase();
const hex = (v) => lc(v).replace(/^0x/, "");

function outDir(ws) {
  try {
    const m = readFileSync(join(ws, "foundry.toml"), "utf8").match(/^\s*out\s*=\s*["']([^"']+)["']/m);
    if (m && !m[1].includes("..")) return join(ws, m[1]);
  } catch { /* default below */ }
  return join(ws, "out");
}

// The selector -> function name map for every contract compiled from the scope, and
// the claim slots each one keeps. Both come from artifacts forge already wrote, so
// no extra compile and no guessing from source text.
export function scopeWithdrawals(ws) {
  const dir = outDir(ws);
  const bySelector = new Map(); // selector -> function name
  const claims = new Map(); // contract name -> [{ slot, label }]
  if (!existsSync(dir)) return { bySelector, claims };
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
      if (!path || !name) continue;
      if (!path.startsWith("src/") && !path.startsWith("vendor/")) continue;
      // `methodIdentifiers` is an object { "fn(types)": "selector" }, not an array.
      for (const [sig, sel] of Object.entries(art?.methodIdentifiers ?? {})) {
        const fn = String(sig).split("(")[0];
        if (!WITHDRAWAL_NAMES.test(fn)) continue;
        if (typeof sel === "string" && /^[0-9a-f]{8}$/i.test(sel)) bySelector.set(sel.toLowerCase(), fn);
      }
      const slots = [];
      for (const s of art?.storageLayout?.storage ?? []) {
        const label = String(s.label ?? "").replace(/^_+/, "");
        if (!CLAIM_NAMES.test(label.toLowerCase())) continue;
        const t = art.storageLayout.types?.[s.type];
        // A mapping keyed by address is a per-holder claim. A plain uint is a total,
        // which is not the holder's own, so it is left out.
        if (!t || t.encoding !== "mapping") continue;
        const kt = art.storageLayout.types?.[t.key];
        if (!/address/.test(String(kt?.label ?? ""))) continue;
        try { slots.push({ slot: "0x" + BigInt(s.slot).toString(16).padStart(64, "0"), label }); } catch { /* skip */ }
      }
      if (slots.length) claims.set(name, slots);
    }
  };
  walk(dir, 0);
  return { bySelector, claims };
}

// The claim a holder still has in a target, from the replay's own storage writes and
// reads. Returns the biggest non-zero value in any claim slot, or 0n.
//
// A slot is `keccak256(holder . base)`. A replay that writes it says so; a replay
// that only SLOADs it says so too (extractControlTrace records the read's value in
// the same step list). Both are used, because "the holder could not withdraw and
// still has shares" is often a READ, not a write.
function claimOf(traces, target, holder, bases) {
  let best = 0n;
  for (const entry of Array.isArray(traces) ? traces : []) {
    if ((Array.isArray(entry) ? entry[0] : null) !== "Execution") continue;
    const arena = (Array.isArray(entry) ? entry[1] : entry)?.arena;
    if (!Array.isArray(arena)) continue;
    for (const node of arena) {
      const t = node?.trace ?? {};
      const ctx = t.kind === "DELEGATECALL" || t.kind === "CALLCODE" ? lc(t.caller) : lc(t.address);
      if (ctx !== target) continue;
      for (const step of t.steps ?? []) {
        const change = step.storage_change;
        if (!change) continue;
        const key = hex(change.key);
        if (!bases.has(key)) continue;
        // A read tells what the claim IS; a write tells what it became.
        for (const v of [change.value, change.had_value]) {
          try { const n = BigInt(v); if (n > best) best = n; } catch { /* a non-numeric word */ }
        }
      }
    }
  }
  return best;
}

// Every (holder, base) pair a claim slot could sit at. Only holders the replay
// actually touched are checked, so the cost is bounded by the trace.
function claimBasesFor(holder, slots) {
  const out = new Map(); // slotWord -> base
  for (const { slot } of slots) {
    try { out.set(mappingSlot(holder, slot), slot); } catch { /* skip */ }
  }
  return out;
}

// keccak256(pad32(holder) . pad32(base)), the mapping-slot formula Foundry uses.
// Kept local (not imported from lib/proof.mjs) so this module has no cycle with it.
import { keccak256 } from "ethers";
function mappingSlot(holder, base) {
  const h = lc(holder).replace(/^0x/, "").padStart(64, "0");
  const b = hex(base).padStart(64, "0");
  // Strip the 0x: trace keys are compared without it (see `hex`), and a slot that
  // keeps the prefix never matches a write.
  return hex(keccak256("0x" + h + b));
}

// The verdict. `scope` is scopeCode(ws) (name + creation code), used only to name the
// victim; `targets` is the address -> name map judgeHarm already computed.
//
// Returns { ok: true, kind: "locked", ... } | { ok: false, reason }.
export function judgeLocked(traces, { ws, targets, controlTrace = null } = {}) {
  if (!targets || !targets.size) return { ok: false, reason: "no scope target, so there is nothing to be locked out of" };
  const { bySelector, claims } = scopeWithdrawals(ws);
  if (!bySelector.size) return { ok: false, reason: "no withdrawal function in the target's compiled ABI, so a lock cannot be read from this replay" };
  // The parties whose withdrawal counts. The test and everything it deployed are the
  // fixture: the test failing to withdraw its own setup is not a victim.
  const { testContract, created } = replayParties(traces);
  const isFixture = (a) => a === testContract || created.has(a);

  const lockouts = [];
  for (const entry of Array.isArray(traces) ? traces : []) {
    if ((Array.isArray(entry) ? entry[0] : null) !== "Execution") continue;
    const arena = (Array.isArray(entry) ? entry[1] : entry)?.arena;
    if (!Array.isArray(arena)) continue;
    for (const node of arena) {
      const t = node?.trace ?? {};
      if (t.kind !== "CALL" || t.success !== false) continue; // only a reverted CALL
      const to = lc(t.address);
      const caller = lc(t.caller);
      const name = targets.get(to);
      if (!name) continue; // not a scope contract
      if (isFixture(caller)) continue; // the test withdrawing its own fixture
      const sel = hex(String(t.data ?? "")).slice(0, 8);
      const fn = bySelector.get(sel);
      if (!fn) continue; // a revert we cannot attribute to a withdrawal
      // The holder's remaining claim, from the target's own storage.
      const slots = claims.get(name) ?? [];
      let stillOwed = 0n;
      for (const cand of [caller, lc(t.origin ?? "")].filter(Boolean)) {
        const bases = claimBasesFor(cand, slots);
        if (!bases.size) continue;
        const v = claimOf(traces, to, cand, bases);
        if (v > stillOwed) stillOwed = v;
      }
      // A reverted withdrawal with no remaining claim is a correct refusal (they
      // already took everything out), not a lock.
      if (stillOwed === 0n) continue;
      lockouts.push({ victim: caller, target: to, name, fn, stillOwed });
    }
  }
  if (!lockouts.length) return { ok: false, reason: "no holder's withdrawal reverted while they still held a claim" };
  lockouts.sort((a, b) => (a.stillOwed > b.stillOwed ? -1 : 1));
  const w = lockouts[0];
  return {
    ok: true,
    kind: "locked",
    victim: w.victim,
    target: w.target,
    contract: w.name,
    // The harm is "could not withdraw what they are owed", so the number is the
    // claim left behind, in the target's own units.
    stillOwed: w.stillOwed.toString(),
    via: w.fn,
    targets: [...targets.entries()].map(([address, name]) => ({ address, name })),
  };
}

// The test contract and every contract the replay deployed. Mirrors the helper in
// lib/proof.mjs; kept local to avoid a cycle.
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
      if ((t.kind === "CREATE" || t.kind === "CREATE2") && addr) created.add(addr);
    });
  }
  return { testContract, created };
}
