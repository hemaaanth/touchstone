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
//                     fetches into a throwaway workspace.
//   - "scope":        an operator scope with members: GitHub repos and local
//                     folders, mixed, in any language (scopes-store.mjs). Its
//                     pack comes from its content: Solidity runs under
//                     Contracts; code with no fitting replay oracle runs under
//                     the read-only Review pack, whose proofSurface is "none".
//   - "live":         a REAL host the operator has a grant to reach (the first
//                     live-network kind). Unlike every kind above, a run for it
//                     leaves the machine, so the reach gate (spike/lib/reach.mjs)
//                     REFUSES it without a grant naming its host(s), and a
//                     confinement boundary limits its tools' egress to exactly
//                     those hosts. The kind only names a host; the grant is what
//                     authorizes the reach.
//
//                     RUNNABLE. The operator adds a live scope with a
//                     permission checkbox; that tick is recorded as a grant
//                     (scopes-store.mjs addLiveScope) together with the exact
//                     origins typed. The workspace carries those origins as its
//                     base URL, so every request aims at the site itself rather
//                     than at the module's lab. createRun calls openReach in
//                     "confine" mode, which stands up the boundary and gives the
//                     run's script container the gate as its only way out.
//                     A pack may only be pointed at a live host when it says
//                     `live: true`; without it the run would silently scan its
//                     own planted lab and record that lab's bugs against the
//                     operator's website.
import path from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { makeWorkspace, makeBriefWorkspace, readTouchstone, writeTouchstone } from "./sandbox.mjs"
import { PACKS } from "../packs/index.mjs"
import { readScopes, getUserScope, sourceFiles, memberFilePaths, memberProof, scopeBrief, safeRelPath } from "./scopes-store.mjs"
import { reachHosts } from "./reach.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "../..") // repo root

export const TARGET_KINDS = ["lab", "local-source", "brief", "scope", "live"]

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
  {
    id: "vault-shares",
    title: "ShareVault · share math",
    kind: "lab",
    blurb: "A share vault that ships its own property suite. withdraw rounds the shares it burns down, so small withdrawals are free; redeem books shares as assets, so the vault turns insolvent after yield.",
    entry: "src/ShareVault.sol",
    signal: "symbolic",
    dir: "lab/vault-shares",
    proofSurface: SANDBOX_FOUNDRY,
  },
  {
    id: "vault-bytecode",
    title: "Vault · bytecode only",
    kind: "lab",
    blurb: "A vault that ships only as deployed bytecode (src/<Name>.runtime.hex) with a stub that installs it; no vault source. The source tools see nothing, but Mythril reads the bytecode and flags an unprotected sweep(address) that drains the vault.",
    entry: "src/BytecodeVault.sol",
    signal: "static",
    dir: "lab/vault-bytecode",
    proofSurface: SANDBOX_FOUNDRY,
  },
]

// Labs of the other packs. A pack's lab is a directory with a .touchstone.json
// that names the pack. We look in lab/ and in spike/packs/<id>/lab/, so a new pack
// that ships a lab shows up in the New run dialog with no change here. The file
// may also carry `title`, `blurb` and `entry`.
const PROOF_NOTE = {
  http: "Proven by a request replayed in Docker on a private network with no internet.",
  evidence: "Proven by checking the cited evidence again against the pinned snapshot in the run workspace.",
  forge: "Proven in an isolated, offline, per-run Foundry workspace — no live chain and no real funds.",
  none: "This module has no replay oracle. The run reports leads. No finding can be proven.",
}

