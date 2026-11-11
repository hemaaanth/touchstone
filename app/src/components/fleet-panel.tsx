import { useState } from "react"
import { ChevronRight, Users } from "lucide-react"
import type { Fleet, HunterAgent, AgentStatus, Tier, Lead } from "@/lib/fleet"
import { fleetSummary } from "@/lib/fleet"
import { formatNum, formatUsd } from "@/lib/format"
import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"

// The Fleet panel beside the files pane. One flat list of child agents — no
// per-agent cards, no model brand colours (docs §6a/§6b). Selecting a row opens
// a joined, read-only "Inspecting [agent]" region below the list. The row order
// is the fleet's own order and never re-sorts on status/spend change, so a row
// never jumps and a newly spawned agent cannot steal the selection.

// Registry trust label. Tier-2 is spelled out as "T2 untrusted" (a hard rule);
// the label is derived from the tier, never the model name, and stays neutral.
function tierLabel(tier: Tier): string {
  return tier === 2 ? "T2 untrusted" : `T${tier}`
}

// Neutral lifecycle word. Done is NOT "success", Failed is NOT "danger" — the
// console reserves success/danger signalling for an authoritative proven lead.
const STATUS_WORD: Record<AgentStatus, string> = {
  spawning: "Spawning",
  working: "Working",
  idle: "Idle",
  done: "Done",
  failed: "Failed",
}

// A tiny grayscale presence dot — all neutral, no green/red. "working" reads
// solid, in-flight pulses, settled states fade, failed is a hollow ring.
function StatusDot({ status }: { status: AgentStatus }) {
  if (status === "failed") {
    return <span className="size-1.5 shrink-0 rounded-full border border-muted-foreground/70" />
  }
  return (
    <span
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        status === "working" && "bg-foreground",
        status === "spawning" && "bg-muted-foreground animate-pulse",
        (status === "idle" || status === "done") && "bg-muted-foreground/50",
      )}
    />
  )
}

export function FleetPanel({
  fleet,
  leads,
  selectedId,
  onSelect,
}: {
  fleet: Fleet
  leads: Lead[]
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  const summary = fleetSummary(fleet)
  const selected = fleet.agents.find((a) => a.id === selectedId) ?? null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b px-3 py-2.5">
        <Users className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">
          Fleet{DOT_SEP}
          <span className="text-muted-foreground tabular-nums">
            {summary.agents} {summary.agents === 1 ? "agent" : "agents"}
            {DOT_SEP}
            {summary.active} active
          </span>
        </span>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        {fleet.agents.length === 0 ? (
          <p className="border-b px-3 py-6 text-center text-xs leading-relaxed text-muted-foreground">
            No hunters spawned yet. The coordinator scales the fleet as the run needs it.
          </p>
        ) : (
          <ul className="divide-y">
            {fleet.agents.map((agent) => (
              <li key={agent.id}>
                <AgentRow
                  agent={agent}
                  selected={agent.id === selectedId}
                  onSelect={() => onSelect(agent.id === selectedId ? null : agent.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>

      {selected ? (
        <InspectRegion agent={selected} leads={leads} onClose={() => onSelect(null)} />
      ) : null}
    </div>
  )
}

const DOT_SEP = <span className="px-1 text-muted-foreground/60">·</span>

function AgentRow({
  agent,
  selected,
  onSelect,
}: {
  agent: HunterAgent
  selected: boolean
  onSelect: () => void
}) {
  // The token disclosure is independent of selection (docs §6b: "tokens in the
  // disclosure"). Expanding it does not select the row.
  const [tokensOpen, setTokensOpen] = useState(false)
  const shortId = agent.id

  return (
    <div className={cn("min-h-[56px] transition-colors", selected && "bg-muted")}>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="flex w-full flex-col gap-1 px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {/* Primary line: Agent / short id · Tier · Model · Status · Spend */}
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{agent.name}</span>
          <span className="shrink-0 truncate font-mono text-[10px] text-muted-foreground/70">{shortId}</span>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <StatusDot status={agent.status} />
            <span className="text-[11px] text-muted-foreground">{STATUS_WORD[agent.status]}</span>
            <span className="w-14 text-right text-xs tabular-nums">{formatUsd(agent.spend.usd)}</span>
          </div>
        </div>
        {/* Secondary line: tier + model as neutral text, never a brand chip. */}
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className={cn(agent.tier === 2 && "rounded border border-border px-1 py-px font-medium text-foreground/80")}>
            {tierLabel(agent.tier)}
          </span>
          <span className="text-muted-foreground/60">·</span>
          <span className="truncate font-mono">{agent.model}</span>
        </div>
        {/* Current task, truncated to one line. */}
        <p className="truncate text-xs text-muted-foreground">{agent.task ?? "No task assigned yet."}</p>
      </button>

      {/* Token disclosure — right-click-free, stops short of selecting. */}
      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={() => setTokensOpen((v) => !v)}
          className="group flex items-center gap-1 text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ChevronRight className={cn("size-3 transition-transform", tokensOpen && "rotate-90")} />
          Tokens
        </button>
        {tokensOpen ? (
          <div className="mt-1 flex gap-4 pl-4 text-[11px] text-muted-foreground tabular-nums">
            <span>in {formatNum(agent.spend.tokensIn)}</span>
            <span>out {formatNum(agent.spend.tokensOut)}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

// The joined, read-only activity region. Labelled "Inspecting [agent]" — never
// "Speaking to". No composer, no model switcher: the operator inspects, the
// coordinator stays the sole composer.
function InspectRegion({
  agent,
  leads,
  onClose,
}: {
  agent: HunterAgent
  leads: Lead[]
  onClose: () => void
}) {
  const posts = leads.filter((l) => l.author === agent.id)

  return (
    <div className="flex max-h-[45%] min-h-0 flex-col border-t bg-muted/40">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="text-xs font-medium">
          Inspecting <span className="font-semibold">{agent.name}</span>
        </span>
        {agent.tier === 2 ? (
          <span className="rounded border border-border px-1 py-px text-[10px] font-medium text-muted-foreground">
            untrusted · read-only
          </span>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          className="ml-auto text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          Close
        </button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 px-3 py-3">
          <section className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-muted-foreground">Current work</span>
            <p className="text-xs leading-relaxed">{agent.task ?? "No task assigned yet."}</p>
          </section>

          <section className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-muted-foreground">Tool output</span>
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground outline-none hover:text-foreground">
                {agent.toolkit.length} {agent.toolkit.length === 1 ? "tool" : "tools"} · {agent.toolkit.join(", ")}
              </summary>
              <pre className="mt-1.5 overflow-x-auto rounded bg-background p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {`$ ${agent.toolkit[0] ?? "tool"} --run\n[${agent.status}] ${agent.task ?? "idle"}\n… folded output; the live coordinator streams the real leaf here.`}
              </pre>
            </details>
          </section>

          <section className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-muted-foreground">Bulletin posts</span>
            {posts.length === 0 ? (
              <p className="text-xs text-muted-foreground">No bulletin posts from this agent.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {posts.map((p) => (
                  <li key={p.id} className="flex items-baseline gap-1.5 text-xs">
                    <span className="text-muted-foreground/60">#</span>
                    <span className="truncate">{p.claim}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                      {p.lane === "evidence" ? "evidence" : "bulletin"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </ScrollArea>
    </div>
  )
}
