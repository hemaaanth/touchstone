import type { ReactNode } from "react"
import { Toast, Tooltip } from "@graphical"
import { usePanel, useRoute, type Route } from "@/lib/route"
import { PanelHost } from "@/shell/PanelHost"
import { Rail } from "@/shell/Rail"
import { Toaster, TopBar } from "@/shell/TopBar"
import { AutomationsScreen } from "@/screens/AutomationsScreen"
import { Findings } from "@/screens/Findings"
import { FirstRun } from "@/screens/FirstRun"
import { Home } from "@/screens/Home"
import { Kit } from "@/screens/Kit"
import { Scope } from "@/screens/Scope"
import { Settings } from "@/screens/Settings"

/*
 * The app shell: a thin top bar, then a quiet rail and one reading canvas.
 * A side panel (?panel=<view>) opens as a sibling column that REFLOWS the
 * canvas (it shrinks, never hides behind the panel). Six screens and the kit.
 */

const SCREENS: Record<Route, () => ReactNode> = {
  home: Home,
  "first-run": FirstRun,
  findings: Findings,
  scope: Scope,
  automations: AutomationsScreen,
  settings: Settings,
  kit: Kit,
}

export function App() {
  const route = useRoute()
  const panel = usePanel()
  // An unknown route shows Home. Old links (module/*, thread/*) land there.
  const Screen = SCREENS[route as Route] ?? Home
  return (
    <Toast.Provider>
      <Tooltip.Provider>
        <div className="flex h-full min-h-0 flex-col">
          <TopBar />
          <div className="flex min-h-0 flex-1">
            <Rail />
            <main className="min-h-0 min-w-0 flex-1">
              <Screen />
            </main>
            {panel ? <PanelHost view={panel} /> : null}
          </div>
        </div>
        <Toaster />
      </Tooltip.Provider>
    </Toast.Provider>
  )
}
