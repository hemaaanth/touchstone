import { useEffect, useMemo, useRef, useState } from "react"
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ExternalThreadQueueAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react"
import { Archive, ArchiveRestore, ChevronLeft, MoreHorizontal, Trash2, Loader2, X } from "lucide-react"
import type { Finding, RunSummary } from "@/lib/types"
import { reloadRun, threadSteps, useRun, type RunState } from "@/lib/runModel"
import { startProgress } from "@/lib/startup"
import { steerRun, stopRun, fetchFinding } from "@/lib/api"
import { awaitingReply, messageId, settleSent, type Sent } from "@/lib/sent"
import { isTerminal, runTitle } from "@/lib/format"
import { cn } from "cn"
import { Button } from "@/components/ui/button"
import { TitleInput } from "@/components/title-input"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { ResizeHandle, useStoredWidth } from "@/components/resize-handle"
import { ArtifactPane } from "@/components/assistant-ui/elements/artifact-pane"
import { Thread } from "@/components/run-thread"
import { buildMessages, OpenArtifact, waitingMessage } from "@/components/thread-model"
import { RunPanel, TierTag, type PanelSection } from "@/components/run-panel"
import {
  AGENT_WORD,
  FleetContext,
  ThreadOwner,
  agentName,
  dotClass,
  isLiveAgent,
  runEnd,
  runMode,
  runStart,
  span,
  usd,
  type FleetView, mainContext
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
// Every run, fleet or solo, has one layout:
// - the top bar: title, status, mode, spend and the ⋯ menu;
// - the main chat: the coordinator's thread (a solo run's one agent);
// - the run panel: Agents, Bulletin and Files, floating in the chat's corner;
// - the drawer: a child agent's thread or a file, over the chat from the right.
// The drawer never pushes the chat. It is a stack, so "‹ Name" goes back to
// the page it was opened from.

// One page in the drawer. A file's version is null until the operator picks
// one, which means "the latest".
type DrawerItem = { kind: "agent"; id: string; key?: string } | { kind: "file"; id: string; version: string | null }

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
  // The operator chose fleet or solo at start. A fleet's main chat is the
  // coordinator's thread, with the fleet's message cards and spawn rows.
  const mode = state ? runMode(state) : null
  const fleet = mode === "fleet"
  const artifacts = state?.artifacts ?? []
  // `latestArtifact` names the most recent write (file + version). A new
  // version of an older file still counts as the latest.
  const latest = state?.latestArtifact ?? null

  // The drawer. Each chat saves its open file by run id, so a chat comes back
  // as it was left. On a phone the drawer covers the screen, so it never opens
  // by itself.
  const [drawer, setDrawer] = useState<DrawerItem[]>(() => {
    const id = isNarrow() ? null : storedPane(run.id)
    return id ? [{ kind: "file", id, version: null }] : []
  })
  const top = drawer[drawer.length - 1] ?? null
  const below = drawer[drawer.length - 2] ?? null
  const topFile = top?.kind === "file" ? top : null
  useEffect(() => storePane(run.id, topFile?.id ?? null), [run.id, topFile?.id])
  const [drawerWidth, setDrawerWidth, drawerDefault] = useStoredWidth("ts.drawerWidth", 552, 360, 1100)

  // Open a page. From the main chat or the panel it replaces the stack. From
  // inside the drawer it goes on top, so "‹ Name" can come back.
  // The control that opened the drawer. It is saved before the drawer opens,
  // since the inert chat behind the drawer can take its focus away.
  const openerRef = useRef<HTMLElement | null>(null)
  const open = (item: DrawerItem, push: boolean) => {
    if (drawer.length === 0)
      openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setDrawer((s) => {
      const t = s[s.length - 1]
      if (t && t.kind === item.kind && t.id === item.id) return [...s.slice(0, -1), item]
      return push && t ? [...s, item] : [item]
    })
  }
  const openFile = (push: boolean) => (fileId: string, versionId?: string) =>
    open({ kind: "file", id: fileId, version: versionId ?? null }, push)
  const closeDrawer = () => setDrawer([])

  // A child agent's write never moves the drawer. Only the coordinator's own
  // writes do, and only when a file is the drawer's one page, on desktop.
  const childWrite = useMemo(
    () => !!latest && !!state?.steps.some((s) => s.kind === "artifact" && s.subId === latest.versionId && s.agent),
    [latest, state],
  )
  const followFile = drawer.length === 1 && !!topFile
  // The first write we see is history, not news, so it only sets the mark.
  const seenArtifact = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    const key = latest ? `${latest.fileId}:${latest.versionId}` : null
    if (!key || key === seenArtifact.current) return
    const fresh = seenArtifact.current !== undefined
    seenArtifact.current = key
    // It steps from v1 to v2 as the agent rewrites the open file.
    if (fresh && followFile && !isNarrow() && latest && !childWrite) {
      setDrawer([{ kind: "file", id: latest.fileId, version: latest.versionId }])
    }
  }, [latest, followFile, childWrite])

  const openDoc = topFile ? artifacts.find((a) => a.id === topFile.id) ?? null : null
  // When the open document is the replay proof, it renders the recorded
  // finding's structured report. A run can record several findings; each
  // proof document names its own.
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
  //
  // The message shows at once, as a local copy (`sent`). The real message is
  // the agent's `operator-message` echo, which comes when the agent reads it.
  // The echo carries the copy's id, so the copy steps aside the moment it
  // lands, in the same place. The server stays the only record: the copy is
  // never saved, and a reload shows only what the agent really got.
  // If the message does not reach the agent, the copy goes, the error shows,
  // and the text goes back in the composer, unless the operator already
  // started a new one.
  const runtimeRef = useRef<ReturnType<typeof useExternalStoreRuntime> | null>(null)
  const [sent, setSent] = useState<Sent[]>([])
  // What happened to each copy so far: echoed, or an error. A settled copy
  // stays in `sent` until the next send prunes it, so this is pure.
  const events = state?.events
  const outcomes = useMemo(() => settleSent(sent, events ?? []), [sent, events])
  // What the run did before the agent session opened. Read while the thread is empty.
  const startup = useMemo(() => (events ? startProgress(events) : null), [events])
  const settled = useRef(outcomes)
  useEffect(() => {
    settled.current = outcomes
  })
  const giveBack = (text: string) => {
    const composer = runtimeRef.current?.thread.composer
    if (composer && !composer.getState().text) composer.setText(text)
  }
  const send = async (text: string, restore = true) => {
    if (!text || !state || archived) return
    setSendError(null)
    const id = messageId()
    const base = state.events.length
    setSent((xs) => [...xs.filter((x) => !settled.current.has(x.id)), { id, text, base, mode: "sending", restore }])
    try {
      const res = await steerRun(run.id, text, id)
      setSent((xs) => xs.map((x) => (x.id === id ? { ...x, mode: res.followUp ? "follow-up" : "steer" } : x)))
      if (res.followUp) reloadRun(run.id)
    } catch (err) {
      setSent((xs) => xs.filter((x) => x.id !== id))
      setSendError(err instanceof Error ? err.message : String(err))
      if (restore) giveBack(text)
    }
  }

  // A copy the agent never read: its text goes back in the composer once.
  const restored = useRef(new Set<string>())
  useEffect(() => {
    for (const x of sent) {
      const out = outcomes.get(x.id)
      if (!out || out === "echoed" || restored.current.has(x.id)) continue
      restored.current.add(x.id)
      if (x.restore) giveBack(x.text)
    }
  })
  // The error under the composer: a refused send, or the last lost copy.
  const lostError = sent.reduce<string | null>((e, x) => {
    const out = outcomes.get(x.id)
    return out && out !== "echoed" ? out : e
  }, null)
  const composerError = sendError ?? lostError

  // Retry a run that failed before proving anything. The saved session is still
  // on disk, so one steer message reopens it and the agent resumes the audit
  // from where the model error cut it off — no new scope, no lost context.
  const onRetry = async () => {
    if (!state || archived || retrying) return
    setRetrying(true)
    await send("Continue the audit from where it stopped.", false)
    setRetrying(false)
  }

  // A fleet's main chat is the coordinator's thread. Its "session started"
  // marker says nothing there, so it is left out. A solo run keeps every step.
  const mainSteps = useMemo(
    () => (state ? (fleet ? threadSteps(state.steps, null).filter((s) => s.kind !== "open") : state.steps) : []),
    [state, fleet],
  )
  const messages = useMemo(() => {
    const ms = buildMessages(state, mainSteps, status, live, fleet, null)
    // The local copies trail the thread until their echoes land. While the
    // agent owes an answer, a waiting row stands where the answer will go.
    const copies = sent.filter((x) => !outcomes.has(x.id))
    const wait = state ? awaitingReply(mainSteps, live, null, copies) : null
    if (state && wait?.after === "steps") ms.push(waitingMessage(state, wait.id, fleet, null))
    for (const x of copies) {
      ms.push({
        role: "user",
        id: `sent:${x.id}`,
        content: [{ type: "text", text: x.text }],
        metadata: { custom: { queued: x.mode === "steer" } },
      })
    }
    if (state && wait?.after === "copies") ms.push(waitingMessage(state, wait.id, fleet, null))
    return ms
  }, [state, mainSteps, status, live, fleet, sent, outcomes])

  // assistant-ui blocks Send while a run is live unless the runtime has a
  // queue. The server is the queue here: a message to a live run steers it, and
  // a message to an idle run starts a follow-up. So this queue holds nothing and
  // hands each message straight to `send`.
  const sendRef = useRef(send)
  useEffect(() => {
    sendRef.current = send
  })
  const queue = useMemo<ExternalThreadQueueAdapter>(() => {
    const take = (message: AppendMessage) => void sendRef.current(messageText(message))
    return { items: [], steerItems: [], enqueue: take, steer: take, move: () => {}, edit: () => {}, remove: () => {} }
  }, [])

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    isRunning: live,
    isDisabled: !state || archived,
    convertMessage: (m) => m,
    queue,
    onNew: async (message) => {
      await send(messageText(message))
    },
    // The composer's stop button. The server ends the work; the run's stream
    // then reports it stopped and closed.
    onCancel: async () => {
      setSendError(null)
      try {
        await stopRun(run.id)
      } catch (err) {
        setSendError(err instanceof Error ? err.message : String(err))
      }
    },
  })

  useEffect(() => {
    runtimeRef.current = runtime
  })

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

  // Open a child agent's thread. A pill inside the drawer pushes.
  const openPeek = (id: string, key?: string, push = false) => {
    open({ kind: "agent", id, key }, push)
    if (key) {
      setJump({ where: "peek", key, n: Date.now() })
      setHighlight(key)
    }
  }
  // Escape closes the drawer, unless a menu or dialog inside it takes the key.
  // Focus moves into the drawer when it opens and back to the opener when it
  // closes. The dimmed chat behind it is inert, so Tab stays out of it.
  const drawerOpen = drawer.length > 0
  // The drawer renders once the run state loads, which can be after it opens.
  const drawerShown = drawerOpen && !!state
  useEffect(() => {
    if (!drawerShown) return
    const opener = openerRef.current
    const drawerEl = peekRef.current
    if (drawerEl && !drawerEl.contains(document.activeElement)) drawerEl.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setDrawer([])
    }
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("keydown", onKey)
      const active = document.activeElement
      const lost = !active || active === document.body || drawerEl?.contains(active)
      if (lost && opener?.isConnected) opener.focus({ preventScroll: true })
      openerRef.current = null
    }
  }, [drawerShown])
  const jumpMain = (key: string) => {
    setDrawer([])
    setJump({ where: "main", key, n: Date.now() })
    setHighlight(key)
  }

  const fleetView: FleetView | null = state
    ? { state, openPeek, jumpMain, highlight, steer: send, canSteer: !archived }
    : null

  const peek = top?.kind === "agent" ? top : null
  const peekAgent = peek && state ? state.agents.find((a) => a.id === peek.id) ?? null : null
  const peekLive = live && !!peekAgent && isLiveAgent(peekAgent)
  const peekMessages = useMemo(() => {
    if (!peek || !state) return []
    const steps = threadSteps(state.steps, peek.id)
    const ms = buildMessages(state, steps, status, peekLive, true, peek.id)
    const wait = awaitingReply(steps, peekLive, peek.id)
    if (wait) ms.push(waitingMessage(state, wait.id, true, peek.id))
    return ms
  }, [peek, state, status, peekLive])
  const peekRuntime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: peekMessages,
    isRunning: peekLive,
    isDisabled: true,
    convertMessage: (m) => m,
    onNew: async () => {},
  })

  // The run panel. It stays as the operator left it, on desktop and phone
  // apart. On a phone it starts folded, and folds again after a pick, since
  // the drawer covers the screen.
  const [panelOpen, setPanelOpen] = useStoredFlag(isNarrow() ? "ts.panelOpen.phone" : "ts.panelOpen", !isNarrow())
  const [section, setSection] = useStoredSection()
  const picked = () => {
    if (isNarrow()) setPanelOpen(false)
  }
  // While the drawer is open the panel moves to its left, so the operator can
  // switch agents and files without closing it. When the view is too narrow
  // for both, the drawer covers the panel.
  const rootRef = useRef<HTMLDivElement>(null)
  const viewWidth = useWidth(rootRef)
  const beside = drawerOpen && viewWidth - drawerWidth >= 340

  const back = below ? (
    <BackButton
      label={
        below.kind === "agent" && state
          ? agentName(state, below.id)
          : artifacts.find((a) => a.id === below.id)?.title ?? "Back"
      }
      onClick={() => setDrawer((s) => s.slice(0, -1))}
    />
  ) : null

  // Renaming swaps the title's text for an input of the same size, in the
  // same h1, so nothing in the bar moves.
  const titleNode = renaming ? (
    <h1 className="min-w-0 text-sm font-medium">
      <TitleInput
        value={title}
        onSave={(name) => {
          onRename(run.id, name)
          setRenaming(false)
        }}
        onCancel={() => setRenaming(false)}
      />
    </h1>
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
    <OpenArtifact.Provider value={openFile(false)}>
      <FleetContext.Provider value={fleetView}>
        <div ref={rootRef} className="relative flex h-full min-w-0 flex-col overflow-hidden">
          <div inert={drawerOpen} className="shrink-0">
            <RunHeader
              state={state}
              status={status}
              live={live}
              title={titleNode}
              actions={
                <RunActions
                  archived={archived}
                  busy={live || !state}
                  findings={state?.findings.length ?? 0}
                  onArchive={() => onArchive(run.id, !archived)}
                  onDelete={() => onDelete(run.id)}
                />
              }
            />
          </div>

          <div className="relative flex min-h-0 flex-1 flex-col">
            <div ref={mainRef} inert={drawerOpen} className="flex min-h-0 flex-1 flex-col">
              <AssistantRuntimeProvider runtime={runtime}>
                <Thread
                  empty={messages.length === 0}
                  prepass={state?.prepass ?? null}
                  startup={startup}
                  live={live}
                  error={status === "error" ? state?.error ?? null : null}
                  errorInfo={status === "error" ? state?.errorInfo ?? null : null}
                  onRetry={onRetry}
                  retrying={retrying}
                  archived={archived}
                  sendError={composerError}
                  context={state ? mainContext(state) : null}
                  to={fleet ? "the coordinator" : "the agent"}
                />
              </AssistantRuntimeProvider>
            </div>

            {/* The panel floats over the chat's top-right corner and stops
                above the composer. Only the panel itself takes clicks. */}
            {state && mode ? (
              <div
                inert={drawerOpen && !beside}
                className={cn(
                  "pointer-events-none absolute top-3 right-3 bottom-28 flex items-start justify-end",
                  beside ? "z-30" : "z-10",
                )}
                style={beside ? { right: drawerWidth + 12 } : undefined}
              >
                <RunPanel
                  state={state}
                  live={live}
                  mode={mode}
                  model={run.alias}
                  open={panelOpen}
                  onOpenChange={setPanelOpen}
                  section={section}
                  onSection={setSection}
                  selectedAgent={peek?.id ?? null}
                  onAgent={(id) => {
                    openPeek(id)
                    picked()
                  }}
                  openDoc={openDoc?.id ?? null}
                  openVersion={topFile?.version ?? null}
                  onFile={(id, v) => {
                    openFile(false)(id, v)
                    picked()
                  }}
                />
              </div>
            ) : null}
          </div>

          {/* The drawer covers the run from the right, over the top bar.
              Nothing under it moves; the chat dims and blurs a little, and a
              click on it closes the drawer. The drawer is a sheet: an edge
              line, a shadow cast to the left, and in dark mode a surface one
              step lighter than the chat. On a phone it fills the screen. */}
          {state && top ? (
            <>
              <div
                aria-hidden
                className="absolute inset-0 z-20 bg-black/10 max-md:hidden supports-backdrop-filter:backdrop-blur-xs dark:bg-black/45"
                onClick={closeDrawer}
              />
              <div
                ref={peekRef}
                role="dialog"
                tabIndex={-1}
                aria-label={top.kind === "agent" ? agentName(state, top.id) : openDoc?.title ?? "File"}
                style={{ width: drawerWidth }}
                className="absolute inset-y-0 right-0 z-40 flex max-w-full flex-col border-l bg-background shadow-[-16px_0_48px_-12px_rgb(0_0_0/0.18)] max-md:fixed max-md:inset-0 max-md:z-50 max-md:!w-auto max-md:border-l-0 dark:shadow-[-16px_0_48px_-8px_rgb(0_0_0/0.65)] dark:[--background:oklch(0.185_0_0)]"
              >
                <ResizeHandle
                  edge="left"
                  width={drawerWidth}
                  onWidth={setDrawerWidth}
                  initial={drawerDefault}
                  label="Resize drawer"
                />
                {top.kind === "agent" ? (
                  <>
                    <PeekHeader state={state} id={top.id} back={back} onClose={closeDrawer} />
                    {/* A file opened from a child's thread goes on top of it. */}
                    <OpenArtifact.Provider value={openFile(true)}>
                      <ThreadOwner.Provider value={top.id}>
                        <AssistantRuntimeProvider runtime={peekRuntime}>
                          <Thread
                            key={top.id}
                            empty={peekMessages.length === 0}
                            prepass={null}
                            error={null}
                            errorInfo={null}
                            onRetry={() => {}}
                            retrying={false}
                            archived={archived}
                            sendError={null}
                            readOnly
                          />
                        </AssistantRuntimeProvider>
                      </ThreadOwner.Provider>
                    </OpenArtifact.Provider>
                  </>
                ) : openDoc ? (
                  <ArtifactPane
                    doc={openDoc}
                    versionId={top.version}
                    finding={finding}
                    back={back}
                    onSelectVersion={(v) => open({ kind: "file", id: openDoc.id, version: v }, true)}
                    onClose={closeDrawer}
                  />
                ) : (
                  <MissingFile back={back} onClose={closeDrawer} />
                )}
              </div>
            </>
          ) : null}
        </div>
      </FleetContext.Provider>
    </OpenArtifact.Provider>
  )
}

