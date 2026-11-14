export type DemoConfig = { budgetUsd: number; maxMinutes: number }

const DEFAULT_DEMO: DemoConfig = { budgetUsd: 1, maxMinutes: 10 }
export const DEMO_SOURCE = "https://github.com/hemaaanth/touchstone"
export const DEMO_ADMIN_MESSAGE = "The sponsored demo is unavailable right now. The owner needs to check its setup. No API key is needed from you."
export const DEMO_BUSY_MESSAGE = "Another demo is running. Try again when it finishes. Runs are not queued."
export const DEMO_LIMIT_MESSAGE = "Demo limit reached. Please try again later."
export const DEMO_TARGETS = ["vault-reentrancy", "vault-accounting"] as const

// Read the static HTML before rendering. A malformed opt-in must not expose owner controls.
export function demoConfig(): DemoConfig | null {
  if (typeof document === "undefined") return null
  const meta = document.querySelector<HTMLMetaElement>('meta[name="touchstone-demo"]')
  if (!meta) return null
  try {
    const config: unknown = JSON.parse(meta.content)
    if (config && typeof config === "object" && "budgetUsd" in config && "maxMinutes" in config &&
      config.budgetUsd === DEFAULT_DEMO.budgetUsd && config.maxMinutes === DEFAULT_DEMO.maxMinutes) {
      return { budgetUsd: config.budgetUsd, maxMinutes: config.maxMinutes }
    }
  } catch { /* Keep the presentation restricted when the opt-in is malformed. */ }
  return { ...DEFAULT_DEMO }
}

export function isDemoMode(): boolean {
  return demoConfig() !== null
}

export function isDemoTarget(id: string | undefined): id is typeof DEMO_TARGETS[number] {
  return DEMO_TARGETS.some((target) => target === id)
}

export function demoStartBody(targetId: string | undefined): { targetId: string } {
  if (!isDemoTarget(targetId)) throw new Error("Select a prepared demo scope before starting.")
  return { targetId }
}
