import type { ReactNode } from "react"
import { RUNS, findingById, moduleByKey } from "@/data/fixtures"
import { parsePanel, type PanelKind } from "@/lib/route"
import { CoveragePanel } from "./coverage"
import { FindingPanel } from "./finding"
import { RunPanel } from "./run"

/*
 * The panel registry. A panel view is "<kind>/<id>" in the URL:
 *   #/home?panel=finding/F-0042
 *   #/home?panel=run/131
 *   #/findings?panel=coverage            (grid)
 *   #/findings?panel=coverage/contracts  (module detail)
 * Each view gives a title and a body. PanelHost draws the frame.
 */

function findingTitle(id: string | null) {
  const finding = id ? findingById(id) : undefined
  return finding ? `${finding.id} ${finding.title}` : "Finding"
}

function runTitle(id: string | null) {
  const run = id ? RUNS[id] : undefined
  return run ? `Run #${run.id} ${run.title}` : "Run"
}

function coverageTitle(id: string | null) {
  const module = id ? moduleByKey(id) : undefined
  return module ? `${module.n}. ${module.name}` : "Coverage"
}

type PanelView = {
  title: (id: string | null) => string
  render: (id: string | null) => ReactNode
}

export const PANELS: Record<PanelKind, PanelView> = {
  finding: { title: findingTitle, render: (id) => <FindingPanel id={id} /> },
  run: { title: runTitle, render: (id) => <RunPanel id={id} /> },
  coverage: { title: coverageTitle, render: (id) => <CoveragePanel id={id} /> },
}

/** Title and body for a panel view string, or null when the kind is unknown. */
export function resolvePanel(view: string): { title: string; body: ReactNode } | null {
  const { kind, id } = parsePanel(view)
  if (!kind) return null
  const panel = PANELS[kind]
  return { title: panel.title(id), body: panel.render(id) }
}
