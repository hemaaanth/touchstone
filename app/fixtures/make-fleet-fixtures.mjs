// Writes two fixture runs that follow the fleet event contract in
// src/lib/types.ts. They are hand-written, not recorded from a model.
//
//   node app/fixtures/make-fleet-fixtures.mjs
//
// To view one in the app, copy it into the results dir (never commit it there):
//   cp app/fixtures/run-fleet-live-2611110900-1.stream.jsonl spike/results/agent/
// then restart the dev server.
import { writeFileSync } from "node:fs"
import path from "node:path"

const here = path.dirname(new URL(import.meta.url).pathname)
let t = Date.UTC(2026, 10, 11, 9, 0, 0)
const at = (s) => (t += s * 1000)
const C = "coordinator"
const out = []
const ev = (s, name, data = {}) => out.push({ t: at(s), ev: name, ...data })

const scope = {
  id: "vault-multi",
  title: "FeeVault",
  kind: "lab",
  pack: "contracts",
  blurb: "A fee-charging ETH vault with an owner.",
  entry: "src/FeeVault.sol",
}
const fleet = [
  ["a-recon", "Recon-Alpha", "Map external calls and value flows", "recon", "T1"],
  ["a-exploit", "Exploit-Beta", "Reproduce the withdrawAll reentrancy", "reentrancy", "T1"],
  ["a-fuzz", "Fuzz-Gamma", "Fuzz fee math invariants", "fee math", "T1"],
  ["a-static", "Static-Delta", "Triage static analyzer leads", "static", "T1"],
  ["a-eps", "Exploit-Epsilon", "Try the rescue() zero-address path", "access control", "T1"],
  ["a-worker", "Worker-Zeta", "Draft a raw-tx drain for rescue()", "raw tx", "T2"],
]

ev(0, "scope", { scope })
ev(0, "budget", { usd: 5 })
ev(0, "status", { status: "running", pending: null, decision: null })
ev(0, "opened", { mode: "run" })
ev(1, "operator-message", { id: "op-1", text: "Audit FeeVault. Find anything that drains funds." })
ev(2, "thinking-delta", { conv: "root", text: "Six angles. Recon first, exploit in parallel." })
ev(3, "assistant-delta", { conv: "root", text: "I'll split this across six agents. Recon maps the value flows while the others chase the known leads." })
for (const [id, name, title, area, tier] of fleet)
  ev(1, "subagent-spawned", { id, name, title, area, tier, parent: null, conv: `conv-${id}` })

// Recon-Alpha works and posts.
ev(2, "read_source", { agent: "a-recon", file: "src/FeeVault.sol" })
ev(1, "thinking-delta", { agent: "a-recon", conv: "conv-a-recon", text: "withdrawAll sends ETH before zeroing the balance." })
ev(2, "assistant-delta", { agent: "a-recon", conv: "conv-a-recon", text: "withdrawAll() calls out before it updates state. That is a classic reentrancy shape." })
ev(1, "bulletin-post", { agent: "a-recon", id: "b1", author: "a-recon", kind: "note", text: "withdrawAll() sends ETH before zeroing balances[msg.sender].", lane: "trusted" })
ev(1, "agent-message", { agent: "a-recon", id: "m1", from: "a-recon", to: "a-exploit", text: "withdrawAll() at line 33 calls out before the state write. Worth a reentrant receiver." })
ev(1, "agent-spend", { id: "a-recon", usd: 0.12 })

// Coordinator hands off to Exploit-Beta.
ev(1, "agent-message", { id: "m2", from: C, to: "a-exploit", text: "Recon confirms the external call. Build a PoC with a reentrant receiver." })
ev(2, "read_source", { agent: "a-exploit", file: "src/FeeVault.sol" })
ev(1, "thinking-delta", { agent: "a-exploit", conv: "conv-a-exploit", text: "Receiver re-enters withdrawAll in receive()." })
ev(1, "artifact-open", { agent: "a-exploit", id: "poc-1", fileId: "poc-reentrancy", title: "ReentrancyDrain.t.sol", kind: "poc", lang: "solidity", attempt: 1, contract: "ReentrancyDrainTest" })
ev(1, "artifact-delta", { agent: "a-exploit", id: "poc-1", text: "contract ReentrancyDrainTest is Test {\n  // ...\n}\n" })
ev(1, "artifact-done", { agent: "a-exploit", id: "poc-1" })
ev(1, "assistant-delta", { agent: "a-exploit", conv: "conv-a-exploit", text: "Draft PoC written. Running it next." })
ev(1, "agent-spend", { id: "a-exploit", usd: 0.31 })

