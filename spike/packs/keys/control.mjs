// Control harm: a replay that changes who controls a lab target, even when no ETH moves.
// The facts come from the replay state diff (lib/control-trace.mjs), never from the test
// source. A change counts when it hits a contract the test deployed or a lab target
// address, and it is a real storage write or a real code change.
import { keccak256, getBytes, toBeHex, concat } from "ethers";

const lc = (v) => String(v ?? "").toLowerCase();
const pad = (hex) => toBeHex(BigInt(hex), 32);
const SENTINEL = "0x0000000000000000000000000000000000000001";
const IMPLEMENTATION = toBeHex(BigInt(keccak256(new TextEncoder().encode("eip1967.proxy.implementation"))) - 1n, 32);
const ADMIN = toBeHex(BigInt(keccak256(new TextEncoder().encode("eip1967.proxy.admin"))) - 1n, 32);
const GUARD = keccak256(new TextEncoder().encode("guard_manager.guard.address"));
const FALLBACK = keccak256(new TextEncoder().encode("fallback_manager.handler.address"));
const mapping = (key, base) => keccak256(concat([pad(key), pad(toBeHex(base))]));
// Selectors only a Safe answers to. A contract that received one is read with the Safe layout.
const SAFE_SELECTORS = ["0x6a761202", "0x468721a7", "0xb63e800d", "0xa0e67e2b", "0xe75235b8", "0xaffed0e0"];

// What the lab says about itself. Targets are the addresses the agent is allowed to
// prove harm against. EOAs are the lab accounts that can be re-delegated with EIP-7702:
// an owner whose key is public, or an owner that is already delegated.
export function labOf(obs, knownKeys = []) {
  const safes = (obs?.safes ?? []).map((safe) => lc(safe.address));
  const proxy = obs?.address ? lc(obs.address) : null;
  const owners = (obs?.safes ?? []).flatMap((safe) => safe.owners ?? []).map(lc);
  const known = new Set(knownKeys.map(lc));
  const eoas = [...new Set(owners)].filter((owner) => {
    const code = obs?.code?.[owner];
    return known.has(owner) || code?.delegate;
  }).map((address) => ({ address, delegate: lc(obs?.code?.[address]?.delegate ?? "") || null }));
  return { targets: [...safes, ...(proxy ? [proxy] : [])], proxy: Boolean(proxy), eoas };
}

const isSafe = (context, trace) => (trace.selectors[context] ?? []).some((s) => SAFE_SELECTORS.includes(s));

// Name the field a storage slot holds for one contract, or null when it is not control.
function fieldOf(slot, context, lab, trace) {
  if (slot === IMPLEMENTATION) return "EIP-1967 implementation";
  if (slot === ADMIN) return "EIP-1967 admin";
  if (lab.proxy && slot === pad("0x0") && !(trace.selectors[context] ?? []).some((s) => SAFE_SELECTORS.includes(s))) return "owner";
  if (!(trace.selectors[context] ?? []).some((s) => SAFE_SELECTORS.includes(s))) return null;
  if (slot === pad("0x0")) return "Safe singleton";
  if (slot === pad("0x3")) return "Safe owner count";
  if (slot === pad("0x4")) return "Safe threshold";
  if (slot === GUARD) return "Safe guard";
  if (slot === FALLBACK) return "Safe fallback handler";
  for (const address of [SENTINEL, ...(trace.words[context] ?? [])]) {
    if (slot === mapping(address, 2)) return `Safe owner list (entry for ${address})`;
    if (slot === mapping(address, 1)) return `Safe module list (entry for ${address})`;
  }
  return null;
}

// The control changes one replay made. Each item names the target, the field and the slot.
export function controlChanges(trace, lab) {
  if (!trace) return [];
  const candidates = new Set([...trace.created, ...lab.targets].map(lc));
  candidates.delete(lc(trace.testContract));
  const eoas = new Set(lab.eoas.map((eoa) => eoa.address));
  const changes = [];
  (trace.writes ?? []).forEach((write, index) => {
    // A Safe `setup` call is deployment when it runs on a contract the test made or a lab
    // Safe it rebuilt. It is a takeover when it runs on a lab EOA that is not a Safe yet.
    if (write.setup ? !eoas.has(write.context) : !candidates.has(write.context)) return;
    const field = fieldOf(write.slot, write.context, lab, trace);
    if (!field) return;
    // Caller gate. The owner or admin of a proxy may hand over control: that is a legitimate
    // change, not a takeover. Drop a proxy write whose caller already held that authority
    // just before the write. The trace knows the authority when the test deployed the proxy.
    // Safe writes are not gated: a Safe changes itself through its own call. The gate does not
    // need a lab proxy: source mode has none, and an admin's EIP-1967 upgrade is still legitimate.
    const meta = trace.writeMeta?.[index];
    // The authority snapshot is the same in both modes (see lib/control-trace.mjs): the owner
    // (slot 0) and EIP-1967 admin that the contract itself or a prior authority set. A UUPS
    // proxy keeps its owner in slot 0 and has no admin slot, so slot 0 must count here too.
    // An outsider's write never joins the snapshot, so a takeover cannot hide the next write.
    if (!write.setup && !isSafe(write.context, trace) && meta?.caller && (meta.authority ?? []).includes(meta.caller)) return;
    changes.push({ target: write.context, field, slot: write.slot, before: write.before, after: write.after });
  });
  // EIP-7702: etch of a delegation designator on a lab EOA, then a call that ran the delegate.
  for (const etch of trace.etches ?? []) {
    // Only code that landed proves a delegation: an etch in a reverted frame is undone.
    // A missing flag is not kept (fail closed).
    if (etch.kept !== true) continue;
    const eoa = lab.eoas.find((entry) => entry.address === lc(etch.target));
    const bytes = getBytes(etch.code || "0x");
    if (!eoa || bytes.length !== 23 || bytes[0] !== 0xef || bytes[1] !== 0x01 || bytes[2] !== 0x00) continue;
    const delegate = "0x" + etch.code.slice(8).toLowerCase();
    if (delegate === eoa.delegate) continue;
    if (!(trace.calls ?? []).slice(etch.index).some((call) => call.address === eoa.address)) continue;
    changes.push({ target: eoa.address, field: "EIP-7702 delegation", slot: "account code", before: eoa.delegate ?? "none", after: delegate });
  }
  return changes;
}