function packLabs() {
  const found = []
  const seen = new Set()
  const add = (dir, name) => {
    const cfg = readTouchstone(dir)
    if (!cfg.pack || cfg.pack === "contracts" || !PACKS[cfg.pack]) return
    // Two packs may each ship a lab called "app", so a pack lab's id carries its pack.
    const id = `${cfg.pack}/${name}`
    if (seen.has(id)) return
    seen.add(id)
    found.push({
      id,
      // No title in the lab's config: say which pack it belongs to, not its folder name.
      title: cfg.title ?? `${PACKS[cfg.pack].title ?? cfg.pack} lab`,
      kind: "lab",
      pack: cfg.pack,
      blurb: cfg.blurb ?? "",
      entry: cfg.entry ?? null,
      signal: null,
      dir: path.relative(ROOT, dir),
      proofSurface: { kind: PACKS[cfg.pack].proof, note: PROOF_NOTE[PACKS[cfg.pack].proof] ?? "" },
    })
  }
  const childrenOf = (parent) => {
    try { return readdirSync(parent).sort() } catch { return [] }
  }
  for (const name of childrenOf(path.join(ROOT, "lab"))) add(path.join(ROOT, "lab", name), name)
  for (const id of Object.keys(PACKS)) {
    const parent = path.join(ROOT, "spike", "packs", id, "lab")
    // The lab dir may itself be the lab, or hold one lab per child.
    if (existsSync(path.join(parent, ".touchstone.json"))) add(parent, "lab")
    for (const name of childrenOf(parent)) add(path.join(parent, name), name)
  }
  // A pack may also generate its lab on every run: `lab: { title, blurb, make }`
  // in its manifest. `make()` returns a fresh directory. It is one target,
  // `<pack>/lab`, and a lab folder of the same id wins. `generated` marks it; the
  // function itself stays in the manifest, so the target stays plain data.
  for (const pack of Object.values(PACKS)) {
    const id = `${pack.id}/lab`
    if (seen.has(id) || pack.id === "contracts" || typeof pack.lab?.make !== "function") continue
    seen.add(id)
    found.push({
      id,
      title: pack.lab.title ?? `${pack.title ?? pack.id} lab`,
      kind: "lab",
      pack: pack.id,
      blurb: pack.lab.blurb ?? "",
      entry: null,
      signal: null,
      generated: true,
      dir: null,
      proofSurface: { kind: pack.proof, note: PROOF_NOTE[pack.proof] ?? "" },
    })
  }
  return found
}

// The pack a target belongs to. Built-in labs and older operator scopes (brief,
// local-source) have no pack field and are Contracts. A "scope" always has one.
export const packOf = (target) => target?.pack ?? "contracts"

// The exact origins a live run aims at. New scopes carry `origins` (scheme +
// host + port as typed); older ones carry only hosts, which default to https.
function liveOrigins(target) {
  const given = (Array.isArray(target?.origins) ? target.origins : [])
    .map((o) => String(o ?? "").trim())
    .filter((o) => /^https?:\/\/[^/\s]+$/i.test(o))
  if (given.length) return [...new Set(given)]
  return reachHosts(target).map((h) => `https://${h}`)
}

// Resolve a target's workspace source directory to an absolute path. Only "lab"
// targets have a repo-relative `dir`; the later kinds resolve differently and
// will extend this.
export function resolveTargetDir(target) {
  if (!target) throw new Error("no target")
  if (target.generated) throw new Error(`target ${target.id} is generated per run: use prepareRunWorkspace`)
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
    pack: packOf(target),
    blurb: target.blurb,
    entry: target.entry,
    signal: target.signal,
    proofSurface: target.proofSurface,
  }
  if (target.kind === "brief") s.links = Array.isArray(target.links) ? target.links : []
  if (target.kind === "local-source") s.files = (target.files ?? []).map((f) => f.path)
  // A live target shows the host(s) it would touch, so the operator sees exactly
  // what a run reaches before starting it — and whether a grant must be added.
  if (target.kind === "live") {
    s.hosts = reachHosts(target)
    s.origins = liveOrigins(target)
  }
  if (target.kind === "scope") {
    const members = Array.isArray(target.members) ? target.members : []
    s.links = Array.isArray(target.links) ? target.links : []
    s.files = memberFilePaths(members).map((f) => f.path)
    // Per member: what it is and how it is proven. No file content.
    s.members = members.map((m) => (m.kind === "repo"
      ? { kind: "repo", url: m.url, proof: memberProof(m, packOf(target)) }
      : { kind: "folder", name: m.name, files: m.files.length, proof: memberProof(m, packOf(target)) }))
  }
  return s
}

