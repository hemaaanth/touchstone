import type { RunStatus, Severity } from "./types"

// Relative time, compact. "just now" / "4m" / "2h" / "3d".
export function ago(ts: number | null | undefined): string {
  if (!ts) return ""
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 45) return "just now"
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}

// Elapsed wall-clock since a start instant, compact. "0s" / "9s" / "1m 20s" /
// "2h 03m". Used by live cognition surfaces (agent-status, tool-group) that tick
// while an attempt runs, so it reads whole seconds up and stays monotonic.
export function elapsed(startedAt: number | null | undefined, now: number = Date.now()): string {
  if (!startedAt) return ""
  const s = Math.max(0, Math.floor((now - startedAt) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, "0")}m`
}

// A dollar figure for a run's spend. Sub-cent costs show four places so a
// fraction-of-a-cent run never rounds to "$0.00"; everything else is cents.
export function formatUsd(usd: number | null): string {
  if (usd == null) return "—"
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

// A grouped integer ("18,234"), or an em dash when the figure is absent.
export function formatNum(n: number | null): string {
  return n == null ? "—" : n.toLocaleString("en-US")
}

// A run is live while it is still doing work; terminal once it has settled.
const TERMINAL: RunStatus[] = ["recorded", "denied", "no-finding", "error"]
export const isTerminal = (s: RunStatus): boolean => TERMINAL.includes(s)

// The one-word station a status reads as, for a sidebar row or header chip.
export function statusLabel(s: RunStatus): string {
  switch (s) {
    case "starting":
      return "Starting"
    case "running":
      return "Running"
    case "awaiting-approval":
      return "Awaiting proof"
    case "deciding":
      return "Recording"
    case "recorded":
      return "Proven"
    case "denied":
      return "Denied"
    case "no-finding":
      return "No finding"
    case "error":
      return "Error"
    default:
      return s
  }
}

// Status → the dot/pill tone. "proven" is the only green; "error"/"denied" red;
// everything in-flight is amber; a clean no-finding is neutral. One accent
// meaning per restraint.md — green never shows until a replay proved something.
export type Tone = "green" | "amber" | "red" | "neutral"
export function statusTone(s: RunStatus): Tone {
  if (s === "recorded") return "green"
  if (s === "error" || s === "denied") return "red"
  if (s === "no-finding") return "neutral"
  return "amber"
}

export function severityTone(sev: Severity): Tone {
  return sev === "critical" || sev === "high" ? "red" : sev === "medium" ? "amber" : "neutral"
}

// Text colour for a status word or icon, keyed by tone.
export const INK: Record<Tone, string> = {
  green: "text-ok",
  amber: "text-warn",
  red: "text-bad",
  neutral: "text-muted-foreground",
}

// Tailwind classes for a small status dot, keyed by tone.
export const DOT: Record<Tone, string> = {
  green: "bg-ok",
  amber: "bg-warn",
  red: "bg-bad",
  neutral: "bg-muted-foreground/60",
}
