import { useState } from "react"
import { Bot, ChevronDown, ChevronRight, Files, MessagesSquare } from "lucide-react"
import type { AgentNode, BulletinNote, RunMode } from "@/lib/types"
import type { RunState } from "@/lib/runModel"
import { cn } from "cn"
import { Markdown } from "@/components/markdown"
import { FileTree } from "@/components/assistant-ui/elements/file-tree"
import { AGENT_WORD, agentName, dotClass, isLiveAgent, runStart, span } from "@/components/fleet-view"

// The run panel. It floats in the chat's top-right corner on every run, fleet
// or solo, phone or desktop. It is a stack of sections, like the assistant-ui
// MCP server panel: Agents, Bulletin, and Files. Each section row shows a count
// and a short status. One section is open at a time and scrolls inside itself.
// The top row folds the whole panel to one line, so it never hides the chat
// for long. A click on an agent or a file opens it in the run drawer.

export type PanelSection = "agents" | "bulletin" | "files"

export function RunPanel({
  state,
  live,
  mode,
  open,
  onOpenChange,
  section,
  onSection,
  selectedAgent,
  onAgent,
  onCoordinator,
  openDoc,
  openVersion,
  onFile,
}: {
  state: RunState
  live: boolean
  mode: RunMode
  open: boolean
  onOpenChange: (open: boolean) => void
  section: PanelSection | null
  onSection: (s: PanelSection | null) => void
  selectedAgent: string | null
  onAgent: (id: string) => void
  onCoordinator: () => void
  openDoc: string | null
  openVersion: string | null
  onFile: (fileId: string, versionId?: string) => void
}) {
  const agents = state.agents
  const notes = state.bulletin
  const docs = state.artifacts
  // A solo run has no Bulletin tools, so the section shows only if notes exist.
  const showBulletin = mode === "fleet" || notes.length > 0
  const writing = docs.some((d) => d.versions.some((v) => v.writing))

  const active = agents.filter(isLiveAgent).length
  const failed = agents.filter((a) => a.state === "failed").length
  const agentStatus =
    mode === "solo" && !agents.length ? null : failed ? `${failed} failed` : active ? `${active} active` : null
  const held = notes.filter((n) => n.lane === "evidence").length
  const leads = notes.filter((n) => n.lane !== "evidence" && n.kind === "lead").length
  const noteStatus = held ? `${held} quarantined` : leads ? `${leads} ${leads === 1 ? "lead" : "leads"}` : null

  const toggle = (s: PanelSection) => onSection(section === s ? null : s)
  const summary = [
    mode === "fleet" || agents.length ? plural(agents.length, "agent") : "Solo",
    showBulletin ? plural(notes.length, "note") : null,
    plural(docs.length, "file"),
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <div
      className={cn(
        "pointer-events-auto flex max-h-full flex-col overflow-hidden rounded-xl border border-border/60 bg-popover/95 shadow-lg backdrop-blur-md",
        open ? "w-[320px] max-w-[calc(100vw-1.5rem)]" : "w-auto",
      )}
    >
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        className="flex shrink-0 items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="min-w-0 truncate tabular-nums">{summary}</span>
        {(live && active) || writing ? (
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-current motion-reduce:animate-none" />
        ) : null}
        <ChevronDown className={cn("ml-auto size-3.5 shrink-0 transition-transform", open && "rotate-180")} />
      </button>

      {open ? (
        <>
          <Section
            icon={Bot}
            label={mode === "solo" && !agents.length ? "Agent" : "Agents"}
            count={mode === "solo" && !agents.length ? null : agents.length}
            status={agentStatus}
            bad={failed > 0}
            expanded={section === "agents"}
            onToggle={() => toggle("agents")}
          >
            <AgentList
              state={state}
              live={live}
              mode={mode}
              selected={selectedAgent}
              onAgent={onAgent}
              onCoordinator={onCoordinator}
            />
          </Section>
          {showBulletin ? (
            <Section
              icon={MessagesSquare}
              label="Bulletin"
              count={notes.length}
              status={noteStatus}
              expanded={section === "bulletin"}
              onToggle={() => toggle("bulletin")}
            >
              <BulletinList state={state} onAgent={onAgent} />
            </Section>
          ) : null}
          <Section
            icon={Files}
            label="Files"
            count={docs.length}
            status={writing ? "Writing" : null}
            expanded={section === "files"}
            onToggle={() => toggle("files")}
          >
            <FileTree docs={docs} activeId={openDoc} activeVersionId={openVersion} onOpen={onFile} />
          </Section>
        </>
      ) : null}
    </div>
  )
}

