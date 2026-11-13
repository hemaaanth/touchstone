import { useEffect, useRef, useState } from "react"
import { Bot, ChevronDown, ChevronRight, Files, Flag, Info, MessagesSquare, ShieldCheck } from "lucide-react"
import type { AgentNode, ArtifactDoc, BulletinNote, PackChoice, RunLead, RunMode, Severity } from "@/lib/types"
import type { RunState } from "@/lib/runModel"
import { cn } from "cn"
import { Markdown } from "@/components/markdown"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { FileTree } from "@/components/assistant-ui/elements/file-tree"
import { PLAN_STEP } from "@/lib/catalog"
import { ModulePills } from "@/components/module-pill"
import { ProviderLogo } from "@/components/provider-logo"
import { TruncatedText } from "@/components/page-parts"
import { cardFor, runModules, type CardState } from "@/components/thread-model"
import { Bump } from "@/components/bump"
import { useAppear } from "@/lib/motion"
import { ResizeHandle } from "@/components/resize-handle"
import { Hint, ProofIcon, ProofMark, SeverityMark } from "@/components/assistant-ui/elements/indicators"
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
// MCP server panel: Info, Agents, Bulletin, Leads, Findings & Proofs, and Files. Each
// section row shows a count and a short status. One section is open at a time
// and scrolls inside itself. The top row folds the whole panel to one line, so
// it never hides the chat for long. A click on an agent, a finding's proof or a
// file opens it in the run drawer.
// Findings & Proofs holds what the run claims and what its replay showed.
// Files holds what the run wrote to get there: test files, sources, reports.
// Leads holds what the agents recorded with record_lead: each lead's file, line
// and reason. A lead is never proven, so it never shows in Findings & Proofs.

export type PanelSection = "info" | "agents" | "bulletin" | "leads" | "findings" | "files"

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
  width,
  onWidth,
  initialWidth,
  compact = false,
  control,
  packs,
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
  // The panel's width, open or folded, and the width a reset goes back to.
  width: number
  onWidth: (w: number) => void
  initialWidth: number
  // On a narrow screen the folded line is the top bar's PanelControl, so the
  // panel shows only when open, fills the width it is given, and has no drag
  // edge. Escape gives focus back to that control.
  compact?: boolean
  control?: React.RefObject<HTMLButtonElement | null>
  // The server's module list, for the pills' titles and order.
  packs?: PackChoice[]
}) {
  const toggleRef = useRef<HTMLButtonElement>(null)
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
  // Recorded leads. A Review run always shows the section, so "0" is visible.
  const recordedLeads = state.leads
  const showLeads = recordedLeads.length > 0 || state.scope?.pack === "review"

  const toggle = (s: PanelSection) => onSection(section === s ? null : s)
  // The folded line. Each count bumps when it goes up.
  const summary = panelSummary(state, mode)
  // Escape folds the panel and gives focus back to its toggle. The drawer
  // also closes on Escape; the panel takes the key first.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape" || !open || e.defaultPrevented) return
    e.preventDefault()
    onOpenChange(false)
    ;(compact ? control?.current : toggleRef.current)?.focus()
  }

  // One width, open or folded, so the corner never jumps when it folds. The
  // run chat owns the width: the top bar keeps the same room for the folded
  // line. The operator can drag the left edge; the width is kept across reloads.
  return (
    <div
      id="run-panel"
      style={compact ? undefined : { width }}
      onKeyDown={onKeyDown}
      className={cn(
        "pointer-events-auto relative flex max-h-full flex-col overflow-hidden rounded-xl border border-border/60 bg-popover/95 backdrop-blur-md",
        open && "shadow-lg",
        compact && "w-full",
      )}
    >
      {compact ? null : <ResizeHandle edge="left" width={width} onWidth={onWidth} initial={initialWidth} label="Resize panel" />}
      <button
        ref={toggleRef}
        hidden={compact}
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        className="flex shrink-0 items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="min-w-0 truncate tabular-nums">
          {summary.map(({ key, n, word }, i) => (
            <span key={key}>
              {i ? " · " : null}
              {n != null ? (
                <>
                  <Bump n={n} /> {word}
                </>
              ) : (
                word
              )}
            </span>
          ))}
        </span>
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
            <RunInfo state={state} live={live} mode={mode} model={model} packs={packs} />
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
          {showLeads ? (
            <Section
              icon={Flag}
              label="Leads"
              count={recordedLeads.length}
              status={recordedLeads.length ? "Not proven" : null}
              expanded={section === "leads"}
              onToggle={() => toggle("leads")}
            >
              <LeadList leads={recordedLeads} state={state} onAgent={onAgent} />
            </Section>
          ) : null}
          <Section
            icon={ShieldCheck}
            label="Findings & Proofs"
            count={found.length ? null : 0}
            pills={statePills(found)}
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

// One header pill per finding state the run has, in ladder order: the state's
// icon and its count, with the word in the tooltip. A state with no findings
// shows no pill. Only "proven" takes the green accent.
const PILL_ORDER: CardState[] = ["proven", "replaying", "waiting", "unproven", "dropped"]

function statePills(items: PanelFinding[]): Pill[] {
  return PILL_ORDER.map((card) => ({ card, n: items.filter((f) => f.card === card).length }))
    .filter((p) => p.n > 0)
    .map(({ card, n }) => ({ key: card, n, state: card, title: `${n} ${CARD_WORD[card].toLowerCase()}`, ok: card === "proven" }))
}

// The folded line's counts: agents (or Solo), notes, leads, findings, files.
function panelSummary(state: RunState, mode: RunMode) {
  const notes = state.bulletin
  const showAgents = mode === "fleet" || state.agents.length > 0
  const showBulletin = mode === "fleet" || notes.length > 0
  const showLeads = state.leads.length > 0 || state.scope?.pack === "review"
  return [
    showAgents ? counted(state.agents.length, "agent") : { key: "solo", n: null, word: "Solo" },
    showBulletin ? counted(notes.length, "note") : null,
    showLeads ? counted(state.leads.length, "lead") : null,
    counted(panelFindings(state).length, "finding"),
    counted(state.artifacts.filter((d) => d.kind !== "proof").length, "file"),
  ].filter((p) => p != null)
}

// The folded panel on a narrow screen: one small button in the top bar, so
// the run title keeps the bar. It shows the finding count; its name reads the
// whole folded line. Its width is fixed, so a count or a live run ending never
// moves the title.
export function PanelControl({
  state,
  mode,
  open,
  onOpenChange,
  ref,
}: {
  state: RunState
  mode: RunMode
  open: boolean
  onOpenChange: (open: boolean) => void
  ref: React.RefObject<HTMLButtonElement | null>
}) {
  const summary = panelSummary(state, mode)
  const findings = panelFindings(state).length
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onOpenChange(!open)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.preventDefault()
          onOpenChange(false)
        }
      }}
      aria-expanded={open}
      aria-controls="run-panel"
      aria-label={`Run panel: ${summary.map((p) => (p.n != null ? `${p.n} ${p.word}` : p.word)).join(", ")}`}
      className="flex h-8 w-14 shrink-0 items-center justify-center gap-1 rounded-lg border border-border/60 bg-popover/95 text-xs text-muted-foreground tabular-nums outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
    >
      <ShieldCheck className="size-3.5 shrink-0" />
      <Bump n={findings} />
      <ChevronDown className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")} />
    </button>
  )
}

