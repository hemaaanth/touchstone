import { useEffect, useMemo, useRef, useState } from "react"
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react"
import { Archive, ArchiveRestore, ChevronLeft, MoreHorizontal, Trash2, Loader2, X } from "lucide-react"
import type { Finding, RunSummary } from "@/lib/types"
import { reloadRun, threadSteps, useRun, type RunState } from "@/lib/runModel"
import { steerRun, fetchFinding } from "@/lib/api"
import { runTitle } from "@/lib/format"
import { cn } from "cn"
import { Button } from "@/components/ui/button"
import { TitleInput } from "@/components/title-input"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ArtifactPane } from "@/components/assistant-ui/elements/artifact-pane"
import { FilesPanel } from "@/components/assistant-ui/elements/files-panel"
import { Thread } from "@/components/run-thread"
import { buildMessages, OpenArtifact } from "@/components/thread-model"
import { BulletinList, Count, FilesList, FleetDock, FleetList, TierTag, type DockTab } from "@/components/fleet-dock"
import {
  AGENT_WORD,
  FleetContext,
  ThreadOwner,
  agentName,
  dotClass,
  fleetSpend,
  isLiveAgent,
  runBudget,
  runEnd,
  runStart,
  span,
  usd,
  type FleetView,
} from "@/components/fleet-view"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"


// The center column. The run is a pi-durable agent session; its live SSE step
// log is reduced into RunState, then mapped onto assistant-ui's message model
// so the Thread, tool-call cards and composer come from one maintained library
// instead of hand-rolled scroll/compose code. We own the state (ExternalStore)
// and the look (base-nova classes + our own part renderers), so adopting the
// library costs no backend protocol change and keeps the restraint rules: our
// renderer reads `step.state`, so green only ever shows for a proven PoC.
//
// Beyond tool steps the thread now surfaces the agent's own cognition — streamed
// reasoning folds into a collapsible "thinking" block, streamed prose fades in as
// it arrives, and a subagent handoff reads as its own row.