// Whether a target can run right now. A lab needs its directory on disk; a brief
// is always runnable (it fetches its code at run time); local-source is not wired
// yet.
function isRunnable(target) {
  if (target.generated) return true
  if (target.kind === "lab") return existsSync(path.join(ROOT, target.dir))
  if (target.kind === "brief") return true
  if (target.kind === "local-source") return (target.files?.length ?? 0) > 0
  if (target.kind === "scope") return Boolean(PACKS[packOf(target)]) && (target.members?.length ?? 0) > 0
  // A live target runs when it names at least one host and its module says it
  // can test a live site (`live: true`). A pack that has not been wired to a
  // live host would scan its own lab, so it is not offered. The grant check
  // happens at run start (createRun -> openReach), not here.
  if (target.kind === "live") {
    const pack = PACKS[packOf(target)]
    return reachHosts(target).length > 0 && pack?.live === true
  }
  return false
}

// Every target the UI may offer, runnable ones first. Built-in labs come from
// the registry here; operator-added scopes (briefs) come from the gitignored
// scopes store. Both are summarized the same way.
export function listTargets() {
  const builtin = [...TARGETS, ...packLabs()].map((t) => ({ ...targetSummary(t), runnable: isRunnable(t) }))
  const user = readScopes().map((s) => ({ ...targetSummary(s), runnable: isRunnable(s) }))
  const all = [...builtin, ...user]
  return all.sort((a, b) => Number(b.runnable) - Number(a.runnable))
}

// Resolve an id to the full target, checking the built-in labs first and then the
// operator's scopes store. Returns the full object (with brief markdown/links),
// not the summary.
export function getTarget(id) {
  return TARGETS.find((t) => t.id === id) ?? packLabs().find((t) => t.id === id) ?? getUserScope(id) ?? null
}

