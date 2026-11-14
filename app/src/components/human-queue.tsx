import type { RunState } from "@/lib/runModel"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { SandboxDesktop } from "@/components/sandbox-desktop"


export function HumanQueue({ runId, state, live }: { runId: string; state: RunState; live: boolean }) {
  const agents = live ? state.agents.filter((a) => a.loadout === "free-roam") : []
  if (!agents.length) return null
  return (
    <section aria-label="Agent desktops" className="max-h-[45vh] shrink-0 overflow-auto bg-muted/20 px-4 py-2 text-xs">
      {agents.map((agent) => <Collapsible key={`${runId}:${agent.id}`}>
        <CollapsibleTrigger className="focus-ring flex w-full flex-wrap items-center gap-2 py-2 text-left">
          <span>{agent.name ?? agent.id}</span><span className="text-muted-foreground">free-roam · {agent.model ? `Model: ${agent.model}` : "Agent model not reported"} · Desktop</span>
        </CollapsibleTrigger>
        <CollapsibleContent><SandboxDesktop runId={runId} agent={agent.id} live={live} closedAt={state.events.findLastIndex((e) => e.ev === "desktop-view" && e.agent === agent.id && e.state === "closed")} /></CollapsibleContent>
      </Collapsible>)}
    </section>
  )
}

