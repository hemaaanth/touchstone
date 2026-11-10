import { useState, type ReactNode } from "react"
import { Button, Collapsible, ThemedIcon } from "@graphical"
import type { Severity } from "@/lib/types"

// The Touchstone mark: a quiet rounded square with a struck center — a stone
// you test metal against. Drawn in currentColor so it follows the theme.
export function Mark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="16" height="16" rx="5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="9" cy="9" r="3" fill="currentColor" />
    </svg>
  )
}

export function Wordmark() {
  return (
    <div className="flex items-center gap-(--space-xs) text-(--cte-text)">
      <Mark />
      <span className="type-s weight-heavy tracking-[-0.01em]">Touchstone</span>
    </div>
  )
}

// Red is reserved for a proven finding. The one real finding is critical, so
// the chip earns its danger tone; lower severities stay neutral.
const SEV_LABEL: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
}

export function SeverityChip({ severity, proven = false }: { severity: Severity; proven?: boolean }) {
  const danger = proven && (severity === "critical" || severity === "high")
  return (
    <span
      className="inline-flex items-center rounded-(--radius-s) px-(--space-xs) py-(--space-xxs) type-xxs weight-medium"
      style={
        danger
          ? {
              color: "var(--cte-danger)",
              background: "color-mix(in oklab, var(--cte-danger) 14%, transparent)",
            }
          : { color: "var(--cte-text-muted)", background: "var(--neutral-3)" }
      }
    >
      {SEV_LABEL[severity]}
    </span>
  )
}

export function formatDuration(ms: number | null): string {
  if (!ms) return "—"
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

export function formatUsd(usd: number | null): string {
  if (usd == null) return "—"
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

export function formatNum(n: number | null): string {
  return n == null ? "—" : n.toLocaleString("en-US")
}

// Copies real text and confirms inline — no toast plumbing needed.
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="ghost"
      onClick={() => {
        void navigator.clipboard?.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }}
    >
      <ThemedIcon name={copied ? "check" : "copy"} />
      {copied ? "Copied" : label}
    </Button>
  )
}

// One disclosure pattern for every folded section — the audit trail, the run
// metadata, the raw replay output. Same chevron (rotates down when open), same
// indent, same quiet label, so the detail panel reads as one consistent stack
// instead of three mismatched toggles. Closed by default; this is restraint.md's
// progressive disclosure workhorse.
export function Fold({
  label,
  meta,
  defaultOpen = false,
  className,
  children,
}: {
  label: string
  meta?: string
  defaultOpen?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <Collapsible.Root defaultOpen={defaultOpen} className={className}>
      <Collapsible.Trigger className="focus-ring flex w-full items-center justify-start gap-(--space-xs) rounded-(--radius-s) py-(--space-xxs) type-xs weight-medium text-(--cte-text-muted) hover:text-(--cte-text) [&[data-panel-open]_.chev]:rotate-90">
        <span className="chev grid size-[16px] shrink-0 place-items-center transition-transform">
          <ThemedIcon name="chevronRight" />
        </span>
        <span>{label}</span>
        {meta ? <span className="text-(--cte-text-muted)">· {meta}</span> : null}
      </Collapsible.Trigger>
      <Collapsible.Panel>
        <Collapsible.Content>
          <div className="pt-(--space-m) pl-[calc(16px+var(--space-xs))]">{children}</div>
        </Collapsible.Content>
      </Collapsible.Panel>
    </Collapsible.Root>
  )
}

// A proven run records itself. This is the lightweight ledger override: flip a
// recorded run to "not a finding I count" (or restore it). It never touches the
// proof — it only changes how the run reads. Quiet by design; it is not a gate.
// Left-aligned and sized to its text so it does not stretch into a centered bar,
// and carries no leading dash — only a spinner while the write is in flight.
export function DismissControl({
  dismissed,
  busy = false,
  onToggle,
}: {
  dismissed: boolean
  busy?: boolean
  onToggle: (next: boolean) => void
}) {
  if (dismissed) {
    return (
      <div className="flex flex-wrap items-center gap-(--space-s)">
        <span className="inline-flex items-center rounded-(--radius-s) bg-(--neutral-3) px-(--space-xs) py-(--space-xxs) type-xxs weight-medium text-(--cte-text-muted)">
          Not counted
        </span>
        <div className="flex">
          <Button
            variant="secondary"
            style={{ backgroundColor: "var(--neutral-4)" }}
            disabled={busy}
            onClick={() => onToggle(false)}
          >
            {busy ? (
              <span className="motion-safe:animate-spin">
                <ThemedIcon name="loader" />
              </span>
            ) : null}
            Restore to recorded
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div className="flex">
      <Button
        variant="secondary"
        style={{ backgroundColor: "var(--neutral-4)" }}
        disabled={busy}
        onClick={() => onToggle(true)}
      >
        {busy ? (
          <span className="motion-safe:animate-spin">
            <ThemedIcon name="loader" />
          </span>
        ) : null}
        Don't count this finding
      </Button>
    </div>
  )
}

// A label / value pair used in the sidebar vitals and proof meta.
export function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-(--space-xxs)">
      <span className="type-xxs text-(--cte-text-muted)">{label}</span>
      <span className="type-xs text-(--cte-text)">{children}</span>
    </div>
  )
}