// One count of the folded line, like "3 files". Its number bumps on its own.
const counted = (n: number, word: string): { key: string; n: number | null; word: string } => ({
  key: word,
  n,
  word: n === 1 ? word : `${word}s`,
})

interface Pill {
  key: string
  n: number
  state: CardState
  title: string
  ok: boolean
}

// One section: a row with a chevron, an icon, a label, a count and a status.
// A section can show several labelled count pills instead of one count.
// Open, its body sits under the row and scrolls inside the panel.
function Section({
  icon: Icon,
  label,
  count,
  pills,
  status,
  bad = false,
  expanded,
  onToggle,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  count: number | null
  pills?: Pill[]
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
        <span className="shrink-0 font-medium">{label}</span>
        {count != null ? <Count n={count} /> : null}
        {pills?.length ? (
          <span className="ml-auto flex min-w-0 flex-wrap justify-end gap-1">
            {pills.map((p) => (
              <Hint
                key={p.key}
                label={p.title}
                className={cn(
                  "gap-1 rounded-full py-px pr-1.5 pl-1 text-[11px] leading-[14px] font-medium whitespace-nowrap tabular-nums",
                  p.ok ? "bg-ok/10 text-ok" : "bg-foreground/[0.07] text-muted-foreground",
                )}
              >
                <ProofIcon state={p.state} className="size-3 text-current" />
                <Bump n={p.n} />
              </Hint>
            ))}
          </span>
        ) : null}
        {status ? (
          <span className={cn("ml-auto shrink-0 text-[11px]", bad ? "text-bad" : "text-muted-foreground")}>{status}</span>
        ) : null}
      </button>
      {expanded ? <SectionBody>{children}</SectionBody> : null}
    </div>
  )
}

// An open section's body. It mounts when the section opens, so the rows already
// there do not animate. Rows added after that ease in.
function SectionBody({ children }: { children: React.ReactNode }) {
  const body = useRef<HTMLDivElement>(null)
  useAppear(body)
  return (
    <div ref={body} className="min-h-0 overflow-y-auto pb-1">
      {children}
    </div>
  )
}

function Count({ n }: { n: number }) {
  return (
    <span className="rounded-full bg-foreground/[0.07] px-1.5 py-px text-[11px] leading-[14px] font-medium text-muted-foreground tabular-nums">
      <Bump n={n} />
    </span>
  )
}

const empty = "px-3 py-2.5 text-xs text-muted-foreground"

