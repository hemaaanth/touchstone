import { useMemo } from "react"
import { Boxes, FolderGit2, Settings2 } from "lucide-react"
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react"
import type { RunSummary } from "@/lib/types"
import { ago, DOT, isTerminal, runTitle } from "@/lib/format"
import { runRowStatus } from "@/components/thread-model"
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
import markRaw from "@/assets/touchstone-mark.svg?raw"

// What the center column is showing. A run, or one of the single-item pages.
export type View =
  | { kind: "run"; id: string }
  | { kind: "page"; id: "scopes" | "modules" | "settings" }

const PAGES = [
  { id: "scopes", label: "Scopes", icon: FolderGit2 },
  { id: "modules", label: "Modules", icon: Boxes },
] as const

export function AppSidebar({
  runs,
  view,
  onSelect,
  onNewRun,
  onArchive,
  onRename,
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
          <TouchstoneMark />
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
          from the runs list above. Scopes / Modules are
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
      </SidebarFooter>
      <ResizeHandle edge="right" width={width} onWidth={onWidth} initial={defaultWidth} label="Resize sidebar" />
    </Sidebar>
  )
}

const NO_MESSAGES: ThreadMessageLike[] = []

// The brand mark from src/assets/touchstone-mark.svg. One filled shape in
// currentColor, so it takes the sidebar foreground in light and in dark.
const MARK_VIEWBOX = /viewBox="([^"]+)"/.exec(markRaw)?.[1] ?? "0 0 32 32"
const MARK_PATHS = [...markRaw.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<path\b([^>]*)\/?>/g)].map((m) => {
  const attrs = m[1]
  return {
    d: /d="([^"]*)"/.exec(attrs)?.[1] ?? "",
    evenodd: /fill-rule="evenodd"/.test(attrs),
  }
})

function TouchstoneMark() {
  return (
    <svg
      viewBox={MARK_VIEWBOX}
      fill="currentColor"
      aria-hidden="true"
      className="block size-6 shrink-0 text-sidebar-foreground"
    >
      {MARK_PATHS.map((p) => (
        <path key={p.d} d={p.d} fillRule={p.evenodd ? "evenodd" : undefined} />
      ))}
    </svg>
  )
}

// One run as a thread list item. `custom` carries what the row shows.
function runThread<S extends "regular" | "archived">(r: RunSummary, status: S) {
  const done = isTerminal(r.status)
  // A restart's cut-off reads Interrupted with a neutral dot, not as a failure.
  const row = runRowStatus(r)
  const custom: RunThreadCustom = {
    dot: DOT[row.tone],
    label: `${row.word} · ${ago(r.startedAt)}`,
    at: r.startedAt,
    running: !done,
    canArchive: done,
  }
  return { status, id: r.id, title: runTitle(r), custom }
}
