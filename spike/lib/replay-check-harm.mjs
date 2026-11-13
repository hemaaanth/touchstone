// Check the replay against the recorded harm. Usage: node check-harm.mjs replay.json
// replay.json is the stdout of the README's `forge test --json -vvvv` command.
// Exit 0: the named test passed and the victim lost exactly the recorded wei.
// Exit 1: it did not. Exit 2: this harm kind cannot be checked from the trace here.
import { readFileSync } from "node:fs";

const here = (name) => new URL(name, import.meta.url);
const want = JSON.parse(readFileSync(here("harm.json"), "utf8"));
const file = process.argv[2] || "replay.json";
let parsed;
try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch { console.error(`FAIL: ${file} is not forge --json output`); process.exit(1); }

let hit = null;
for (const [suite, sd] of Object.entries(parsed || {})) {
  if (want.contract && suite.split(":").pop() !== want.contract) continue;
  for (const [name, r] of Object.entries(sd?.test_results ?? {})) {
    if (!want.test || name === want.test || name.split("(")[0] === want.test.split("(")[0]) { hit = { name, r }; break; }
  }
  if (hit) break;
}
if (!hit) { console.error(`FAIL: no result for ${want.contract || "?"}.${want.test || "?"}`); process.exit(1); }
if (hit.r?.status !== "Success") { console.error(`FAIL: ${hit.name} did not pass (${hit.r?.status})`); process.exit(1); }

// Same rule as the engine's harm gate (lib/proof.mjs scanTargets): only the
// test body ("Execution", not the setUp funding), only a CALL with value, and
// only when that frame and every parent frame returned.
const net = new Map();
const add = (a, d) => { if (a) net.set(a.toLowerCase(), (net.get(a.toLowerCase()) ?? 0n) + d); };
for (const entry of Array.isArray(hit.r.traces) ? hit.r.traces : []) {
  if (!Array.isArray(entry) || entry[0] !== "Execution") continue;
  const arena = entry[1]?.arena;
  if (!Array.isArray(arena)) continue;
  const ok = (i) => { for (let n = arena[i]; n; n = arena[n.parent]) if (!n.trace?.success) return false; return true; };
  arena.forEach((node, i) => {
    const t = node?.trace ?? {};
    if (t.kind !== "CALL" || !ok(i)) return;
    let wei = 0n;
    try { wei = BigInt(t.value ?? "0x0"); } catch { wei = 0n; }
    if (wei > 0n) { add(t.address, wei); add(t.caller, -wei); }
  });
}

const h = want.harm;
if (!h || h.ok !== true) { console.error("CANNOT CHECK: the record has no proven harm."); process.exit(2); }
if (h.kind !== "funds" || h.asset || !h.victim || !/^\d+$/.test(String(h.lostWei ?? ""))) {
  console.error(`CANNOT CHECK: harm kind "${h.kind}${h.asset ? `/${h.asset}` : ""}" needs the engine's storage reader. ${hit.name} passed.`);
  process.exit(2);
}
const lost = -(net.get(h.victim.toLowerCase()) ?? 0n);
if (lost !== BigInt(h.lostWei)) { console.error(`FAIL: ${h.victim} lost ${lost} wei in the replay; the record says ${h.lostWei}.`); process.exit(1); }
console.log(`OK: ${hit.name} passed and ${h.victim} lost ${h.lostWei} wei, as recorded.`);