export function RunChat({
  run,
  onArchive,
  onRename,
  onDelete,
}: {
  run: RunSummary
  onArchive: (id: string, archived: boolean) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => Promise<void>
}) {
  const state = useRun(run.id)
  const [renaming, setRenaming] = useState(false)
  // A fleet run has child agents. It gets the dock, the peek and the fleet
  // parts. A run with no agents renders exactly as before.
  const fleet = !!state && state.agents.length > 0
  // The workspace documents the agent wrote, and which one the pane shows. The
  // pane is closed until the operator opens a document (a chat card or the
  // Files panel). Each chat keeps its own pane: the open file is saved per run,
  // so a chat comes back as it was left. A chat with nothing saved opens
  // closed. On desktop an open pane follows new writes. On a phone the pane is
  // a full-screen overlay, so it never opens by itself.
  const artifacts = state?.artifacts ?? []
  // The pane opens a file at one version. `latestArtifact` names the most recent
  // write (file + version); a new version of an older file still counts as the
  // latest even though it does not move that file to the end of `artifacts`.
  const latest = state?.latestArtifact ?? null
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(() => (isNarrow() ? null : storedPane(run.id)))
  const [openVersionId, setOpenVersionId] = useState<string | null>(null)
  const [filesOpen, setFilesOpen] = useStoredFlag("ts.filesOpen", false)
  // Open a file at a version. Omit the version to land on the file's latest.
  const openArtifact = (fileId: string, versionId?: string) => {
    setOpenArtifactId(fileId)
    const file = artifacts.find((a) => a.id === fileId) ?? null
    setOpenVersionId(versionId ?? file?.versions[file.versions.length - 1]?.id ?? null)
  }
  useEffect(() => storePane(run.id, openArtifactId), [run.id, openArtifactId])
  // A child agent's write never moves the pane. Only the coordinator's own
  // writes do, and only when the pane is already open.
  const childWrite = useMemo(
    () => !!latest && !!state?.steps.some((s) => s.kind === "artifact" && s.subId === latest.versionId && s.agent),
    [latest, state],
  )
  // The first write we see is history, not news, so it only sets the mark.
  const seenArtifact = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    const key = latest ? `${latest.fileId}:${latest.versionId}` : null
    if (!key || key === seenArtifact.current) return
    const fresh = seenArtifact.current !== undefined
    seenArtifact.current = key
    // An open pane on desktop follows each fresh write, including a new version
    // of the open file, so it steps from v1 to v2 as the agent rewrites.
    if (fresh && openArtifactId && !isNarrow() && latest && !childWrite) {
      setOpenArtifactId(latest.fileId)
      setOpenVersionId(latest.versionId)
    }
  }, [latest, openArtifactId, childWrite])
  const openDoc = openArtifactId ? artifacts.find((a) => a.id === openArtifactId) ?? null : null
  // When the open document is the replay proof, it renders the recorded finding's
  // structured report in the pane. Resolve that finding only while the proof is
  // actually on screen; the id comes from the run-complete stamp, or the finding
  // event that lands a little earlier.
  // A run can record several findings; each proof document names its own.
  const proofFindingId = openDoc?.findingId ?? state?.findingId ?? state?.findings[0]?.id ?? null
  const finding = useFinding(openDoc?.kind === "proof" ? proofFindingId : null)
  // Until the run store has loaded this run, trust the sidebar's status.
  const status = state ? state.status : run.status
  const scope = state?.scope ?? null
  const title = runTitle({ ...run, scopeTitle: run.scopeTitle ?? scope?.title })
  // Live: a worker is running, so a message steers it. Idle: a message starts a
  // follow-up on the saved session. Only an archived run takes no messages.
  const live = !!state && !state.closed
  const archived = !!state?.archived
  const [sendError, setSendError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)

  // Send one operator message. Live, it steers the worker. Idle, the server
  // starts a follow-up, so fetch the run again to follow the reply.
  const send = async (text: string) => {
    if (!text || !state || archived) return
    setSendError(null)
    try {
      const res = await steerRun(run.id, text)
      if (res.followUp) reloadRun(run.id)
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err))
    }
  }

  // Retry a run that failed before proving anything. The saved session is still
  // on disk, so one steer message reopens it and the agent resumes the audit
  // from where the model error cut it off — no new scope, no lost context.
  const onRetry = async () => {
    if (!state || archived || retrying) return
    setRetrying(true)
    await send("Continue the audit from where it stopped.")
    setRetrying(false)
  }

  // The main chat is the coordinator's own thread. On a run with no agents
  // that is every step.
  // A fleet's main chat is the coordinator's thread. Its "session started"
  // marker says nothing there, so it is left out. A run without agents keeps
  // every step, as before.
  const mainSteps = useMemo(
    () => (state ? (fleet ? threadSteps(state.steps, null).filter((s) => s.kind !== "open") : state.steps) : []),
    [state, fleet],
  )
  const messages = useMemo(
    () => buildMessages(state, mainSteps, status, live, fleet, null),
    [state, mainSteps, status, live, fleet],
  )

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    isRunning: live,
    isDisabled: !state || archived,
    convertMessage: (m) => m,
    onNew: async (message) => {
      const text = message.content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("")
        .trim()
      await send(text)
    },
  })

  // The peek: one child's thread over the chat. The stack holds the peeks a
  // pill opened from inside another peek, so "‹ Name" can go back.
  const [peekStack, setPeekStack] = useState<{ id: string; key?: string }[]>([])
  const peek = peekStack[peekStack.length - 1] ?? null
  const prev = peekStack[peekStack.length - 2] ?? null
  const [dockTab, setDockTab] = useState<DockTab>("fleet")
  const [mobileTab, setMobileTab] = useState<"chat" | DockTab>("chat")
  // A pill jump scrolls to the same message in the other thread and marks it
  // for a moment.
  const [highlight, setHighlight] = useState<string | null>(null)
  const [jump, setJump] = useState<{ where: "main" | "peek"; key: string; n: number } | null>(null)
  const mainRef = useRef<HTMLDivElement>(null)
  const peekRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!jump) return
    const root = jump.where === "main" ? mainRef.current : peekRef.current
    // Wait for the thread to render the new messages, then scroll. Try twice:
    // a freshly opened thread scrolls itself to the bottom on mount.
    const go = () =>
      root
        ?.querySelector(`[data-step-key="${CSS.escape(jump.key)}"]`)
        ?.scrollIntoView({ block: "center", behavior: "instant" })
    const a = setTimeout(go, 60)
    const b = setTimeout(go, 260)
    const c = setTimeout(() => setHighlight(null), 1600)
    return () => [a, b, c].forEach(clearTimeout)
  }, [jump])

  const openPeek = (id: string, key?: string, push = false) => {
    setPeekStack((s) => {
      const top = s[s.length - 1]
      if (push && top && top.id !== id) return [...s, { id, key }]
      return [{ id, key }]
    })
    if (key) {
      setJump({ where: "peek", key, n: Date.now() })
      setHighlight(key)
    }
  }
  const closePeek = () => setPeekStack([])
  const jumpMain = (key: string) => {
    setPeekStack([])
    setMobileTab("chat")
    setJump({ where: "main", key, n: Date.now() })
    setHighlight(key)
  }

  const fleetView: FleetView | null =
    fleet && state ? { state, openPeek, jumpMain, highlight, steer: send, canSteer: !archived } : null

  const peekAgent = peek && state ? state.agents.find((a) => a.id === peek.id) ?? null : null
  const peekLive = live && !!peekAgent && isLiveAgent(peekAgent)
  const peekMessages = useMemo(
    () => (peek && state ? buildMessages(state, threadSteps(state.steps, peek.id), status, peekLive, true, peek.id) : []),
    [peek, state, status, peekLive],
  )
  const peekRuntime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: peekMessages,
    isRunning: peekLive,
    isDisabled: true,
    convertMessage: (m) => m,
    onNew: async () => {},
  })

  const actions = (
    <RunActions
      compact={fleet}
      archived={archived}
      busy={live || !state}
      findings={state?.findings.length ?? 0}
      onArchive={() => onArchive(run.id, !archived)}
      onDelete={() => onDelete(run.id)}
    />
  )
  const titleNode = renaming ? (
    <TitleInput
      value={title}
      onSave={(name) => {
        onRename(run.id, name)
        setRenaming(false)
      }}
      onCancel={() => setRenaming(false)}
      className="h-7 w-full max-w-md text-sm font-medium"
    />
  ) : (
    <h1 className="min-w-0 truncate text-sm font-medium">
      <button
        type="button"
        title="Rename run"
        onClick={() => setRenaming(true)}
        className="max-w-full cursor-text truncate rounded-sm text-left outline-none hover:text-foreground/80 focus-visible:ring-1 focus-visible:ring-ring"
      >
        {title}
      </button>
    </h1>
  )

  return (
    <OpenArtifact.Provider value={openArtifact}>
      <FleetContext.Provider value={fleetView}>
        {/* The run splits into the chat and, when the agent writes one, the
            document pane. The chat flexes; the pane is a fixed-width column on
            desktop and a full-width overlay on mobile (so `relative` anchors it).
            A fleet run adds the dock on the right. */}
        <div className="relative flex h-full min-w-0 flex-col">
          {/* A fleet run's top bar spans the chat and the dock. */}
          {fleet && state ? <FleetHeader state={state} live={live} title={titleNode} actions={actions} /> : null}
          <div className="relative flex min-h-0 min-w-0 flex-1">
          <div className="relative flex h-full min-w-0 flex-1 flex-col">
            {/* The run's files float in the chat's top-right corner, under the top
                bar. Folded, the panel is one line; open, it lists every file. A
                fleet run lists them in the dock instead. */}
            {artifacts.length && !fleet ? (
              <div className="pointer-events-none absolute top-14 right-3 z-10 flex max-h-[calc(100%-4rem)] justify-end">
                <FilesPanel
                  docs={artifacts}
                  activeId={openDoc?.id ?? null}
                  activeVersionId={openVersionId}
                  open={filesOpen}
                  onOpenChange={setFilesOpen}
                  onOpen={(fileId, versionId) => {
                    openArtifact(fileId, versionId)
                    // On a phone the document covers the chat, so fold the list.
                    if (isNarrow()) setFilesOpen(false)
                  }}
                />
              </div>
            ) : null}
            {/* The top bar holds the run's title and the actions on the run as a
                whole: archive, and delete behind a menu. Both wait while the agent
                works, because the server refuses to change a busy run. The sidebar
                toggle shows on mobile only, where the sidebar is a Sheet. */}
            {fleet ? null : (
              <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4 pe-2">
                <SidebarTrigger className="-ml-1 md:hidden" />
                {/* The run's own name, the same one the rail shows. Click to rename. */}
                {titleNode}
                {actions}
              </header>
            )}

            {fleet && state ? (
              <MobileTabs
                state={state}
                live={live}
                tab={mobileTab}
                onTab={setMobileTab}
                selected={peek?.id ?? null}
                onAgent={(id) => openPeek(id)}
                openDoc={openDoc?.id ?? null}
                onFile={(id) => openArtifact(id)}
              />
            ) : null}

            <div
              ref={mainRef}
              className={cn("flex min-h-0 flex-1 flex-col", fleet && mobileTab !== "chat" && "max-md:hidden")}
            >
              <AssistantRuntimeProvider runtime={runtime}>
                <Thread
                  live={live}
                  empty={messages.length === 0}
                  prepass={state?.prepass ?? null}
                  error={status === "error" ? state?.error ?? null : null}
                  errorInfo={status === "error" ? state?.errorInfo ?? null : null}
                  onRetry={onRetry}
                  retrying={retrying}
                  archived={archived}
                  sendError={sendError}
                  fleet={fleet}
                />
              </AssistantRuntimeProvider>
            </div>

            {/* The peek covers the chat from the right, up over the top bar, and
                stops at the dock. Nothing under it moves; the chat only dims. On
                a phone it fills the screen. */}
            {fleet && state && peek ? (
              <>
                <div aria-hidden className="absolute inset-x-0 -top-[49px] bottom-0 z-20 bg-black/10 dark:bg-black/35 max-md:hidden" onClick={closePeek} />
                <div
                  ref={peekRef}
                  role="dialog"
                  aria-label={agentName(state, peek.id)}
                  className="absolute -top-[49px] bottom-0 right-0 z-30 flex w-[552px] max-w-full flex-col bg-background shadow-[-10px_0_30px_#00000014] max-md:fixed max-md:inset-0 max-md:z-50 max-md:w-auto"
                >
                  <PeekHeader
                    state={state}
                    id={peek.id}
                    prev={prev?.id ?? null}
                    onBack={() => setPeekStack((s) => s.slice(0, -1))}
                    onClose={closePeek}
                  />
                  <ThreadOwner.Provider value={peek.id}>
                    <AssistantRuntimeProvider runtime={peekRuntime}>
                      <Thread
                        key={peek.id}
                        live={peekLive}
                        empty={peekMessages.length === 0}
                        prepass={null}
                        error={null}
                        errorInfo={null}
                        onRetry={() => {}}
                        retrying={false}
                        archived={archived}
                        sendError={null}
                        fleet
                        readOnly
                      />
                    </AssistantRuntimeProvider>
                  </ThreadOwner.Provider>
                </div>
              </>
            ) : null}
          </div>

          {openDoc ? (
            <ArtifactPane
              doc={openDoc}
              versionId={openVersionId}
              finding={finding}
              onSelectVersion={setOpenVersionId}
              onClose={() => {
                setOpenArtifactId(null)
                setOpenVersionId(null)
              }}
            />
          ) : null}

          {fleet && state ? (
            <FleetDock
              state={state}
              live={live}
              tab={dockTab}
              onTab={setDockTab}
              selected={peek?.id ?? null}
              onAgent={(id) => openPeek(id)}
              openDoc={openDoc?.id ?? null}
              onFile={(id) => openArtifact(id)}
            />
          ) : null}
          </div>
        </div>
      </FleetContext.Provider>
    </OpenArtifact.Provider>
  )
}