const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`

// One section: a row with a chevron, an icon, a label, a count and a status.
// Open, its body sits under the row and scrolls inside the panel.
function Section({
  icon: Icon,
  label,
  count,
  status,
  bad = false,
  expanded,
  onToggle,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  count: number | null
  status: string | null
  bad?: boolean
  expanded: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className={cn("flex flex-col border-t border-border/60", expanded ? "min-h-0 shrink" : "shrink-0")}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex shrink-0 items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-foreground/[0.03]"
      >
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} />
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">{label}</span>
        {count != null ? <Count n={count} /> : null}
        {status ? (
          <span className={cn("ml-auto shrink-0 text-[11px]", bad ? "text-bad" : "text-muted-foreground")}>{status}</span>
        ) : null}
      </button>
      {expanded ? <div className="min-h-0 overflow-y-auto pb-1">{children}</div> : null}
    </div>
  )
}

function Count({ n }: { n: number }) {
  return (
    <span className="rounded-full bg-foreground/[0.07] px-1.5 py-px text-[11px] leading-[14px] font-medium text-muted-foreground tabular-nums">
      {n}
    </span>
  )
}

const empty = "px-3 py-2.5 text-xs text-muted-foreground"

// The coordinator first, then one row per child agent. One click opens the
// agent's thread in the drawer. The coordinator's thread is the main chat, so
// its row closes the drawer instead. A solo run has only the one agent.
function AgentList({
  state,
  live,
  mode,
  selected,
  onAgent,
  onCoordinator,
}: {
  state: RunState
  live: boolean
  mode: RunMode
  selected: string | null
  onAgent: (id: string) => void
  onCoordinator: () => void
}) {
  const agents = state.agents
  const failed = state.status === "error"
  const own: AgentNode["state"] = live ? "working" : failed ? "failed" : "done"
  return (
    <div className="flex flex-col">
      <Row
        dot={own}
        name={mode === "solo" && !agents.length ? "Agent" : "Coordinator"}
        word={AGENT_WORD[own]}
        sub={mode === "solo" && !agents.length ? "Works the whole scope. The main chat." : "Plans the split. The main chat."}
        selected={false}
        onClick={onCoordinator}
      />
      {agents.map((a) => (
        <Row
          key={a.id}
          dot={a.state}
          name={a.name || a.title}
          word={AGENT_WORD[a.state]}
          sub={a.title && a.name ? a.title : null}
          t2={a.tier === "T2"}
          selected={a.id === selected}
          onClick={() => onAgent(a.id)}
        />
      ))}
      {mode === "fleet" && !agents.length ? (
        <p className={empty}>
          {live ? "No agents yet. The coordinator spawns them after a short survey." : "This run spawned no agents."}
        </p>
      ) : null}
    </div>
  )
}

function Row({
  dot,
  name,
  word,
  sub,
  t2 = false,
  selected,
  onClick,
}: {
  dot: AgentNode["state"]
  name: string
  word: string
  sub: string | null
  t2?: boolean
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected || undefined}
      className={cn(
        "flex w-full gap-2.5 px-3 py-[7px] text-left transition-colors outline-none hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.03]",
        selected && "bg-foreground/5 hover:bg-foreground/5",
      )}
    >
      <span className={cn("mt-1 size-[7px] shrink-0 rounded-full", dotClass(dot))} />
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate text-[13px] leading-4 font-semibold">{name}</span>
          <span className={cn("shrink-0 text-[11px] leading-[14px]", dot === "failed" ? "text-bad" : "text-muted-foreground")}>
            {word}
          </span>
          {t2 ? <TierTag /> : null}
        </span>
        {sub ? <span className="truncate text-xs leading-4 text-muted-foreground">{sub}</span> : null}
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
function BulletinList({ state, onAgent }: { state: RunState; onAgent: (id: string) => void }) {
  const trusted = state.bulletin.filter((n) => n.lane !== "evidence")
  const held = state.bulletin.filter((n) => n.lane === "evidence")
  const t0 = runStart(state)
  if (!state.bulletin.length) return <p className={empty}>No notes yet.</p>
  return (
    <div className="flex flex-col pb-2">
      {trusted.map((n) => (
        <Note key={n.id} note={n} state={state} t0={t0} onAgent={onAgent} />
      ))}
      {held.length ? (
        <div className="mx-3 mt-2 flex flex-col gap-2.5 border-t pt-3">
          <p className="flex items-center gap-2">
            <span className="text-[11px] leading-[14px] font-semibold tracking-[0.06em] text-muted-foreground">
              QUARANTINED
            </span>
            <TierTag />
          </p>
          {held.map((n) => (
            <div key={n.id} className="flex flex-col gap-1 rounded-xl border px-3 py-2.5">
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
    <div className="flex flex-col gap-1 px-3 py-2">
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
