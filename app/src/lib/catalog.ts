import type { PackChoice, RunSummary, TargetScope } from "./types"
import type { RunBrief } from "./runModel"

// Words for the module (pack) catalog, shared by the New run dialog and the
// Modules and Scopes pages. Every sentence here restates what the engine
// already does (spike/packs/*, spike/lib/modules.mjs). None of it is data.

// A scope saved before modules existed has no pack. It is a Contracts scope.
export const DEFAULT_PACK = "contracts"

export const packOf = (t: Pick<TargetScope, "pack"> | null | undefined): string => t?.pack ?? DEFAULT_PACK

// How a pack's replay proves a finding, keyed by the pack's `proof` field.
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
    detail: "No replay oracle fits this code. The run reports leads. No finding can be proven.",
  },
}

export function proofKind(p: PackChoice): { label: string; detail: string } {
  return PROOF_KIND[p.proof] ?? { label: p.proof, detail: "This pack names a proof kind the console does not know yet." }
}

// The pack's tier. Every pack today is "P": passive, it runs only in our own
// offline sandbox.
export function tierLabel(tier: string | undefined): string | null {
  if (!tier) return null
  return tier === "P" ? "Passive" : tier
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
}

// What a scope row shows on the right: its file, its file count, or its repo.
// A scope with several members counts its repos and files.
export function scopeMeta(t: TargetScope): string {
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
