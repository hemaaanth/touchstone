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
import { existsSync, writeFileSync } from "node:fs"
import { makeWorkspace, makeBriefWorkspace, writeTouchstone } from "./sandbox.mjs"
import { readScopes, getUserScope } from "./scopes-store.mjs"

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
  {
    id: "vault-multi",
    title: "FeeVault · full audit",
    kind: "lab",
    blurb: "A fee-charging ETH vault with an owner. It holds several bugs of different severity; a complete audit should prove every one, worst first.",
    entry: "src/FeeVault.sol",
    signal: "static",
    dir: "lab/vault-multi",
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
// A brief also carries its links (the sources a run will fetch) so the UI can
// show what a run pulls before it starts; the full markdown stays server-side.
export function targetSummary(target) {
  const s = {
    id: target.id,
    title: target.title,
    kind: target.kind,
    blurb: target.blurb,
    entry: target.entry,
    signal: target.signal,
    proofSurface: target.proofSurface,
  }
  if (target.kind === "brief") s.links = Array.isArray(target.links) ? target.links : []
  return s
}

// Whether a target can run right now. A lab needs its directory on disk; a brief
// is always runnable (it fetches its code at run time); local-source is not wired
// yet.
function isRunnable(target) {
  if (target.kind === "lab") return existsSync(path.join(ROOT, target.dir))
  if (target.kind === "brief") return true
  return false
}

// Every target the UI may offer, runnable ones first. Built-in labs come from
// the registry here; operator-added scopes (briefs) come from the gitignored
// scopes store. Both are summarized the same way.
export function listTargets() {
  const builtin = TARGETS.map((t) => ({ ...targetSummary(t), runnable: isRunnable(t) }))
  const user = readScopes().map((s) => ({ ...targetSummary(s), runnable: isRunnable(s) }))
  const all = [...builtin, ...user]
  return all.sort((a, b) => Number(b.runnable) - Number(a.runnable))
}

// Resolve an id to the full target, checking the built-in labs first and then the
// operator's scopes store. Returns the full object (with brief markdown/links),
// not the summary.
export function getTarget(id) {
  return TARGETS.find((t) => t.id === id) ?? getUserScope(id) ?? null
}

// Pick the target for a run. An explicit id wins; otherwise choose at random
// from the runnable labs so repeated Runs stop hammering one prepared bug.
// Throws if an explicit id is unknown or not yet runnable, so a bad request
// fails loudly instead of silently falling back.
export function pickTarget({ id } = {}) {
  if (id) {
    const t = getTarget(id)
    if (!t) throw new Error(`unknown target: ${id}`)
    if (!isRunnable(t)) throw new Error(`target kind not yet runnable: ${t.kind}`)
    return t
  }
  const labs = TARGETS.filter((t) => t.kind === "lab" && existsSync(path.join(ROOT, t.dir)))
  if (!labs.length) throw new Error("no runnable targets")
  return labs[Math.floor(Math.random() * labs.length)]
}

// Build the run's workspace for any runnable target, and write the per-workspace
// .touchstone.json config every later step reads. A lab copies its prepared repo
// and compiles with the pinned solc so its suspect lines line up. A brief starts
// empty — its BRIEF.md is written in, its code is fetched into vendor/ at run
// time — and compiles in "auto" solc so forge matches whatever the fetched code
// pins. `modules` is the on/off plan for this run; it rides in the config so the
// agent child and the decide child agree on which tools exist across a resume.
export function prepareWorkspace(target, { modules = [] } = {}) {
  if (target.kind === "lab") {
    const ws = makeWorkspace(resolveTargetDir(target))
    writeTouchstone(ws, { kind: "lab", solc: "0.8.38", modules })
    return ws
  }
  if (target.kind === "brief") {
    const ws = makeBriefWorkspace()
    writeFileSync(path.join(ws, "BRIEF.md"), String(target.brief || ""))
    writeTouchstone(ws, { kind: "brief", solc: "auto", modules })
    return ws
  }
  throw new Error(`target kind not yet runnable: ${target.kind}`)
}
