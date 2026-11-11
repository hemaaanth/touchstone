import { useMemo } from "react"
import { BookMarked, Boxes, FolderGit2, Settings2, ShieldCheck } from "lucide-react"
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react"
import type { ProviderInfo, RunSummary, SpendState } from "@/lib/types"
import { ago, DOT, formatUsd, isTerminal, runTitle, statusLabel, statusTone } from "@/lib/format"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { ResizeHandle } from "@/components/resize-handle"
import { ThreadList, type RunThreadCustom } from "@/components/assistant-ui/elements/thread-list"

// What the center column is showing. A run, or one of the single-item pages.
export type View =
  | { kind: "run"; id: string }
  | { kind: "page"; id: "scopes" | "modules" | "playbooks" | "settings" }

const PAGES = [
  { id: "scopes", label: "Scopes", icon: FolderGit2 },
  { id: "modules", label: "Modules", icon: Boxes },
  { id: "playbooks", label: "Playbooks", icon: BookMarked },
] as const

export function AppSidebar({
  runs,
  view,
  onSelect,
  onNewRun,
  onArchive,
  onRename,
  spend,
  provider,
  width,
  onWidth,
  defaultWidth,
}: {
  width: number
  onWidth: (w: number) => void
  defaultWidth: number
  runs: RunSummary[]
  view: View | null
  onSelect: (v: View) => void
  onNewRun: () => void
  onArchive: (id: string, archived: boolean) => void
  onRename: (id: string, name: string) => void
  spend: SpendState | null
  provider: ProviderInfo | null
}) {
  const isPage = (id: string) => view?.kind === "page" && view.id === id
  const open = useMemo(() => runs.filter((r) => !r.archived), [runs])
  const archived = useMemo(() => runs.filter((r) => r.archived), [runs])
  // On a phone the rail is a sheet over the content. Picking a destination
  // closes it, so you land on the chat you chose instead of behind the menu.
  const { setOpenMobile } = useSidebar()
  const go = (v: View) => {
    onSelect(v)
    setOpenMobile(false)
  }
  const newRun = () => {
    setOpenMobile(false)
    onNewRun()
  }

  // The runs list is the assistant-ui thread list element, fed from our runs
  // through an external-store thread list. It has no chat of its own.
  const threads = useMemo(() => open.map((r) => runThread(r, "regular" as const)), [open])
  const archivedThreads = useMemo(() => archived.map((r) => runThread(r, "archived" as const)), [archived])
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: NO_MESSAGES,
    convertMessage: (m) => m,
    onNew: async () => {},
    adapters: {
      threadList: {
        threadId: view?.kind === "run" ? view.id : undefined,
        threads,
        archivedThreads,
        onSwitchToThread: (id) => go({ kind: "run", id }),
        onSwitchToNewThread: newRun,
        onRename: (id, title) => onRename(id, title),
        onArchive: (id) => onArchive(id, true),
        onUnarchive: (id) => onArchive(id, false),
      },
    },
  })

  return (
    <Sidebar>
      <SidebarHeader className="p-3">
        <div className="flex items-center gap-2 px-1">
          <div className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <ShieldCheck className="size-3.5" />
          </div>
          <span className="text-sm font-semibold tracking-tight">Touchstone</span>
        </div>
      </SidebarHeader>

      {/* Runs own the scrolling body. Archived runs fold up below them. */}
      <SidebarContent className="px-2">
        <AssistantRuntimeProvider runtime={runtime}>
          <ThreadList />
        </AssistantRuntimeProvider>
      </SidebarContent>

      {/* Workspace nav + account controls sit together at the base, divided
          from the runs list above. Scopes / Modules / Playbooks are
          destinations you leave the runs for, so they live down here by
          Settings rather than competing with the list. */}
      <SidebarFooter className="gap-0 border-t border-sidebar-border p-2 pb-3">
        <SidebarMenu className="gap-px">
          {PAGES.map((p) => (
            <SidebarMenuItem key={p.id}>
              <SidebarMenuButton
                className="h-7 text-[13px]"
                isActive={isPage(p.id)}
                onClick={() => go({ kind: "page", id: p.id })}
              >
                <p.icon className="size-4" />
                <span>{p.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          <SidebarMenuItem>
            <SidebarMenuButton
              className="h-7 text-[13px]"
              isActive={isPage("settings")}
              onClick={() => go({ kind: "page", id: "settings" })}
            >
              <Settings2 className="size-4" />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>

        {spend ? <SpendMeter spend={spend} provider={provider} /> : null}
      </SidebarFooter>
      <ResizeHandle edge="right" width={width} onWidth={onWidth} initial={defaultWidth} label="Resize sidebar" />
    </Sidebar>
  )
}

const NO_MESSAGES: ThreadMessageLike[] = []

// One run as a thread list item. `custom` carries what the row shows.
function runThread<S extends "regular" | "archived">(r: RunSummary, status: S) {
  const done = isTerminal(r.status)
  const custom: RunThreadCustom = {
    dot: DOT[statusTone(r.status)],
    label: `${statusLabel(r.status)} · ${ago(r.startedAt)}`,
    at: r.startedAt,
    running: !done,
    canArchive: done,
  }
  return { status, id: r.id, title: runTitle(r), custom }
}

// Who is paying for new runs, and the total spent so far. Each run has its own
// budget, so there is no global bar to fill.
function SpendMeter({ spend, provider }: { spend: SpendState; provider: ProviderInfo | null }) {
  return (
    <div className="mx-2 mt-2 flex items-center justify-between gap-2 border-t border-sidebar-border pt-2.5 text-[11px]">
      <span className="min-w-0 truncate font-medium text-muted-foreground">{provider?.label ?? "Spend"}</span>
      <span className="shrink-0 tabular-nums text-muted-foreground">
        <span className="text-foreground/80">{formatUsd(spend.usd)}</span> spent
      </span>
    </div>
  )
}