// The fleet run's top bar: status dot, title, "Running · 6m", the quiet cost,
// and the ⋯ menu.
function FleetHeader({
  state,
  live,
  title,
  actions,
}: {
  state: RunState
  live: boolean
  title: React.ReactNode
  actions: React.ReactNode
}) {
  const failed = state.status === "error"
  const word = live ? "Running" : failed ? "Failed" : "Done"
  const t0 = runStart(state)
  const t1 = runEnd(state)
  const budget = runBudget(state)
  const spend = fleetSpend(state)
  return (
    <header className="flex h-12 shrink-0 items-center gap-2.5 border-b px-5 pe-2 max-md:px-3">
      <SidebarTrigger className="-ml-1 md:hidden" />
      <span
        className={cn(
          "size-[7px] shrink-0 rounded-full max-md:mt-[13px] max-md:self-start",
          dotClass(live ? "working" : failed ? "failed" : "done"),
        )}
      />
      {/* On a phone the status goes under the title, as in the mobile frame. */}
      <div className="flex min-w-0 items-baseline gap-2.5 max-md:flex-col max-md:items-stretch max-md:gap-0">
        {title}
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {word}
          {t0 != null && t1 != null ? ` · ${span(t1 - t0)}` : ""}
        </span>
      </div>
      <span
        className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums"
        title="What the agents report spending, against the run's budget"
      >
        <span className="text-foreground">{usd(spend)}</span>
        {budget != null ? <span className="max-md:hidden"> / {usd(budget)}</span> : null}
      </span>
      {actions}
    </header>
  )
}