// The plain text of a message the operator typed.
function messageText(message: AppendMessage): string {
  return message.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("")
    .trim()
}

// The run's top bar: status dot, title, the status word, and the ⋯ menu.
// Mode, runtime and spend live in the run panel's Info section. Before the run
// loads the bar shows the sidebar's status.
function RunHeader({
  state,
  status,
  live,
  title,
  actions,
}: {
  state: RunState | null
  status: RunSummary["status"]
  live: boolean
  title: React.ReactNode
  actions: React.ReactNode
}) {
  const running = !isTerminal(status) && (state ? live : status === "running")
  // A stop is the newest fact about the run, so it wins over an older failure.
  const stopped = !!state?.stopped
  const failed = status === "error" && !stopped
  const word = running ? "Running" : stopped ? "Stopped" : failed ? "Failed" : "Done"
  return (
    <header className="flex h-12 shrink-0 items-center gap-2.5 border-b px-5 pe-2 max-md:px-3">
      <SidebarTrigger className="-ml-1 md:hidden" />
      <span
        className={cn(
          "size-[7px] shrink-0 rounded-full max-md:mt-[13px] max-md:self-start",
          dotClass(running ? "working" : failed ? "failed" : "done"),
        )}
      />
      {/* On a phone the status goes under the title. */}
      <div className="flex min-w-0 items-baseline gap-2.5 max-md:flex-col max-md:items-stretch max-md:gap-0">
        {title}
        <span className="shrink-0 text-xs text-muted-foreground">{word}</span>
      </div>
      <span className="ml-auto" />
      {actions}
    </header>
  )
}

