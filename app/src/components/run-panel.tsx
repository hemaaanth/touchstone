import { useEffect, useState } from "react"
import { Bot, ChevronDown, ChevronRight, Files, Info, MessagesSquare, Shield, ShieldCheck } from "lucide-react"
import type { AgentNode, ArtifactDoc, BulletinNote, RunMode, Severity } from "@/lib/types"
import type { RunState } from "@/lib/runModel"
import { cn } from "cn"
import { Markdown } from "@/components/markdown"
import { FileTree } from "@/components/assistant-ui/elements/file-tree"
import { PLAN_STEP } from "@/lib/catalog"
import { cardFor, type CardState } from "@/components/thread-model"
import {
  AGENT_WORD,
  agentName,
  dotClass,
  fleetSpend,
  isLiveAgent,
  runBudget,
  runEnd,
  runStart,
  span,
  usd,
} from "@/components/fleet-view"

// The run panel. It floats in the chat's top-right corner on every run, fleet
// or solo, phone or desktop. It is a stack of sections, like the assistant-ui
// MCP server panel: Info, Agents, Bulletin, Findings & Proofs, and Files. Each
// section row shows a count and a short status. One section is open at a time
// and scrolls inside itself. The top row folds the whole panel to one line, so
// it never hides the chat for long. A click on an agent, a finding's proof or a
// file opens it in the run drawer.
// Findings & Proofs holds what the run claims and what its replay showed.
// Files holds what the run wrote to get there: test files, sources, reports.

export type PanelSection = "info" | "agents" | "bulletin" | "findings" | "files"

export function RunPanel({
  state,
  live,
  mode,
  model,
  open,
  onOpenChange,
  section,
  onSection,
  selectedAgent,
  onAgent,
  openDoc,
  openVersion,
  onFile,
}: {
  state: RunState
  live: boolean
  mode: RunMode
  // The model alias the run started with.
  model: string
  open: boolean
  onOpenChange: (open: boolean) => void
  section: PanelSection | null
  onSection: (s: PanelSection | null) => void
  selectedAgent: string | null
  onAgent: (id: string) => void
  openDoc: string | null
  openVersion: string | null
  onFile: (fileId: string, versionId?: string) => void
}) {
  const agents = state.agents
  const notes = state.bulletin
  // Replay proofs belong to their findings, not to the run's working files.
  const docs = state.artifacts.filter((d) => d.kind !== "proof")
  const found = panelFindings(state)
  const linked = new Set(found.map((f) => f.proofId))
  const loose = state.artifacts.filter((d) => d.kind === "proof" && !linked.has(d.id))
  // A solo run has no Bulletin tools, so the section shows only if notes exist.
  const showBulletin = mode === "fleet" || notes.length > 0
  const writing = docs.some((d) => d.versions.some((v) => v.writing))
  // The main chat is the coordinator (or a solo run's one agent), so the
  // Agents section lists only the agents it spawned. A solo run has none.
  const showAgents = mode === "fleet" || agents.length > 0

  const active = agents.filter(isLiveAgent).length
  const failed = agents.filter((a) => a.state === "failed").length
  const agentStatus = failed ? `${failed} failed` : active ? `${active} active` : null
  const held = notes.filter((n) => n.lane === "evidence").length
  const leads = notes.filter((n) => n.lane !== "evidence" && n.kind === "lead").length
  const noteStatus = held ? `${held} quarantined` : leads ? `${leads} ${leads === 1 ? "lead" : "leads"}` : null

  const toggle = (s: PanelSection) => onSection(section === s ? null : s)
  const summary = [
    showAgents ? plural(agents.length, "agent") : "Solo",
    showBulletin ? plural(notes.length, "note") : null,
    plural(found.length, "finding"),
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
            icon={Info}
            label="Info"
            count={null}
            status={usd(fleetSpend(state))}
            expanded={section === "info"}
            onToggle={() => toggle("info")}
          >
            <RunInfo state={state} live={live} mode={mode} model={model} />
          </Section>
          {showAgents ? (
            <Section
              icon={Bot}
              label="Agents"
              count={agents.length}
              status={agentStatus}
              bad={failed > 0}
              expanded={section === "agents"}
              onToggle={() => toggle("agents")}
            >
              <AgentList state={state} live={live} selected={selectedAgent} onAgent={onAgent} />
            </Section>
          ) : null}
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
            icon={ShieldCheck}
            label="Findings & Proofs"
            count={found.length}
            status={null}
            expanded={section === "findings"}
            onToggle={() => toggle("findings")}
          >
            <FindingList
              items={found}
              loose={loose}
              openDoc={openDoc}
              openVersion={openVersion}
              onFile={onFile}
            />
          </Section>
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

// One finding as the panel shows it: what the agent claimed and what the
// replay made of it. `card` is the same state the finding's chat card shows.
interface PanelFinding {
  id: string
  title: string
  severity: Severity
  poc: string | null
  card: CardState
  proofId: string | null
}

// Every finding of the run, in submission order. A submitted finding takes
// its state from cardFor, so the panel and the chat card never disagree. A
// recorded finding with no submission in the stream (an older record) still
// shows: its recorded replay result is its state.
function panelFindings(state: RunState): PanelFinding[] {
  const out: PanelFinding[] = state.submitted.map((sub) => {
    const { card, proofArtifactId } = cardFor(state, sub, state.status)
    return { id: sub.id, title: sub.title, severity: sub.severity, poc: sub.poc || null, card, proofId: proofArtifactId }
  })
  const legacy = state.findings.length > 0 && state.findings.every((f) => !f.poc)
  const pocs = new Set(state.submitted.map((s) => s.poc))
  for (const f of state.findings) {
    if (legacy ? state.submitted.length > 0 : f.poc && pocs.has(f.poc)) continue
    const proof = f.proven ? state.artifacts.find((a) => a.kind === "proof" && a.findingId === f.id) : undefined
    out.push({
      id: f.id,
      title: f.title,
      severity: f.severity,
      poc: f.poc ?? null,
      card: f.proven ? "proven" : "unproven",
      proofId: proof?.id ?? null,
    })
  }
  return out
}

// The word each finding state shows. Same words as the chat's finding card.
const CARD_WORD: Record<CardState, string> = {
  proven: "Proven",
  replaying: "Replaying",
  waiting: "Awaiting replay",
  unproven: "Not reproduced",
  dropped: "Not recorded",
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

// What the run is: its mode, how long it has run, what it has spent against
// its budget, the model, the scope, and the pipeline steps it turned on.
function RunInfo({ state, live, mode, model }: { state: RunState; live: boolean; mode: RunMode; model: string }) {
  const now = useNow(live)
  const t0 = runStart(state)
  const t1 = live ? now : runEnd(state)
  const budget = runBudget(state)
  const steps = (state.modules ?? []).filter((m) => m.on).map((m) => PLAN_STEP[m.id] ?? m.id)
  const rows: [string, React.ReactNode][] = [
    ["Mode", mode === "fleet" ? "Fleet" : "Solo"],
    ["Runtime", t0 != null && t1 != null ? span(t1 - t0) : null],
    ["Spend", <Spend key="spend" usd={fleetSpend(state)} budget={budget} />],
    ["Model", model || null],
    ["Scope", state.scope?.title ?? null],
    [
      "Modules",
      steps.length ? (
        <span key="modules" className="flex flex-col gap-0.5">
          {steps.map((s) => (
            <span key={s}>{s}</span>
          ))}
        </span>
      ) : null,
    ],
  ]
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-3 pt-1 pb-2.5 text-xs">
      {rows
        .filter(([, v]) => v != null)
        .map(([k, v]) => (
          <div key={k} className="col-span-2 grid grid-cols-subgrid">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="min-w-0 [overflow-wrap:anywhere] tabular-nums">{v}</dd>
          </div>
        ))}
    </dl>
  )
}

function Spend({ usd: spent, budget }: { usd: number; budget: number | null }) {
  return (
    <>
      {usd(spent)}
      {budget != null ? <span className="text-muted-foreground"> of {usd(budget)}</span> : null}
    </>
  )
}

// The time now, ticking every second while the run is live.
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [live])
  return now
}

