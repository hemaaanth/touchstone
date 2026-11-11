import { createContext } from "react"
import { COORDINATOR, type AgentNode } from "@/lib/types"
import type { RunState, Step } from "@/lib/runModel"

// What a fleet thread needs from the run view. RunChat provides it only when
// the run has agents, so a single-agent run renders exactly as before.
export interface FleetView {
  state: RunState
  // Open one agent's peek. `key` scrolls the peek to that step. `push` keeps the
  // current peek on the back stack.
  openPeek: (id: string, key?: string, push?: boolean) => void
  // Close the peek and scroll the main chat to that step.
  jumpMain: (key: string) => void
  // The step a pill just jumped to. It is highlighted for a moment.
  highlight: string | null
  // Send an operator message to the coordinator, through the steer path.
  steer: (text: string) => Promise<void>
  canSteer: boolean
}

export const FleetContext = createContext<FleetView | null>(null)

// Whose thread a renderer shows: null is the main chat (the coordinator), else
// a child id. A pill for the thread's own owner does nothing.
export const ThreadOwner = createContext<string | null>(null)

export function agentName(state: RunState, id: string | undefined): string {
  if (!id || id === COORDINATOR) return "Coordinator"
  const a = state.agents.find((n) => n.id === id)
  return a?.name || a?.title || id
}

// The time of the event that made a step. A step key starts with its event
// index; streamed text keys (reasoning:…, say:…) do not, so they have no time.
export function stepTime(state: RunState, step: Step): number | null {
  const i = parseInt(step.key, 10)
  if (!Number.isFinite(i) || String(i) !== step.key.split("-")[0]) return null
  const t = state.events[i]?.t
  return typeof t === "number" ? t : null
}

export function runStart(state: RunState): number | null {
  const t = state.events[0]?.t
  return typeof t === "number" ? t : null
}

export function runEnd(state: RunState): number | null {
  for (let i = state.events.length - 1; i >= 0; i--) {
    const t = state.events[i]?.t
    if (typeof t === "number") return t
  }
  return null
}

// A span of time, short: "21s", "6m", "1h 4m".
export function span(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

// When a step happened, as time since the run started.
export function stepAge(state: RunState, step: Step): string | undefined {
  const t = stepTime(state, step)
  const t0 = runStart(state)
  return t != null && t0 != null ? span(t - t0) : undefined
}

// The run's budget, from its `budget` event. Null on a run without one.
export function runBudget(state: RunState): number | null {
  for (const e of state.events) {
    if (e.ev === "budget" && typeof (e as { usd?: unknown }).usd === "number") return (e as unknown as { usd: number }).usd
    if (e.ev === "spend" && typeof (e as { budgetUsd?: unknown }).budgetUsd === "number")
      return (e as unknown as { budgetUsd: number }).budgetUsd
  }
  return null
}

// What the run has spent. The engine's latest "spend" event is the run total,
// coordinator included. A run without one falls back to the agents' own spend.
export function fleetSpend(state: RunState): number {
  for (let i = state.events.length - 1; i >= 0; i--) {
    const e = state.events[i] as { ev: string; usd?: unknown }
    if (e.ev === "spend" && typeof e.usd === "number") return e.usd
  }
  return state.agents.reduce((n, a) => n + (a.spendUsd ?? 0), 0)
}

export const usd = (n: number) => `$${n.toFixed(2)}`

export const AGENT_WORD: Record<AgentNode["state"], string> = {
  spawning: "Starting",
  working: "Working",
  idle: "Idle",
  done: "Done",
  failed: "Failed",
}

// A 7px status dot. Working is solid grey, done is faint, idle is a ring, and
// only a failure is red.
export function dotClass(state: AgentNode["state"]): string {
  if (state === "failed") return "bg-bad"
  if (state === "done") return "bg-muted-foreground/45"
  if (state === "idle") return "border border-muted-foreground"
  return "bg-muted-foreground"
}

export const isLiveAgent = (a: AgentNode) => a.state === "working" || a.state === "spawning"
