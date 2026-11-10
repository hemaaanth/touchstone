import { FolderGit2, Boxes, BookMarked, Settings2, Plus, ShieldCheck } from "lucide-react"
import type { ProviderInfo, RunSummary, SpendState } from "@/lib/types"
import { ago, DOT, statusLabel, statusTone } from "@/lib/format"
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
        <Button size="sm" className="w-full justify-start gap-2" onClick={onNewRun}>
          <Plus className="size-4" />
          New run
        </Button>
      </SidebarHeader>

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

        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {PAGES.map((p) => (
                <SidebarMenuItem key={p.id}>
                  <SidebarMenuButton isActive={isPage(p.id)} onClick={() => onSelect({ kind: "page", id: p.id })}>
                    <p.icon className="size-4" />
                    <span>{p.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="gap-2 p-2">
        {spend ? (
          <div className="flex items-center justify-between rounded-md px-2 py-1 text-[11px] text-muted-foreground">
            <span>{provider?.label ?? "Spend"}</span>
            <span className="tabular-nums">
              ${spend.usd.toFixed(2)} / ${spend.cap.toFixed(0)}
            </span>
          </div>
        ) : null}
        <SidebarMenu>
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
      </SidebarFooter>
    </Sidebar>
  )
}