// "‹ Name": back to the drawer page this one was opened from.
function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-ml-1 flex max-w-40 shrink-0 items-center gap-0.5 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground"
    >
      <ChevronLeft className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  )
}

// A child agent's top bar in the drawer.
function PeekHeader({
  state,
  id,
  back,
  onClose,
}: {
  state: RunState
  id: string
  back: React.ReactNode
  onClose: () => void
}) {
  const a = state.agents.find((n) => n.id === id)
  const from = a?.startedAt ?? runStart(state)
  const to = a?.endedAt ?? runEnd(state)
  return (
    <header className="flex h-12 shrink-0 items-center gap-2.5 border-b px-5 pe-3">
      {back}
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

// A saved file that this run no longer has, or has not loaded yet.
function MissingFile({ back, onClose }: { back: React.ReactNode; onClose: () => void }) {
  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b px-5 pe-3">
        {back}
        <span className="text-sm text-muted-foreground">Loading file…</span>
        <Button variant="ghost" size="icon-sm" className="ml-auto text-muted-foreground" aria-label="Close" onClick={onClose}>
          <X />
        </Button>
      </header>
    </>
  )
}

// The width of an element, kept current as it resizes.
function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [ref])
  return w
}

// Which panel section is open, kept across runs. Null means all folded.
const SECTION_KEY = "ts.panelSection"
const SECTIONS = ["info", "agents", "bulletin", "files", "findings"]