// The peek's top bar. "‹ Name" goes back to the peek this one was opened from.
function PeekHeader({
  state,
  id,
  prev,
  onBack,
  onClose,
}: {
  state: RunState
  id: string
  prev: string | null
  onBack: () => void
  onClose: () => void
}) {
  const a = state.agents.find((n) => n.id === id)
  const from = a?.startedAt ?? runStart(state)
  const to = a?.endedAt ?? runEnd(state)
  return (
    <header className="flex h-12 shrink-0 items-center gap-2.5 border-b px-5 pe-3">
      {prev ? (
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 flex shrink-0 items-center gap-0.5 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          {agentName(state, prev)}
        </button>
      ) : null}
      <span className={cn("size-[7px] shrink-0 rounded-full", dotClass(a?.state ?? "working"))} />
      <span className="min-w-0 truncate text-sm font-medium">{agentName(state, id)}</span>
      {a ? (
        <span className={cn("shrink-0 text-xs tabular-nums", a.state === "failed" ? "text-bad" : "text-muted-foreground")}>
          {AGENT_WORD[a.state]}
          {from != null && to != null ? ` · ${span(to - from)}` : ""}
        </span>
      ) : null}
      <span className="ml-auto flex shrink-0 items-center gap-2.5">
        {a?.tier ? <TierTag tier={a.tier} /> : null}
        {a?.spendUsd != null ? (
          <span className="text-xs text-muted-foreground/60 tabular-nums">{usd(a.spendUsd)}</span>
        ) : null}
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Close" onClick={onClose}>
          <X />
        </Button>
      </span>
    </header>
  )
}

