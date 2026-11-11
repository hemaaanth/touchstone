import { useState } from "react"
import { FileCode2, FileText, ShieldCheck } from "lucide-react"
import type { AgentNode, ArtifactDoc, BulletinNote } from "@/lib/types"
import type { RunState } from "@/lib/runModel"
import { cn } from "cn"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Markdown } from "@/components/markdown"
import { AGENT_WORD, agentName, dotClass, isLiveAgent, runStart, span } from "@/components/fleet-view"

// The fleet run's right dock: the agents, the Bulletin, and the run's files.
// The same three lists fill the mobile tabs.

export type DockTab = "fleet" | "bulletin" | "files"

export function FleetDock({
  state,
  live,
  tab,
  onTab,
  selected,
  onAgent,
  openDoc,
  onFile,
}: {
  state: RunState
  live: boolean
  tab: DockTab
  onTab: (t: DockTab) => void
  selected: string | null
  onAgent: (id: string) => void
  openDoc: string | null
  onFile: (id: string) => void
}) {
  return (
    <Tabs
      value={tab}
      onValueChange={(v) => onTab(v as DockTab)}
      className="hidden h-full w-[368px] shrink-0 gap-0 border-l bg-sidebar md:flex"
    >
      <div className="flex h-12 shrink-0 items-center border-b px-5">
        <TabsList variant="line" className="gap-5 p-0 group-data-horizontal/tabs:h-full">
          <DockTrigger value="fleet">Fleet</DockTrigger>
          <DockTrigger value="bulletin">
            Bulletin
            {state.bulletin.length ? <Count n={state.bulletin.length} /> : null}
          </DockTrigger>
          <DockTrigger value="files">Files</DockTrigger>
        </TabsList>
      </div>
      <TabsContent value="fleet" className="min-h-0">
        <ScrollArea className="h-full">
          <FleetList state={state} live={live} selected={selected} onAgent={onAgent} />
        </ScrollArea>
      </TabsContent>
      <TabsContent value="bulletin" className="min-h-0">
        <ScrollArea className="h-full">
          <BulletinList state={state} onAgent={onAgent} />
        </ScrollArea>
      </TabsContent>
      <TabsContent value="files" className="min-h-0">
        <ScrollArea className="h-full">
          <FilesList docs={state.artifacts} openDoc={openDoc} onFile={onFile} />
        </ScrollArea>
      </TabsContent>
    </Tabs>
  )
}

function DockTrigger({ value, children }: { value: DockTab; children: React.ReactNode }) {
  return (
    <TabsTrigger
      value={value}
      className="h-full flex-none px-0 text-[13px] group-data-horizontal/tabs:after:bottom-[-1px]"
    >
      {children}
    </TabsTrigger>
  )
}

export function Count({ n }: { n: number }) {
  return (
    <span className="rounded-full bg-foreground/[0.07] px-1.5 py-px text-[11px] leading-[14px] font-medium text-muted-foreground tabular-nums">
      {n}
    </span>
  )
}

const summary = "px-5 py-3 text-xs text-muted-foreground"

// One row per child agent. No coordinator row, no model, no spend. One click
// opens the agent's peek.
export function FleetList({
  state,
  live,
  selected,
  onAgent,
}: {
  state: RunState
  live: boolean
  selected: string | null
  onAgent: (id: string) => void
}) {
  const agents = state.agents
  const active = agents.filter(isLiveAgent).length
  const failed = agents.filter((a) => a.state === "failed").length
  const rest: string[] = []
  if (!live && active === 0) rest.push("settled")
  else {
    rest.push(`${active} active`)
    if (failed) rest.push(`${failed} failed`)
  }
  return (
    <div className="flex flex-col pb-3">
      <p className={summary}>
        <span className="font-medium text-foreground">
          {agents.length} {agents.length === 1 ? "agent" : "agents"}
        </span>
        {rest.map((r) => ` · ${r}`).join("")}
      </p>
      {agents.map((a) => (
        <AgentRow key={a.id} agent={a} selected={a.id === selected} onClick={() => onAgent(a.id)} />
      ))}
    </div>
  )
}

function AgentRow({ agent, selected, onClick }: { agent: AgentNode; selected: boolean; onClick: () => void }) {
  const failed = agent.state === "failed"
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected || undefined}
      className={cn(
        "flex w-full gap-2.5 px-5 py-[9px] text-left transition-colors outline-none hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.03]",
        selected && "bg-foreground/5 hover:bg-foreground/5",
      )}
    >
      <span className={cn("mt-1 size-[7px] shrink-0 rounded-full", dotClass(agent.state))} />
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate text-[13px] leading-4 font-semibold">{agent.name || agent.title}</span>
          <span className={cn("shrink-0 text-[11px] leading-[14px]", failed ? "text-bad" : "text-muted-foreground")}>
            {AGENT_WORD[agent.state]}
          </span>
          {agent.tier === "T2" ? <TierTag /> : null}
        </span>
        {agent.title && agent.name ? (
          <span className="truncate text-xs leading-4 text-muted-foreground">{agent.title}</span>
        ) : null}
      </span>
    </button>
  )
}

// The agent's trust tier. T2 is untrusted, so its tag is warm.
export function TierTag({ tier = "T2", className }: { tier?: "T1" | "T2"; className?: string }) {
  return (
    <span
      className={cn(
        "shrink-0 font-mono text-[10px] leading-3",
        tier === "T2" ? "text-warn" : "text-muted-foreground",
        className,
      )}
    >
      {tier} · {tier === "T2" ? "untrusted" : "trusted"}
    </span>
  )
}

