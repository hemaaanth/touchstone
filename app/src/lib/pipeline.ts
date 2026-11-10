import type { RunState } from "./runModel"
import type { Finding, RunEvent } from "./types"

export interface PipelineModule {
  label: string
  status: string
  detail: string
  evidence: string
  agreement?: string
  passed?: boolean
}

type ScanRecord = { engines: string[]; suspects: number; top: { corroborated: boolean }[] } | RunEvent

function scanModule(label: string, expected: string, scan: ScanRecord | null): PipelineModule {
  const engines = Array.isArray(scan?.engines) ? scan.engines.filter((e): e is string => typeof e === "string") : []
  const top = Array.isArray(scan?.top) ? scan.top : []
  const agreed = top.filter((s) => s && typeof s === "object" && "corroborated" in s && s.corroborated === true).length
  const skipped = scan && "applicable" in scan && scan.applicable === false
  const failed = scan && "failed" in scan && typeof scan.failed === "number" ? scan.failed : 0
  const analysed = scan && "analysed" in scan && typeof scan.analysed === "number" ? scan.analysed : null
  const ran = engines.length > 0 && analysed !== 0
  const status = !scan ? "No event" : skipped ? "Off" : !ran ? "Inconclusive" : failed > 0 ? "Partial" : "Ran"
  const leads = typeof scan?.suspects === "number" ? ` · ${scan.suspects} lead${scan.suspects === 1 ? "" : "s"}` : ""
  return {
    label,
    status: status + (ran && !skipped ? leads : ""),
    detail: skipped ? "No fuzz template" : engines.join(" + ") || expected,
    agreement: agreed > 0 ? `Agreement on ${agreed}/${top.length} top leads` : undefined,
    evidence: !scan
      ? "No scan evidence was saved. This does not mean the module was off or the scope was clean."
      : skipped
        ? "No fuzz template matched this scope; the fuzz engines did not run."
        : `${engines.length ? `Reported engines: ${engines.join(" + ")}.` : "No engine confirmed."}${failed ? ` ${failed} source scan(s) failed.` : ""}${agreed ? ` ${agreed} of the top ${top.length} leads have engine agreement. These are ranked leads, not proven findings.` : " No engine agreement reported in the saved top leads."}`,
  }
}

// Evidence belongs to this run, never to the current provider or next-run settings.
export function pipelineModules(run: RunState, finding: Finding | null = null): PipelineModule[] {
  const lastEvent = (name: string) => run.events.findLast((e) => e.ev === name) ?? null
  const rawPlan = lastEvent("modules")?.modules
  const plan = Array.isArray(rawPlan) ? rawPlan.filter((m): m is { id: string; on: boolean; reason?: string | null } =>
    m && typeof m === "object" && typeof m.id === "string" && typeof m.on === "boolean",
  ) : []
  const configured = (id: string, module: PipelineModule): PipelineModule => {
    const config = plan.find((m) => m.id === id)
    if (!config || module.status !== "No event") return module
    const reason = typeof config.reason === "string" ? config.reason.trim().replace(/[.!?]$/, "") : ""
    return {
      ...module,
      status: config.on ? "Selected" : "Off",
      evidence: `${reason ? `${reason}. ` : ""}${config.on ? "Selected for this run; no execution event was saved yet." : "Disabled in this run's module plan."}`,
    }
  }
  const attempts = run.steps.filter((s) => s.kind === "poc")
  const passed = finding ? finding.stages.proven && finding.proof.pass : attempts.some((s) => s.state === "pass")
  const active = !finding && !run.closed && ["starting", "running", "awaiting-approval", "deciding"].includes(run.status)
  const replayStatus = passed ? "Passed" : attempts.some((s) => s.state === "running") ? (active ? "Running" : "Incomplete") : attempts.length ? "Not passed" : "No event"
  const fetchStart = lastEvent("fetch_source")
  const fetchResult = run.events.findLastIndex((e) => e.ev === "fetch_source-done") > run.events.findLastIndex((e) => e.ev === "fetch_source") ? lastEvent("fetch_source-done") : null
  const agentRan = run.steps.some((s) => ["read", "list", "poc"].includes(s.kind)) || Boolean(fetchStart) || Boolean(finding?.calls.length)
  const agentOpened = run.steps.some((s) => s.kind === "open")
  const modules: PipelineModule[] = [
    configured("static", scanModule("Static ensemble", "Slither + Aderyn", lastEvent("static-scan") ?? finding?.staticScan ?? null)),
    configured("fuzz", scanModule("Fuzz ensemble", "Echidna + Medusa", lastEvent("fuzz-scan") ?? finding?.fuzzScan ?? null)),
    configured("agent", {
      label: "Abliterated agent",
      status: agentRan ? "Ran" : agentOpened ? "Started" : "No event",
      detail: "Exploit hypothesis",
      evidence: agentRan ? "Agent tool activity was recorded. Its output alone is not proof." : agentOpened ? "The session opened; no agent tool activity is recorded yet." : "No agent activity was saved.",
    }),
    configured("replay", {
      label: "Proof gate",
      status: replayStatus,
      detail: "Foundry replay",
      passed,
      evidence: passed ? "A deterministic replay passed. Only replay can prove a finding." : attempts.length ? `${attempts.length} replay attempt(s) recorded; no passing replay.` : "No replay evidence was saved. Nothing is proven by this strip.",
    }),
  ]
  if (plan.some((m) => m.id === "fetch") || fetchStart || fetchResult) {
    modules.splice(3, 0, configured("fetch", {
      label: "Source fetch",
      status: fetchResult ? (fetchResult.ok === true ? "Ran" : "Failed") : fetchStart ? (active ? "Fetching" : "Incomplete") : "No event",
      detail: "Brief sources",
      evidence: fetchResult ? (fetchResult.ok === true ? "The source fetch completed. Fetched code is not proof of a finding." : "The latest source fetch failed. This result does not confirm usable source.") : "No completed source fetch was saved.",
    }))
  }
  return modules
}
