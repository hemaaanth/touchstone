// Synthetic surface only. The real RunChat/runtime/Ask/Desktop components run;
// the loopback fixture owns every API response and never starts an agent.
import { createRoot } from "react-dom/client"
import { SettingsPage } from "../../src/components/settings-page"
import { RunChat } from "../../src/components/run-chat"
import { SidebarProvider } from "../../src/components/ui/sidebar"
import { TooltipProvider } from "../../src/components/ui/tooltip"
import type { RunSummary } from "../../src/lib/types"

const run: RunSummary = { id: "fixture", alias: "fixture", status: "running", startedAt: 1, title: "Ask chat fixture", severity: null }
createRoot(document.getElementById("root")!).render(
  <SidebarProvider><TooltipProvider><main className="h-screen min-w-0 flex-1">
    {new URLSearchParams(location.search).has("settings") ? <SettingsPage onChanged={() => {}} /> : <RunChat run={run} onArchive={() => {}} onRename={() => {}} onDelete={async () => {}} />}
  </main></TooltipProvider></SidebarProvider>,
)