// Pick the target for a run. An explicit id wins; otherwise choose at random
// from the runnable labs of the chosen pack (Contracts by default) so repeated
// Runs stop hammering one prepared bug. Throws if an explicit id is unknown, not
// yet runnable, or belongs to another pack, so a bad request fails loudly
// instead of silently falling back.
export function pickTarget({ id, pack } = {}) {
  if (id) {
    const t = getTarget(id)
    if (!t) throw new Error(`unknown target: ${id}`)
    if (!isRunnable(t)) throw new Error(`target kind not yet runnable: ${t.kind}`)
    if (pack && packOf(t) !== pack) throw new Error(`target ${id} belongs to pack "${packOf(t)}", not "${pack}"`)
    return t
  }
  const want = pack ?? "contracts"
  let labs = [...TARGETS, ...packLabs()].filter((t) => t.kind === "lab" && packOf(t) === want && isRunnable(t))
  // A pack with no labs (Review) picks from the operator's own scopes for it.
  // A live website runs only when the operator picks it by id, never at random.
  if (!labs.length) labs = readScopes().filter((t) => t.kind !== "live" && packOf(t) === want && isRunnable(t))
  if (!labs.length) throw new Error(`no runnable targets for pack "${want}"`)
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
  const pack = packOf(target)
  if (target.kind === "lab" && pack !== "contracts") {
    // makeWorkspace keeps the lab's own .touchstone.json (pack config, snapshot
    // paths). We add the run's modules on top and never overwrite what it has.
    const ws = makeWorkspace(resolveTargetDir(target))
    writeTouchstone(ws, { ...readTouchstone(ws), kind: "lab", pack, modules })
    return ws
  }
  if (target.kind === "lab") {
    const ws = makeWorkspace(resolveTargetDir(target))
    writeTouchstone(ws, { kind: "lab", solc: "0.8.38", pack, modules })
    return ws
  }
  if (target.kind === "local-source") {
    const files = sourceFiles(target.files)
    const ws = makeBriefWorkspace()
    for (const f of files) {
      const dest = path.join(ws, "src", f.path)
      mkdirSync(path.dirname(dest), { recursive: true })
      writeFileSync(dest, f.content)
    }
    writeTouchstone(ws, { kind: "local-source", solc: "auto", pack, modules })
    return ws
  }
  if (target.kind === "scope") return prepareScopeWorkspace(target, { modules })
  if (target.kind === "brief") {
    const ws = makeBriefWorkspace()
    writeFileSync(path.join(ws, "BRIEF.md"), String(target.brief || ""))
    // The links are the only URLs fetch_source may fetch (lib/fetch.mjs).
    writeTouchstone(ws, { kind: "brief", solc: "auto", pack, modules, links: Array.isArray(target.links) ? target.links : [] })
    return ws
  }
  if (target.kind === "live") {
    // No code to copy. The workspace holds a short brief that names the exact
    // websites and their base URLs, so the agent knows what it may test and the
    // request tool knows where to aim.
    const hosts = reachHosts(target)
    const origins = liveOrigins(target)
    if (!origins.length) throw new Error(`live target ${target.id} names no usable website`)
    if (PACKS[pack]?.live !== true) {
      throw new Error(`The ${pack} module cannot test a live website yet. It would scan its own lab instead of ${hosts[0]}.`)
    }
    // The phishing pack must know the client's own defensive registrations, or it
    // reports them as lookalikes. The list is required. An explicit [] means none.
    if (pack === "phishing" && !Array.isArray(target.owned)) {
      throw new Error(`live phishing target ${target.id} needs an owned list of the client's own lookalike domains. Use [] for none.`)
    }
    const baseUrl = origins[0]
    // A live AI/MCP target can carry its own credential. It rides in the config
    // (the tool reads it) and in the brief (the agent reads it).
    const mcp = target.mcp ?? null
    const ws = makeBriefWorkspace()
    const lines = [
      `# ${target.title || "Live scope"}`,
      "",
      "Live websites. The operator confirmed they have permission to test them.",
      "",
      ...origins.map((o, i) => `- ${o} (host ${hosts[i] ?? reachHosts({ url: o })[0] ?? ""})`),
      "",
      `Base URL for every request: ${baseUrl}`,
    ]
    if (mcp?.token) lines.push("", `Bearer token: ${mcp.token}`)
    if (pack === "supply-chain" && Array.isArray(target.github)) lines.push("", "GitHub repos and orgs (read-only API reads, nothing is cloned or run):", ...target.github.map((g) => `- ${g}`))
    if (target.blurb) lines.push("", String(target.blurb))
    writeFileSync(path.join(ws, "BRIEF.md"), lines.join("\n") + "\n")
    const live = { kind: "live", pack, modules, hosts, origins, baseUrl, ...(mcp ? { mcp } : {}) }
    // The domain packs capture one root domain into a pinned snapshot. They read
    // `domain` and `reach`; the network is the egress one (their tools resolve
    // DNS over UDP, which an HTTP proxy cannot carry), and the grant is asserted
    // in code against `scope`.
    if (pack === "domains" || pack === "surface") {
      const ports = origins.map((o) => {
        const u = new URL(o)
        return { scheme: u.protocol.slice(0, -1), port: Number(u.port || (u.protocol === "https:" ? 443 : 80)) }
      })
      live.domain = hosts[0]
      live.reach = { network: "bridge", granted: true, scope: hosts, ports }
    }
    // The phishing pack captures the lookalikes of one root domain the same way.
    // `owned` lists the client's own defensive registrations; they raise no lead.
    // The pack asserts the grant against `scope` before dnstwist runs.
    if (pack === "phishing") {
      live.domain = hosts[0]
      live.reach = { network: "bridge", granted: true, scope: hosts }
      live.owned = target.owned.map(String)
    }
    // The supply-chain pack reads GitHub repos or orgs through the read-only
    // API. `github` is what to read; `reach.scope` is what the grant covers.
    // The pack asserts both in code before its first request.
    if (pack === "supply-chain") {
      const github = Array.isArray(target.github) ? target.github.map(String) : []
      if (!github.length) throw new Error(`live target ${target.id} names no GitHub repo or org`)
      live.github = github
      live.reach = { granted: true, scope: github.map((g) => g.split("@")[0]), hosts }
    }
    writeTouchstone(ws, live)
    return ws
  }
  throw new Error(`target kind not yet runnable: ${target.kind}`)
}

