import type { PackChoice, RunSummary, TargetScope } from "./types"
import type { RunBrief } from "./runModel"

// Words for the module (pack) catalog, shared by the New run dialog and the
// Modules and Scopes pages. A module's own sentence comes from the pack fields
// the loader sends (`live`, `proof`, `tier`, and the reach fields in
// spike/packs/index.mjs). The sentences restate those fields. They are not a
// second source of truth. A pack that sets no reach field gets no reach sentence.

// A scope saved before modules existed has no pack. It is a Contracts scope.
export const DEFAULT_PACK = "contracts"

export const packOf = (t: Pick<TargetScope, "pack"> | null | undefined): string => t?.pack ?? DEFAULT_PACK

// How a pack's replay proves a finding, keyed by the pack's `proof` field.
// Evidence re-checks a pinned snapshot, and Foundry stays in the offline
// sandbox. An HTTP pack that sets `live` can also replay against a granted host.
export const PROOF_KIND: Record<string, { label: string; detail: string }> = {
  forge: {
    label: "Foundry replay",
    detail: "A finding is real only when its Foundry test replays green in the offline sandbox.",
  },
  http: {
    label: "HTTP replay",
    detail: "The replay runs the request script against the practice service. An oracle checks the harm in the responses.",
  },
  evidence: {
    label: "Evidence re-check",
    detail: "The replay checks the cited evidence again against the pinned snapshot.",
  },
  none: {
    label: "No proof",
    detail: "This module has no replay oracle. The run reports leads. No finding can be proven.",
  },
}

const HTTP_LIVE_DETAIL = "The replay runs the request script against a host you've granted, or the practice service. An oracle checks the harm in the responses."

export function proofKind(p: Pick<PackChoice, "proof" | "live">): { label: string; detail: string } {
  const known = PROOF_KIND[p.proof]
  if (!known) return { label: p.proof, detail: "This pack names a proof kind the console does not know yet." }
  if (p.proof === "http" && p.live) return { label: known.label, detail: HTTP_LIVE_DETAIL }
  return known
}

// The pack's tier. "P" is the passive tier. Where the tools reach is the reach fields.
export function tierLabel(tier: string | undefined): string | null {
  if (!tier) return null
  return tier === "P" ? "Passive" : tier
}

type ReachFields = Pick<PackChoice, "tier" | "live" | "labTarget" | "offline" | "fetches" | "scanNet" | "grants" | "extraProof">

// One sentence per reach field value. Each one restates a pack field.
export const REACH_SENTENCE = {
  host: "It can reach a host you've granted.",
  github: "A live run reads a GitHub repo or org you've granted, through the read-only GitHub API.",
  scanNet: "Its scanners run on an open network.",
  offline: "It runs only in our own offline sandbox.",
  fetchGithub: "On the host, it can fetch the GitHub links the scope lists.",
  fetchSolc: "It can also download the Solidity compilers those files pin.",
  fetchRest: "Its other tools work offline.",
  cloudHttp: "One check also gets an HTTP replay against a private practice cloud.",
  standIn: "Its lab target is a rule-based stand-in.",
} as const

// Where this module may run, as the open row states it. Each sentence comes
// from one pack field. A field the console does not know adds nothing.
export function moduleNote(p: ReachFields): string | null {
  const s = REACH_SENTENCE
  const parts: string[] = []
  if (p.live) {
    parts.push(p.grants === "github" ? s.github : s.host)
    if (p.scanNet === "open") parts.push(s.scanNet)
  }
  if (p.offline === true) parts.push(s.offline)
  const fetches = p.fetches ?? []
  if (fetches.includes("github")) parts.push(s.fetchGithub)
  if (fetches.includes("solc")) parts.push(s.fetchSolc)
  if (fetches.includes("github") || fetches.includes("solc")) parts.push(s.fetchRest)
  if (p.extraProof === "cloud-http") parts.push(s.cloudHttp)
  if (p.labTarget === "rule-based") parts.push(s.standIn)
  return parts.length ? parts.join(" ") : null
}

// The closed-row words after the proof label. Same fields as `moduleNote`,
// short enough for the row.
export function moduleAside(p: ReachFields): string | null {
  const parts: string[] = []
  if (p.live) {
    parts.push(p.grants === "github" ? "Can read a granted GitHub repo" : "Can reach a granted host")
    if (p.scanNet === "open") parts.push("Open-network scanners")
  } else {
    const tier = tierLabel(p.tier)
    if (tier) parts.push(tier)
  }
  if (p.offline === true) parts.push("Offline")
  if (p.fetches?.includes("github")) parts.push("Fetches GitHub links")
  if (p.labTarget === "rule-based") parts.push("Rule-based lab")
  return parts.length ? parts.join(" · ") : null
}

// A pipeline step from the recorded plan. The word is on or off for this run.
// A step the operator could not toggle (`fixed`) is still just on: that flag
// is about one plan, not every run of the module.
export function planStepState(step: { on: boolean }): "on" | "off" {
  return step.on ? "on" : "off"
}

// One step of a run's pipeline plan (the `modules` event), as the operator reads it.
export const PLAN_STEP: Record<string, string> = {
  agent: "Agent and PoC synthesis",
  static: "Static leads",
  fuzz: "Fuzz accounting",
  fetch: "Fetch sources",
  replay: "Replay proof",
}

export const SCOPE_KIND: Record<TargetScope["kind"], string> = {
  lab: "Lab",
  "local-source": "Local source",
  brief: "Repository",
  scope: "Scope",
  live: "Live site",
}

// What a scope row shows on the right: its file, its file count, or its repo.
// A scope with several members counts its repos and files.
export function scopeMeta(t: TargetScope): string {
  if (t.origins?.length) return t.origins.join(", ")
  if (t.hosts?.length) return t.hosts.join(", ")
  if ((t.members?.length ?? 0) > 1) {
    const repos = t.links?.length ?? 0
    const files = t.files?.length ?? 0
    return [repos && `${repos} repo${repos === 1 ? "" : "s"}`, files && `${files} file${files === 1 ? "" : "s"}`].filter(Boolean).join(" · ")
  }
  if (t.files?.length) return t.files.length === 1 ? t.files[0] : `${t.files.length} files`
  if (t.links?.length) return t.links[0].replace(/^https?:\/\/(www\.)?(github\.com\/)?/, "")
  return t.entry
}

// Scopes the operator added (as opposed to the built-in labs) can be removed.
export function isOwnScope(id: string) {
  return id.startsWith("source-") || id.startsWith("brief-") || id.startsWith("scope-")
}

// A run plus its loaded brief, for the per-module and per-scope counts.
export interface ScopedRun {
  run: RunSummary
  brief: RunBrief
}

// Every loaded run that recorded its scope, newest first. A run whose
// snapshot has not loaded, or that predates the `scope` event, has no brief
// scope and is left out; `unscoped` counts those so a page can say so.
export function scopedRuns(runs: RunSummary[], briefs: Record<string, RunBrief>) {
  const scoped: ScopedRun[] = []
  let loading = 0
  let unscoped = 0
  for (const run of runs) {
    const brief = briefs[run.id]
    if (!brief) loading++
    else if (!brief.scope) unscoped++
    else scoped.push({ run, brief })
  }
  scoped.sort((a, b) => b.run.startedAt - a.run.startedAt)
  return { scoped, loading, unscoped }
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// Whether GET /api/models has answered yet. "error" with lists already loaded
// means a later refresh failed; the pages keep showing the last answer.
export type CatalogState = "loading" | "ready" | "error"