// What the run is: its mode, how long it has run, what it has spent against
// its budget, the model, the scope, and the pipeline steps it turned on.
function RunInfo({
  state,
  live,
  mode,
  model,
  packs,
}: {
  state: RunState
  live: boolean
  mode: RunMode
  model: string
  packs?: PackChoice[]
}) {
  const now = useNow(live)
  const t0 = runStart(state)
  const t1 = live ? now : runEnd(state)
  const budget = runBudget(state)
  const modules = runModules(state)
  const steps = (state.modules ?? []).filter((m) => m.on).map((m) => PLAN_STEP[m.id] ?? m.id)
  const rows: [string, React.ReactNode][] = [
    ["Mode", mode === "fleet" ? "Fleet" : "Solo"],
    ["Runtime", t0 != null && t1 != null ? span(t1 - t0) : null],
    ["Spend", <Spend key="spend" usd={fleetSpend(state)} budget={budget} />],
    [
      "Model",
      state.provider || model ? (
        <ModelLine key="model" provider={state.provider?.id ?? null} id={state.provider?.model ?? model} agents={mode === "fleet" ? state.agents.length : null} />
      ) : null,
    ],
    [
      "Scope",
      state.scope?.title || state.brief ? (
        <span key="scope" className="flex flex-col gap-0.5">
          {state.scope?.title ? <span>{state.scope.title}</span> : null}
          {state.brief ? <ScopeBrief text={state.brief} /> : null}
        </span>
      ) : null,
    ],
    [modules.length === 1 ? "Module" : "Modules", modules.length ? <ModulePills key="modules" ids={modules} packs={packs} compact /> : null],
    ["Steps", steps.length ? steps.join(" · ") : null],
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

// The scope brief the agent got: one quiet line, the text one click away.
function ScopeBrief({ text }: { text: string }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group -mx-1 flex items-center gap-1 rounded-sm px-1 text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
        <ChevronRight className="size-3 shrink-0 transition-transform group-data-[panel-open]:rotate-90" />
        Scope brief applied
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="mt-1 max-h-48 overflow-y-auto rounded-md bg-muted/50 px-2 py-1.5 leading-relaxed whitespace-pre-wrap text-muted-foreground">{text}</p>
      </CollapsibleContent>
    </Collapsible>
  )
}

// The model as one line: the provider's mark, then the model id, cut in the
// middle with the whole id in a tooltip. A fleet's children run on the
// coordinator's model, so the line says who uses it.
function ModelLine({ provider, id, agents }: { provider: string | null; id: string; agents: number | null }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-1.5">
        {provider ? (
          <>
            <ProviderLogo id={provider} label={provider} className="size-4 rounded-[4px] [&>span]:size-2.5" />
            <span className="sr-only">{provider}: </span>
          </>
        ) : null}
        <TruncatedText text={id} middle tail={12} mono />
      </span>
      {agents != null ? (
        <span className="text-muted-foreground">
          {agents ? `Coordinator and ${agents === 1 ? "its agent" : `all ${agents} agents`}` : "Coordinator"}
        </span>
      ) : null}
    </span>
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
      <ProofMark state={f.card} tip={CARD_WORD[f.card]} className="mt-px" />
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-[13px] leading-4 font-semibold">{f.title}</span>
          <SeverityMark severity={f.severity} proven={proven} className="ml-auto" />
        </span>
        {f.poc ? (
          <span className="min-w-0 truncate font-mono text-[11px] leading-4 text-muted-foreground">{f.poc}</span>
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

// The leads the agents recorded, worst first. Each shows its severity, where it
// is (file:line), what an attacker does, why the agent thinks it holds, and what
// would prove it. Every lead reads "not proven": nothing in this run proves it.
function LeadList({ leads, state, onAgent }: { leads: RunLead[]; state: RunState; onAgent: (id: string) => void }) {
  if (!leads.length) return <p className={empty}>No leads recorded yet.</p>
  return (
    <div className="flex flex-col pb-2">
      {leads.map((l) => {
        const child = state.agents.some((a) => a.id === l.author)
        return (
          <div key={l.id} className="flex flex-col gap-1 px-3 py-2">
            <p className="flex items-center gap-2 text-[11px] leading-[14px]">
              <SeverityMark severity={l.severity} />
              <span className="text-muted-foreground">Lead · not proven</span>
              {child ? (
                <button
                  type="button"
                  className="ml-auto rounded-sm text-muted-foreground outline-none hover:text-foreground hover:underline"
                  onClick={() => onAgent(l.author)}
                >
                  {agentName(state, l.author)}
                </button>
              ) : null}
            </p>
            <p className="text-[13px] leading-4 font-semibold">{l.title || "Untitled lead"}</p>
            <p className="min-w-0 truncate font-mono text-[11px] leading-[14px] text-muted-foreground" title={`${l.file}:${l.line}`}>
              {l.file}:{l.line}
            </p>
            {l.reason ? <p className="text-xs whitespace-pre-wrap text-muted-foreground">{l.reason}</p> : null}
            {l.proof ? <p className="text-xs whitespace-pre-wrap text-muted-foreground">Would prove it: {l.proof}</p> : null}
          </div>
        )
      })}
    </div>
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
        <span className="flex items-center gap-1.5 self-center text-[11px] leading-[14px] text-muted-foreground">
          Lead
          {note.severity ? <SeverityMark severity={note.severity} /> : null}
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
