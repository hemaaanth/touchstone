import { FolderGit2, Boxes, BookMarked, Settings2, Plus, ShieldCheck } from "lucide-react"
import type { ProviderInfo, RunSummary, SpendState } from "@/lib/types"
import { ago, DOT, formatUsd, statusLabel, statusTone } from "@/lib/format"
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
  SidebarSeparator,
} from "@/components/ui/sidebar"
import { Button } from "@/components/ui/button"

// What the center column is showing. A run, or one of the single-item pages.
export type View =
  | { kind: "run"; id: string }
  | { kind: "page"; id: "projects" | "modules" | "playbooks" | "settings" }

const PAGES = [
  { id: "projects", label: "Projects", icon: FolderGit2 },
  { id: "modules", label: "Modules", icon: Boxes },
  { id: "playbooks", label: "Playbooks", icon: BookMarked },
] as const

export function AppSidebar({
  runs,
  view,
  onSelect,
  onNewRun,
  spend,
  provider,
}: {
  runs: RunSummary[]
  view: View | null
  onSelect: (v: View) => void
  onNewRun: () => void
  spend: SpendState | null
  provider: ProviderInfo | null
}) {
  const isPage = (id: string) => view?.kind === "page" && view.id === id

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
        <Button className="w-full justify-center gap-2" onClick={onNewRun}>
          <Plus className="size-4" />
          New run
        </Button>
      </SidebarHeader>

      {/* Runs are the whole point of the rail, so they own the scrolling body. */}
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Runs</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {runs.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">No runs yet.</p>
              ) : (
                runs.map((r) => {
                  const tone = statusTone(r.status)
                  return (
                    <SidebarMenuItem key={r.id}>
                      <SidebarMenuButton
                        isActive={view?.kind === "run" && view.id === r.id}
                        onClick={() => onSelect({ kind: "run", id: r.id })}
                        className="h-auto items-start py-1.5"
                      >
                        <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", DOT[tone])} />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-[13px] leading-snug">{r.title ?? r.alias}</span>
                          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                            <span>{statusLabel(r.status)}</span>
                            <span aria-hidden>·</span>
                            <span>{ago(r.startedAt)}</span>
                          </span>
                        </span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/* Workspace nav + account controls sit together at the base, divided
          from the runs list above. Projects / Modules / Playbooks are
          destinations you leave the runs for, so they live down here by
          Settings rather than competing with the list. */}
      <SidebarFooter className="gap-1 p-2">
        <SidebarSeparator className="mx-0 mb-1" />
        <SidebarMenu>
          {PAGES.map((p) => (
            <SidebarMenuItem key={p.id}>
              <SidebarMenuButton isActive={isPage(p.id)} onClick={() => onSelect({ kind: "page", id: p.id })}>
                <p.icon className="size-4" />
                <span>{p.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={isPage("settings")}
              onClick={() => onSelect({ kind: "page", id: "settings" })}
            >
              <Settings2 className="size-4" />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>

        {spend ? <SpendMeter spend={spend} provider={provider} /> : null}
      </SidebarFooter>
    </Sidebar>
  )
}

// The run budget, read at a glance: who is paying, how much of the cap is gone,
// and a bar that fills as spend climbs — amber only as it nears the ceiling.
// Neutral fill otherwise, so it never borrows the proven-finding green/red.
function SpendMeter({ spend, provider }: { spend: SpendState; provider: ProviderInfo | null }) {
  const pct = spend.cap > 0 ? Math.min(100, (spend.usd / spend.cap) * 100) : 0
  const near = pct >= 90
  return (
    <div className="rounded-md px-2 pt-1.5 pb-1">
      <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px]">
        <span className="min-w-0 truncate font-medium text-muted-foreground">
          {provider?.label ?? "Spend"}
        </span>
        {/* The live spend ticks up as the run burns budget. tabular-nums keeps
            the digits still and the reserved width absorbs the $9 → $10 rollover,
            so the number updating never nudges the label or the meter. */}
        <span className="shrink-0 tabular-nums text-foreground/80">
          <span className="inline-block min-w-[2.9rem] text-end">{formatUsd(spend.usd)}</span>
          <span className="text-muted-foreground"> / {formatUsd(spend.cap)}</span>
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500",
            near ? "bg-amber-500" : "bg-foreground/45",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
