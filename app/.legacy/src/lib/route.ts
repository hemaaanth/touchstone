import { useSyncExternalStore } from "react"

/*
 * Hash routes with an optional side panel.
 *
 *   #/home                          the Home chat
 *   #/home?panel=finding/F-0042     Home with the Finding panel open
 *   #/findings?panel=run/131        Findings with the Run panel open
 *
 * Routes: home, first-run, findings, scope, automations, settings, kit.
 * Panel views: finding/<id>, run/<id>, coverage, coverage/<module key>.
 */

export const ROUTES = ["home", "first-run", "findings", "scope", "automations", "settings", "kit"] as const
export type Route = (typeof ROUTES)[number]

function readHash() {
  return window.location.hash.replace(/^#\/?/, "")
}

/** The route without the panel query. Defaults to "home". */
function readRoute() {
  return readHash().split("?")[0] || "home"
}

/** The panel view, or null when no panel is open. */
function readPanel() {
  const query = readHash().split("?")[1]
  return query ? new URLSearchParams(query).get("panel") : null
}

function subscribe(onChange: () => void) {
  window.addEventListener("hashchange", onChange)
  return () => window.removeEventListener("hashchange", onChange)
}

/** The current route, for example "home". The ?panel part is stripped. */
export function useRoute() {
  return useSyncExternalStore(subscribe, readRoute, () => "home")
}

/** The open panel view, for example "finding/F-0042", or null. */
export function usePanel() {
  return useSyncExternalStore(subscribe, readPanel, () => null)
}

/** A link to a route. Pass a panel view to open it beside the route. */
export function href(route: string, panel?: string) {
  return panel ? `#/${route}?panel=${panel}` : `#/${route}`
}

/** A link that opens a panel view on the current route. */
export function panelHref(view: string) {
  return href(readRoute(), view)
}

/** A link that closes the panel and stays on the current route. */
export function closePanelHref() {
  return href(readRoute())
}

export function openPanel(view: string) {
  window.location.hash = panelHref(view)
}

export function closePanel() {
  window.location.hash = closePanelHref()
}

export type PanelKind = "finding" | "run" | "coverage"

/** Splits "finding/F-0042" into { kind: "finding", id: "F-0042" }. */
export function parsePanel(view: string): { kind: PanelKind | null; id: string | null } {
  const [kind, ...rest] = view.split("/")
  const id = rest.join("/") || null
  if (kind === "finding" || kind === "run" || kind === "coverage") return { kind, id }
  return { kind: null, id }
}