// On a phone the dock becomes tabs under the top bar. The chat stays mounted
// while another tab shows, so its scroll is kept.
function MobileTabs({
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
  tab: "chat" | DockTab
  onTab: (t: "chat" | DockTab) => void
  selected: string | null
  onAgent: (id: string) => void
  openDoc: string | null
  onFile: (id: string) => void
}) {
  const trigger = "h-full flex-none px-0 text-[13px] group-data-horizontal/tabs:after:bottom-[-1px]"
  return (
    <>
      <Tabs value={tab} onValueChange={(v) => onTab(v as "chat" | DockTab)} className="shrink-0 gap-0 md:hidden">
        <div className="flex h-11 items-center border-b px-4">
          <TabsList variant="line" className="gap-5 p-0 group-data-horizontal/tabs:h-full">
            <TabsTrigger value="chat" className={trigger}>
              Chat
            </TabsTrigger>
            <TabsTrigger value="fleet" className={trigger}>
              Fleet
            </TabsTrigger>
            <TabsTrigger value="bulletin" className={trigger}>
              Bulletin
              {state.bulletin.length ? <Count n={state.bulletin.length} /> : null}
            </TabsTrigger>
            <TabsTrigger value="files" className={trigger}>
              Files
            </TabsTrigger>
          </TabsList>
        </div>
      </Tabs>
      {tab !== "chat" ? (
        <ScrollArea className="min-h-0 flex-1 md:hidden">
          {tab === "fleet" ? (
            <FleetList state={state} live={live} selected={selected} onAgent={onAgent} />
          ) : tab === "bulletin" ? (
            <BulletinList state={state} onAgent={onAgent} />
          ) : (
            <FilesList docs={state.artifacts} openDoc={openDoc} onFile={onFile} />
          )}
        </ScrollArea>
      ) : null}
    </>
  )
}

