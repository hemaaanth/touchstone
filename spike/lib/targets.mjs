// The target library — the scopes the agent can be pointed at.
//
// WHY THIS EXISTS. The app used to hardcode a single contract (lab/vault-
// reentrancy) and re-break the same thing on every Run, so it overfit to one
// prepared bug and never exercised the rest of the engine. A target is now a
// first-class, typed descriptor the engine SELECTS (chosen or random) and
// prepares a workspace from. Adding a scope is adding a row here, not editing
// the orchestrator.
//
// NO LIVE HARM (invariant). Every target declares a `proofSurface`: the only
// place a finding for it may be proven. The engine must never be pointable at
// live funds. A finding is real only when it reproduces on that surface —
//   - "sandbox-foundry": an isolated, offline, per-run Foundry workspace. No
//     chain, no real money. This is what the labs use.
//   - "local-fork" / "test-accounts" (later kinds): a local fork or accounts we
//     explicitly own and that hold nothing of value.
// The proofSurface is the contract that keeps "prove it" from ever meaning
// "cause real-world loss."
//
// KINDS.
//   - "lab":          a prepared Foundry project that ships in this repo.
//   - "local-source": a Foundry project on the operator's own disk (later).
//   - "brief":        a pasted markdown brief whose linked sources the engine
//                     fetches into a throwaway workspace (later).
// Only "lab" is wired today; the shape is here so the later kinds slot in
// without touching callers.
import path from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "../..") // repo root

export const TARGET_KINDS = ["lab", "local-source", "brief"]

// A Foundry workspace proven offline in its own per-run copy. No chain, no funds.
const SANDBOX_FOUNDRY = {
  kind: "sandbox-foundry",
  note: "Proven in an isolated, offline, per-run Foundry workspace — no live chain and no real funds.",
}

// The registry. Each lab's `dir` is repo-relative; `signal` names which
// submodule is EXPECTED to surface the lead first (descriptive, never a gate —
// the replay is still the only thing that makes a finding real). The two labs
// are deliberately a pair: the reentrancy is what a static analyzer catches, the
// insolvency is what a property fuzzer catches, so selecting between them
// exercises both halves of the ensemble instead of one prepared bug.
export const TARGETS = [
  {
    id: "vault-reentrancy",
    title: "Vault · reentrancy",
    kind: "lab",
    blurb: "A simple ETH vault with a classic reentrancy in withdraw(): it sends ETH before zeroing the balance, so an attacker contract can re-enter and drain it.",
    entry: "src/Vault.sol",
    signal: "static",
    dir: "lab/vault-reentrancy",
    proofSurface: SANDBOX_FOUNDRY,
  },
  {
    id: "vault-accounting",
    title: "YieldVault · insolvency",
    kind: "lab",
    blurb: "A yield vault whose withdrawal bonus is mis-scaled (1% instead of 0.01%) and uncapped, so ordinary deposit/withdraw cycles drain the buffer and eat other users' principal.",
    entry: "src/YieldVault.sol",
    signal: "fuzz",
    dir: "lab/vault-accounting",
    proofSurface: SANDBOX_FOUNDRY,
  },
]

// Resolve a target's workspace source directory to an absolute path. Only "lab"
// targets have a repo-relative `dir`; the later kinds resolve differently and
// will extend this.
export function resolveTargetDir(target) {
  if (!target) throw new Error("no target")
  if (target.kind === "lab") return path.join(ROOT, target.dir)
  throw new Error(`target kind not yet runnable: ${target.kind}`)
}

// The summary shape the API serves — no filesystem paths leak to the client.
export function targetSummary(target) {
  return {
    id: target.id,
    title: target.title,
    kind: target.kind,
    blurb: target.blurb,
    entry: target.entry,
    signal: target.signal,
    proofSurface: target.proofSurface,
  }
}

// Every target the UI may offer, runnable ones first. A "lab" is runnable when
// its directory is actually present on disk.
export function listTargets() {
  return TARGETS.map((t) => ({
    ...targetSummary(t),
    runnable: t.kind === "lab" ? existsSync(path.join(ROOT, t.dir)) : false,
  }))
}

export function getTarget(id) {
  return TARGETS.find((t) => t.id === id) ?? null
}

// Pick the target for a run. An explicit id wins; otherwise choose at random
// from the runnable labs so repeated Runs stop hammering one prepared bug.
// Throws if an explicit id is unknown or not yet runnable, so a bad request
// fails loudly instead of silently falling back.
export function pickTarget({ id } = {}) {
  if (id) {
    const t = getTarget(id)
    if (!t) throw new Error(`unknown target: ${id}`)
    if (t.kind !== "lab") throw new Error(`target kind not yet runnable: ${t.kind}`)
    return t
  }
  const labs = TARGETS.filter((t) => t.kind === "lab" && existsSync(path.join(ROOT, t.dir)))
  if (!labs.length) throw new Error("no runnable targets")
  return labs[Math.floor(Math.random() * labs.length)]
}
