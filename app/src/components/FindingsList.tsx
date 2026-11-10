import { ThemedIcon } from "@graphical"
import type { FindingSummary } from "@/lib/types"
import { SeverityChip, formatDuration } from "./bits"

// The proven mark: a filled success circle with a check. Green appears only
// because a deterministic Foundry replay reproduced the finding.
function ProvenMark() {
  return (
    <span
      className="grid size-[20px] shrink-0 place-items-center rounded-(--radius-full) text-(--neutral-1)"
      style={{ background: "var(--success)" }}
      aria-label="Proven by replay"
    >
      <ThemedIcon name="check" />
    </span>
  )
}

function FindingRow({
  finding,
  selected,
  onSelect,
}: {
  finding: FindingSummary
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="focus-ring flex w-full items-center gap-(--space-s) rounded-(--radius-m) px-(--space-m) py-(--space-s) text-left"
      style={selected ? { background: "var(--neutral-3)" } : undefined}
      aria-pressed={selected}
    >
      {finding.proven ? (
        <ProvenMark />
      ) : (
        <span className="size-[20px] shrink-0 rounded-(--radius-full) bg-(--neutral-4)" />
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-(--space-xxs)">
        <span className="flex items-center gap-(--space-s)">
          <span className="font-data type-xxs text-(--cte-text-muted)">{finding.id}</span>
          <span className="truncate type-s weight-medium text-(--cte-text)">{finding.title}</span>
        </span>
        <span className="type-xxs text-(--cte-text-muted)">
          {finding.proven ? "Proven by replay" : "Unproven"} · {finding.target}
        </span>
      </span>
      <SeverityChip severity={finding.severity} proven={finding.proven} />
      <span className="font-data type-xxs tabular-nums text-(--cte-text-muted)">
        {formatDuration(finding.ms)}
      </span>
    </button>
  )
}

export function FindingsList({
  findings,
  selectedId,
  onSelect,
}: {
  findings: FindingSummary[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-(--space-l) p-(--space-l)">
      <header className="flex flex-col gap-(--space-xxs)">
        <h1 className="type-m weight-medium text-(--cte-text)">Findings</h1>
        <p className="type-xs text-(--cte-text-muted)">
          Replay-gated · a finding is real only when a Foundry replay reproduces it on a sandbox fork
        </p>
      </header>

      <div className="flex flex-col gap-(--space-xxs)">
        {findings.map((finding) => (
          <FindingRow
            key={finding.id}
            finding={finding}
            selected={finding.id === selectedId}
            onSelect={() => onSelect(finding.id)}
          />
        ))}
      </div>
    </div>
  )
}