// One row per agent the coordinator spawned. One click opens the agent's
// thread in the drawer.
function AgentList({
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
  return (
    <div className="flex flex-col">
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
      {!agents.length ? (
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

// The run's findings, one row each. A proven row opens its replay proof in the
// drawer. A replay proof that matches no finding row still lists below, so no
// proof is hidden.
function FindingList({
  items,
  loose,
  openDoc,
  openVersion,
  onFile,
}: {
  items: PanelFinding[]
  loose: ArtifactDoc[]
  openDoc: string | null
  openVersion: string | null
  onFile: (fileId: string, versionId?: string) => void
}) {
  if (!items.length && !loose.length) return <p className={empty}>No findings yet.</p>
  return (
    <div className="flex flex-col py-1">
      {items.map((f) => (
        <FindingRow key={f.id} finding={f} active={f.proofId != null && f.proofId === openDoc} onFile={onFile} />
      ))}
      {loose.length ? <FileTree docs={loose} activeId={openDoc} activeVersionId={openVersion} onOpen={onFile} /> : null}
    </div>
  )
}

function FindingRow({
  finding: f,
  active,
  onFile,
}: {
  finding: PanelFinding
  active: boolean
  onFile: (fileId: string, versionId?: string) => void
}) {
  const proven = f.card === "proven"
  const Icon = proven ? ShieldCheck : Shield
  const proofId = f.proofId
  return (
    <button
      type="button"
      disabled={!proofId}
      onClick={proofId ? () => onFile(proofId) : undefined}
      aria-current={active || undefined}
      title={proofId ? "Open the replay proof" : undefined}
      className={cn(
        "flex w-full gap-2.5 px-3 py-[7px] text-left transition-colors outline-none enabled:hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.03]",
        active && "bg-foreground/5 enabled:hover:bg-foreground/5",
      )}
    >
      <Icon className={cn("mt-px size-3.5 shrink-0", proven ? "text-ok" : "text-muted-foreground")} />
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate text-[13px] leading-4 font-semibold">{f.title}</span>
          <span className={cn("ml-auto shrink-0 text-[11px] leading-[14px]", proven ? "text-ok" : "text-muted-foreground")}>
            {CARD_WORD[f.card]}
          </span>
        </span>
        <span className="flex min-w-0 items-baseline gap-2 text-xs leading-4 text-muted-foreground">
          <span className="shrink-0 capitalize">{f.severity}</span>
          {f.poc ? <span className="min-w-0 truncate font-mono text-[11px]">{f.poc}</span> : null}
        </span>
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