// The Bulletin: notes the agents posted for each other. A T2 agent's posts go
// in the evidence lane and stay quarantined until an oracle replay proves them.
// There is no replay-a-note path yet, so the button stays off. It never fakes
// a result.
export function BulletinList({ state, onAgent }: { state: RunState; onAgent: (id: string) => void }) {
  const trusted = state.bulletin.filter((n) => n.lane !== "evidence")
  const held = state.bulletin.filter((n) => n.lane === "evidence")
  const leads = trusted.filter((n) => n.kind === "lead").length
  const total = state.bulletin.length
  const rest: string[] = []
  if (leads) rest.push(`${leads} ${leads === 1 ? "lead" : "leads"}`)
  if (held.length) rest.push(`${held.length} quarantined`)
  const t0 = runStart(state)
  if (!total) return <p className={summary}>No notes yet.</p>
  return (
    <div className="flex flex-col pb-4">
      <p className={summary}>
        <span className="font-medium text-foreground">
          {total} {total === 1 ? "note" : "notes"}
        </span>
        {rest.map((r) => ` · ${r}`).join("")}
      </p>
      {trusted.map((n) => (
        <Note key={n.id} note={n} state={state} t0={t0} onAgent={onAgent} />
      ))}
      {held.length ? (
        <div className="mx-5 mt-3 flex flex-col gap-2.5 border-t pt-4">
          <p className="flex items-center gap-2">
            <span className="text-[11px] leading-[14px] font-semibold tracking-[0.06em] text-muted-foreground">
              QUARANTINED
            </span>
            <TierTag />
          </p>
          {held.map((n) => (
            <div key={n.id} className="flex flex-col gap-1 rounded-xl border px-[14px] py-3">
              <NoteHead note={n} state={state} t0={t0} onAgent={onAgent} />
              <NoteBody text={n.text} plain />
              <div className="mt-1 flex items-center gap-3">
                <span className="text-xs text-muted-foreground">Unverified until the oracle replays it.</span>
                <span className="ml-auto shrink-0" title="Replay of Bulletin notes is not available yet.">
                  <button
                    type="button"
                    disabled
                    className="rounded-md border border-foreground/15 bg-background px-2.5 py-1 text-xs disabled:opacity-50"
                  >
                    Replay to verify
                  </button>
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function NoteHead({
  note,
  state,
  t0,
  onAgent,
}: {
  note: BulletinNote
  state: RunState
  t0: number | null
  onAgent: (id: string) => void
}) {
  const coordinator = !state.agents.some((a) => a.id === note.author)
  return (
    <p className="flex items-baseline gap-2">
      {coordinator ? (
        <span className="text-[13px] leading-4 font-semibold">{agentName(state, note.author)}</span>
      ) : (
        <button
          type="button"
          className="rounded-sm text-[13px] leading-4 font-semibold outline-none hover:underline"
          onClick={() => onAgent(note.author)}
        >
          {agentName(state, note.author)}
        </button>
      )}
      {note.t != null && t0 != null ? (
        <span className="text-[11px] leading-[14px] text-muted-foreground tabular-nums">{span(note.t - t0)}</span>
      ) : null}
      {note.kind === "lead" && note.lane !== "evidence" ? (
        <span className="text-[11px] leading-[14px] text-warn">
          Lead{note.severity ? <span className="capitalize"> · {note.severity}</span> : null}
        </span>
      ) : null}
    </p>
  )
}

function Note({
  note,
  state,
  t0,
  onAgent,
}: {
  note: BulletinNote
  state: RunState
  t0: number | null
  onAgent: (id: string) => void
}) {
  return (
    <div className="flex flex-col gap-1 px-5 py-2.5">
      <NoteHead note={note} state={state} t0={t0} onAgent={onAgent} />
      <NoteBody text={note.text} />
      {note.tags.length ? (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {note.tags.map((t) => (
            <span key={t} className="rounded-full border px-2 py-0.5 font-mono text-[11px] leading-[14px] text-muted-foreground">
              {t}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// A note's text. A long note folds to a few lines behind "Show more".
// Quarantined notes come from an untrusted model, so they stay plain text.
function NoteBody({ text, plain }: { text: string; plain?: boolean }) {
  const [open, setOpen] = useState(false)
  const long = text.length > 320
  const folded = long && !open
  return (
    <>
      <div
        className={cn(
          "text-[13px] leading-[19px] [overflow-wrap:anywhere]",
          plain && "whitespace-pre-wrap",
          folded && "max-h-[95px] overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]",
        )}
      >
        {plain ? text : <Markdown text={text} className="text-[13px] leading-[19px]" />}
      </div>
      {long ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="self-start text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </>
  )
}

// The run's files. A click opens one in the document pane. Nothing opens it
// by itself.
export function FilesList({
  docs,
  openDoc,
  onFile,
}: {
  docs: ArtifactDoc[]
  openDoc: string | null
  onFile: (id: string) => void
}) {
  if (!docs.length) return <p className={summary}>No files yet.</p>
  return (
    <div className="flex flex-col pb-3">
      <p className={summary}>
        {docs.length} {docs.length === 1 ? "file" : "files"}
      </p>
      {docs.map((d) => {
        const Icon = d.kind === "proof" ? ShieldCheck : d.kind === "report" ? FileText : FileCode2
        return (
          <button
            key={d.id}
            type="button"
            onClick={() => onFile(d.id)}
            className={cn(
              "flex w-full items-center gap-2.5 px-5 py-2 text-left transition-colors hover:bg-foreground/[0.03]",
              d.id === openDoc && "bg-foreground/5 hover:bg-foreground/5",
            )}
          >
            <Icon className={cn("size-3.5 shrink-0", d.kind === "proof" ? "text-ok" : "text-muted-foreground")} />
            <span className="min-w-0 truncate font-mono text-xs">{d.title}</span>
            {d.versions.length > 1 ? (
              <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">v{d.versions.length}</span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