// Fuzz and static post; one lead.
ev(2, "bulletin-post", { agent: "a-fuzz", id: "b2", author: "a-fuzz", kind: "note", text: "Fee math holds under 10k runs. No rounding drain found.", lane: "trusted" })
ev(1, "agent-status", { id: "a-fuzz", state: "idle" })
ev(1, "bulletin-post", { agent: "a-static", id: "b3", author: "a-static", kind: "lead", severity: "high", tags: ["corroborated", "reentrancy-eth"], text: "Slither and Aderyn both flag withdrawAll() reentrancy.", lane: "trusted" })
ev(1, "agent-message", { agent: "a-static", id: "m3", from: "a-static", to: C, text: "Both engines agree on withdrawAll(). The rest are low." })

// Exploit-Epsilon fails.
ev(2, "thinking-delta", { agent: "a-eps", conv: "conv-a-eps", text: "rescue() takes an address..." })
ev(1, "subagent-done", { agent: "a-eps", id: "a-eps", status: "failed", error: "Provider returned 503" })

// Untrusted worker posts to the evidence lane.
ev(2, "bulletin-post", { agent: "a-worker", id: "b4", author: "a-worker", kind: "lead", severity: "high", tags: ["trace-07"], text: "rescue(address(0)) burns the vault balance. Raw tx attached.", lane: "evidence" })
ev(1, "bulletin-post", { id: "b5", author: C, kind: "note", text: "Focus on withdrawAll() first. rescue() waits for a replay.", lane: "trusted" })
ev(1, "assistant-delta", { conv: "root", attempt: 1, text: "Exploit-Beta is building the reentrancy PoC. Exploit-Epsilon hit a provider error." })
ev(1, "thinking-delta", { agent: "a-exploit", conv: "conv-a-exploit", attempt: 1, text: "Run the PoC with forge test..." })

const live = out.slice()
writeFileSync(path.join(here, "run-fleet-live-2611110900-1.stream.jsonl"), live.map((e) => JSON.stringify(e)).join("\n") + "\n")

// Settled variant: the PoC passes, everyone finishes, the run records.
ev(5, "run_poc", { agent: "a-exploit", attempt: 1, contract: "ReentrancyDrainTest" })
ev(5, "run_poc-done", { agent: "a-exploit", contract: "ReentrancyDrainTest", passed: true })
ev(1, "agent-message", { agent: "a-exploit", id: "m4", from: "a-exploit", to: C, text: "PoC passes. withdrawAll() drains the vault in one call." })
for (const [id] of fleet) if (id !== "a-eps") ev(1, "subagent-done", { agent: id, id, status: "done" })
ev(1, "finding-submitted", { n: 1, title: "Reentrancy in withdrawAll() drains the vault", severity: "high", poc: "ReentrancyDrainTest" })
ev(1, "finding", { id: "fleet-done-2611110900-1.1", title: "Reentrancy in withdrawAll() drains the vault", severity: "high", module: "agent", proven: true, poc: "ReentrancyDrainTest" })
ev(1, "say", { conv: "root", attempt: 2, text: "One proven finding: reentrancy in withdrawAll(). The rescue() lead stays unverified." })
ev(1, "status", { status: "recorded", decision: "approve", findingId: "fleet-done-2611110900-1.1" })
ev(0, "closed")
writeFileSync(path.join(here, "run-fleet-done-2611110900-1.stream.jsonl"), out.map((e) => JSON.stringify(e)).join("\n") + "\n")
console.log(`live: ${live.length} events, done: ${out.length} events`)