// Which file each chat's pane shows, saved by run id. A run with no entry has
// its pane closed. Closing the pane removes the entry.
const PANE_KEY = "ts.artifactPane"

function readPanes(): Record<string, string> {
  try {
    const saved = JSON.parse(localStorage.getItem(PANE_KEY) ?? "{}")
    return saved && typeof saved === "object" ? saved : {}
  } catch {
    return {}
  }
}

function storedPane(runId: string): string | null {
  const id = readPanes()[runId]
  return typeof id === "string" ? id : null
}

function storePane(runId: string, fileId: string | null) {
  const panes = readPanes()
  if ((panes[runId] ?? null) === fileId) return
  if (fileId) panes[runId] = fileId
  else delete panes[runId]
  localStorage.setItem(PANE_KEY, JSON.stringify(panes))
}

// Read at call time, not from state: the first artifact can land before a
// hook-based mobile flag has settled. Matches Tailwind's `md` breakpoint.
function isNarrow(): boolean {
  return window.matchMedia("(max-width: 767px)").matches
}


// Resolve the finding a proof document renders, fetched once from the API.
// Returns null until it loads, and resets whenever the id changes so a stale
// proof never shows under a new one.
function useFinding(findingId: string | null): Finding | null {
  const [remote, setRemote] = useState<Finding | null>(null)
  useEffect(() => {
    setRemote(null)
    if (!findingId) return
    let live = true
    fetchFinding(findingId)
      .then((f) => live && setRemote(f))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [findingId])
  return remote
}

// A yes/no setting kept in localStorage, so a panel stays as the operator left it.
function useStoredFlag(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => {
    const saved = localStorage.getItem(key)
    return saved == null ? initial : saved === "1"
  })
  const set = (v: boolean) => {
    setValue(v)
    localStorage.setItem(key, v ? "1" : "0")
  }
  return [value, set]
}

// The actions on the whole run, at the end of the top bar. Archive is one tap
// and undoes itself. Delete sits in a menu and asks first. The server moves a
// deleted run's files to a trash folder, so a mistake can still be recovered by
// hand. Both wait while the agent works.
function RunActions({
  compact = false,
  archived,
  busy,
  findings,
  onArchive,
  onDelete,
}: {
  // Fleet runs keep the top bar quiet: Archive moves into the ⋯ menu.
  compact?: boolean
  archived: boolean
  busy: boolean
  findings: number
  onArchive: () => void
  onDelete: () => Promise<void>
}) {
  const [confirm, setConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wait = busy ? "Wait for the agent to finish" : undefined
  return (
    <div className={cn("flex shrink-0 items-center gap-0.5", !compact && "ml-auto")}>
      {compact ? null : (
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground"
        disabled={busy}
        title={wait}
        onClick={onArchive}
      >
        {archived ? <ArchiveRestore /> : <Archive />}
        <span className="hidden sm:inline">{archived ? "Unarchive" : "Archive"}</span>
      </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="More actions" />}
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          {compact ? (
            <DropdownMenuItem disabled={busy} onClick={onArchive}>
              {archived ? <ArchiveRestore /> : <Archive />}
              {archived ? "Unarchive" : "Archive"}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            variant="destructive"
            disabled={busy}
            onClick={() => {
              setError(null)
              setConfirm(true)
            }}
          >
            <Trash2 />
            Delete run
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={confirm} onOpenChange={(o) => !deleting && setConfirm(o)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete this run?</DialogTitle>
            <DialogDescription>
              The run leaves the list with its transcript and files.
              {findings
                ? ` Its ${findings === 1 ? "finding leaves" : `${findings} findings leave`} the ledger too.`
                : ""}{" "}
              The files move to a trash folder, so they can be restored by hand.
            </DialogDescription>
          </DialogHeader>
          {error ? <p className="text-xs text-bad">{error}</p> : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={deleting} />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={() => {
                setDeleting(true)
                onDelete()
                  .catch((err: unknown) => {
                    setError(err instanceof Error ? err.message : String(err))
                    setDeleting(false)
                  })
              }}
            >
              {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
