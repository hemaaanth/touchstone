import type { Automation, Severity, Verdict } from "@/data/fixtures"

/*
 * Tone maps for the Dot and Tag blocks. They live outside blocks.tsx, so that
 * file exports only components (fast refresh).
 */

export type DotTone = "error" | "warning" | "success" | "accent" | "orange" | "muted"

export const SEVERITY_TONE: Record<Severity, DotTone> = {
  Critical: "error",
  High: "error",
  Medium: "orange",
  Low: "muted",
}

export const VERDICT_TONE: Record<Verdict, DotTone> = {
  Proven: "error",
  Likely: "orange",
  Unproven: "muted",
  "Not exploitable": "muted",
  Fixed: "success",
}

export const AUTOMATION_TONE: Record<Automation["state"], DotTone> = {
  healthy: "success",
  running: "accent",
  failed: "error",
  off: "muted",
}

/** Screen-reader words for an automation's dot. */
export const AUTOMATION_STATE: Record<Automation["state"], string> = {
  healthy: "Healthy",
  running: "Running now",
  failed: "Last run failed",
  off: "Off",
}