// Write one scope file under <ws>/src. The stored path was checked when the
// scope was added; check it again, and check the resolved destination stays
// inside src/, so a hand-edited store cannot write outside the workspace.
function writeScopeFile(ws, rel, content) {
  if (!safeRelPath(rel)) throw new Error(`unsafe scope file path: ${rel}`)
  const root = path.join(ws, "src")
  const dest = path.resolve(root, rel)
  if (!dest.startsWith(root + path.sep)) throw new Error(`scope file escapes the workspace: ${rel}`)
  mkdirSync(path.dirname(dest), { recursive: true })
  writeFileSync(dest, content)
}

// A scope's workspace. Folder files land under src/ (one folder keeps its own
// layout; with several, each starts with its folder name). Repos are fetched at
// run time into vendor/. BRIEF.md lists the members.
//   - contracts: a Foundry workspace. Only the Solidity is ever proven, by the
//     offline Foundry replay. "brief" kind when there are repos to fetch, so the
//     pack uses its fetch-first prompt.
//   - review: a plain workspace with no Foundry at all. Its pack cannot prove.
function prepareScopeWorkspace(target, { modules }) {
  const pack = packOf(target)
  if (pack !== "contracts" && pack !== "review") throw new Error(`a scope cannot run under pack "${pack}"`)
  let ws
  if (pack === "contracts") ws = makeBriefWorkspace()
  else {
    ws = mkdtempSync(path.join(tmpdir(), "redteam-run-"))
    mkdirSync(path.join(ws, "src"), { recursive: true })
    mkdirSync(path.join(ws, "vendor"), { recursive: true })
  }
  try {
    for (const f of memberFilePaths(target.members ?? [])) writeScopeFile(ws, f.path, f.content)
    writeFileSync(path.join(ws, "BRIEF.md"), scopeBrief(target))
  } catch (e) {
    rmSync(ws, { recursive: true, force: true })
    throw e
  }
  const links = Array.isArray(target.links) ? target.links : []
  if (pack === "contracts") writeTouchstone(ws, { kind: links.length ? "brief" : "local-source", solc: "auto", pack, modules, links })
  else writeTouchstone(ws, { kind: "scope", pack, modules, links })
  return ws
}

// Build the workspace for one run, for every target the run start may get. A
// generated lab calls its pack's `make()` once, so each run gets its own fresh
// directory. That directory is the run's workspace: the run's own cleanup removes
// it. It must live outside the repo tree, so a lab can never be committed by
// accident. Every other target goes through prepareWorkspace.
export async function prepareRunWorkspace(target, { modules = [] } = {}) {
  if (!target?.generated) return prepareWorkspace(target, { modules })
  const pack = packOf(target)
  const make = PACKS[pack]?.lab?.make
  if (typeof make !== "function") throw new Error(`target ${target.id} has no lab generator`)
  const ws = path.resolve(await make())
  if (ws === ROOT || ws.startsWith(ROOT + path.sep)) {
    rmSync(ws, { recursive: true, force: true })
    throw new Error(`the generated lab for ${target.id} is inside the repository: refused`)
  }
  writeTouchstone(ws, { ...readTouchstone(ws), kind: "lab", pack, modules })
  return ws
}
