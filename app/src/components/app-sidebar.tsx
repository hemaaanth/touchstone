import { Archive, ArchiveRestore, BookMarked, Boxes, ChevronRight, FolderGit2, Network, Plus, Settings2, ShieldCheck } from "lucide-react"
import type { ProviderInfo, RunSummary, SpendState } from "@/lib/types"
import { ago, DOT, formatUsd, isTerminal, statusLabel, statusTone } from "@/lib/format"
import { cn } from "cn"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { Button } from "@/components/ui/button"
import { ResizeHandle } from "@/components/resize-handle"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu"

// What the center column is showing. A run, or one of the single-item pages.
export type View =
  | { kind: "run"; id: string }
  | { kind: "page"; id: "fleet" | "projects" | "modules" | "playbooks" | "settings" }

const PAGES = [
  { id: "fleet", label: "Operator console", icon: Network },
  { id: "projects", label: "Projects", icon: FolderGit2 },
  { id: "modules", label: "Modules", icon: Boxes },
  { id: "playbooks", label: "Playbooks", icon: BookMarked },
] as const

export function AppSidebar({
  runs,
  view,
  onSelect,
  onNewRun,
  onArchive,
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
  spend: SpendState | null
  provider: ProviderInfo | null
}) {
  const isPage = (id: string) => view?.kind === "page" && view.id === id
  const isRun = (id: string) => view?.kind === "run" && view.id === id
  const open = runs.filter((r) => !r.archived)
  const archived = runs.filter((r) => r.archived)
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

  return (
    <Sidebar>
      <SidebarHeader className="gap-3 p-3">
        <div className="flex items-center gap-2 px-1">
          <div className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <ShieldCheck className="size-3.5" />
          </div>
          <span className="text-sm font-semibold tracking-tight">Touchstone</span>
        </div>
        {/* The one primary action: a full-width button, not a chip. */}
        <Button className="w-full justify-center gap-2" onClick={newRun}>
          <Plus className="size-4" />
          New run
        </Button>
      </SidebarHeader>

      {/* Runs are the whole point of the rail, so they own the scrolling body.
          Archived runs sit in their own section below, collapsed by default. */}
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Runs</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {open.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">No runs yet.</p>
              ) : (
                open.map((r) => <RunRow key={r.id} run={r} active={isRun(r.id)} onSelect={go} onArchive={onArchive} />)
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {archived.length > 0 ? (
          <Collapsible render={<SidebarGroup />}>
            <SidebarGroupLabel
              render={<CollapsibleTrigger />}
              className="group/archived w-full cursor-default gap-1 hover:text-sidebar-foreground"
            >
              <ChevronRight className="size-3.5! transition-transform group-data-[panel-open]/archived:rotate-90" />
              <span>Archived</span>
              <span className="ml-auto tabular-nums">{archived.length}</span>
            </SidebarGroupLabel>
            <CollapsibleContent>
              <SidebarGroupContent>
                <SidebarMenu>
                  {archived.map((r) => (
                    <RunRow key={r.id} run={r} active={isRun(r.id)} onSelect={go} onArchive={onArchive} />
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </SidebarContent>

      {/* Workspace nav + account controls sit together at the base, divided
          from the runs list above. Projects / Modules / Playbooks are
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

// One run in the rail. Right-click (or long-press) opens Archive / Unarchive.
// A run that is still working cannot be archived; it would cut the agent off.
function RunRow({
  run: r,
  active,
  onSelect,
  onArchive,
}: {
  run: RunSummary
  active: boolean
  onSelect: (v: View) => void
  onArchive: (id: string, archived: boolean) => void
}) {
  const tone = statusTone(r.status)
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<SidebarMenuItem />}
        className="data-popup-open:[&>[data-sidebar=menu-button]]:bg-sidebar-accent"
      >
        <SidebarMenuButton
          isActive={active}
          onClick={() => onSelect({ kind: "run", id: r.id })}
          className="h-auto items-start py-1.5"
        >
          <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", DOT[tone])} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[13px] leading-snug">{(r.title ?? r.alias).replaceAll("`", "")}</span>
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span>{statusLabel(r.status)}</span>
              <span aria-hidden>·</span>
              <span>{ago(r.startedAt)}</span>
            </span>
          </span>
        </SidebarMenuButton>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {r.archived ? (
          <ContextMenuItem onClick={() => onArchive(r.id, false)}>
            <ArchiveRestore />
            Unarchive
          </ContextMenuItem>
        ) : (
          <ContextMenuItem disabled={!isTerminal(r.status)} onClick={() => onArchive(r.id, true)}>
            <Archive />
            Archive
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
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