function useStoredSection(): [PanelSection | null, (s: PanelSection | null) => void] {
  const [value, setValue] = useState<PanelSection | null>(() => {
    const saved = localStorage.getItem(SECTION_KEY)
    if (saved === "") return null
    // "findings" is the Findings & Proofs section on main. The cast keeps this
    // branch building until PanelSection gains it.
    return saved && SECTIONS.includes(saved) ? (saved as PanelSection) : "agents"
  })
  const set = (s: PanelSection | null) => {
    setValue(s)
    localStorage.setItem(SECTION_KEY, s ?? "")
  }
  return [value, set]
}

// Which file each chat's drawer shows, saved by run id. A run with no entry
// opens with the drawer closed. Closing the drawer removes the entry.
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
// The flag reloads when the key changes, as when the view crosses the phone width.
function useStoredFlag(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const read = () => {
    const saved = localStorage.getItem(key)
    return saved == null ? initial : saved === "1"
  }
  const [stored, setStored] = useState(() => ({ key, value: read() }))
  if (stored.key !== key) setStored({ key, value: read() })
  const set = (v: boolean) => {
    setStored({ key, value: v })
    localStorage.setItem(key, v ? "1" : "0")
  }
  return [stored.key === key ? stored.value : read(), set]
}

// The actions on the whole run, at the end of the top bar. Archive is one tap
// and undoes itself. Delete sits in a menu and asks first. The server moves a
// deleted run's files to a trash folder, so a mistake can still be recovered by
// hand. Both wait while the agent works. Both sit in the ⋯ menu.
function RunActions({
  archived,
  busy,
  findings,
  onArchive,
  onDelete,
}: {
  archived: boolean
  busy: boolean
  findings: number
  onArchive: () => void
  onDelete: () => Promise<void>
}) {
  const [confirm, setConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="More actions" />}
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          <DropdownMenuItem disabled={busy} onClick={onArchive}>
            {archived ? <ArchiveRestore /> : <Archive />}
            {archived ? "Unarchive" : "Archive"}
          </DropdownMenuItem>
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
