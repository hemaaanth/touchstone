import { useState } from "react"
import { ChevronRight, ShieldQuestionMark } from "lucide-react"
import { cn } from "cn"
import { Markdown } from "@/components/markdown"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Hint, SeverityMark } from "@/components/assistant-ui/elements/indicators"
import { MASK_NOTE, MEASURED_SHORT, WHY_UNPROVEN, type Candidate } from "@/lib/candidate"

// The run's candidates. A candidate is unproven. Either the agent saw harm the
// pack's checks do not cover (agent-asserted), or the engine's replay only
// repeated a measurement (a setting, a missing record, a scanner grade), so the
// finding it was is not proven (measured). Both wait for human review.
// docs/restraint.md: it is neutral, like a lead. No red, no green, no accent:
// its severity bars stay grey, and its shield carries a question mark, never
// the check of a proven finding. Each row folds open to the write-up, the PoC,
// the cited lines, and (one fold deeper) the raw evidence.
export function CandidateList({ items }: { items: Candidate[] }) {
  if (!items.length) return <p className="px-3 py-2.5 text-xs text-muted-foreground">No candidates.</p>
  return (
    <div className="flex flex-col py-1">
      {items.map((c) => (
        <CandidateRow key={c.poc} candidate={c} />
      ))}
    </div>
  )
}

// The badge every candidate carries, wherever it shows: unproven, and who said it.
export function UnprovenBadge({ measured = false, className }: { measured?: boolean; className?: string }) {
  return (
    <Badge variant="secondary" className={cn("h-4 px-1.5 text-[10px] leading-3 text-muted-foreground", className)}>
      {measured ? "unproven / measured" : "unproven / agent-asserted"}
    </Badge>
  )
}

// The row's short state: what the agent's candidate waits for, or why the
// measured one is not proven.
const stateOf = (c: Candidate) => (c.measured ? MEASURED_SHORT[c.measured.reason] : "Needs review")

const ROW = "flex w-full gap-2.5 px-3 py-[7px] text-left outline-none transition-colors hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.03] focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"

function CandidateRow({ candidate: c }: { candidate: Candidate }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn(open && "bg-foreground/[0.03]")}>
      <CollapsibleTrigger className={ROW}>
        <Hint label="Candidate, not proven" tip={`Candidate · not proven · ${stateOf(c).toLowerCase()}`} className="mt-px">
          <ShieldQuestionMark aria-hidden className="size-3.5 text-muted-foreground" />
        </Hint>
        <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-[13px] leading-4 font-semibold">{c.title}</span>
            <SeverityMark severity={c.severity} className="ml-auto" />
          </span>
          <span className="flex min-w-0 items-center gap-2 text-[11px] leading-4 text-muted-foreground">
            <span className="shrink-0">{stateOf(c)}</span>
            {c.measured && c.measured.count > 1 ? <span className="shrink-0 tabular-nums">{c.measured.count} places</span> : null}
            <UnprovenBadge measured={Boolean(c.measured)} />
            <ChevronRight aria-hidden className={cn("ml-auto size-3 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
          </span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <CandidateDetail candidate={c} />
      </CollapsibleContent>
    </Collapsible>
  )
}

export function CandidateDetail({ candidate: c }: { candidate: Candidate }) {
  const m = c.measured
  return (
    <div className="flex flex-col gap-2.5 px-3 pt-0.5 pb-3 pl-9 text-xs">
      <p className="text-muted-foreground">{m ? m.words : WHY_UNPROVEN}</p>
      {c.explanation ? <Markdown text={c.explanation} className="text-xs" /> : null}
      {m ? <MeasuredFacts candidate={c} /> : (
        <Field label="PoC">
          <span className="font-mono text-[11px] break-all">{c.poc}</span>
        </Field>
      )}
      {c.cites.length ? (
        <Field label="Cited lines">
          <ul className="flex flex-col gap-0.5">
            {c.cites.map((line, i) => (
              <li key={i} className="font-mono text-[11px] break-all text-muted-foreground">
                {line}
              </li>
            ))}
          </ul>
        </Field>
      ) : null}
      {c.evidence != null ? <Evidence value={c.evidence} /> : null}
      <p className="text-[11px] text-muted-foreground">{MASK_NOTE}</p>
    </div>
  )
}

// What the engine measured: the check, where it fired (each folded place),
// and the pin of the snapshot or the oracle its replay read.
function MeasuredFacts({ candidate: c }: { candidate: Candidate }) {
  const m = c.measured!
  const items = (((c.evidence as { items?: unknown } | null)?.items ?? []) as { title?: string | null; file?: string | null; where?: unknown }[]).slice(0, 12)
  const place = (i: { file?: string | null; where?: unknown }) => {
    if (i.file) return i.file
    const w = i.where && typeof i.where === "object" ? (i.where as Record<string, unknown>) : null
    const v = w ? (w.host ?? w.url ?? w.name ?? w.file ?? w.domain) : null
    return typeof v === "string" ? v : null
  }
  return (
    <>
      {m.check ? (
        <Field label="Check">
          <span className="font-mono text-[11px] break-all">{m.check}</span>
        </Field>
      ) : null}
      {items.length > 1 ? (
        <Field label={`Fired at ${m.count} places`}>
          <ul className="flex flex-col gap-0.5">
            {items.map((i, k) => (
              <li key={k} className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                {place(i) ?? i.title ?? `place ${k + 1}`}
              </li>
            ))}
          </ul>
        </Field>
      ) : null}
      {m.snapshotHash ? (
        <Field label="Pinned snapshot">
          <span className="font-mono text-[11px] break-all text-muted-foreground" title={m.snapshotHash}>
            sha256 {m.snapshotHash.slice(0, 16)}…
          </span>
        </Field>
      ) : m.oracle ? (
        <Field label="Oracle">
          <span className="font-mono text-[11px] break-all text-muted-foreground">{m.oracle}</span>
        </Field>
      ) : null}
    </>
  )
}

// The captured evidence is raw machine output: one quiet fold, closed.
function Evidence({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-1">
      <CollapsibleTrigger className="flex w-fit items-center gap-1 rounded-sm text-[11px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring">
        <ChevronRight aria-hidden className={cn("size-3 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
        Evidence
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="max-h-48 overflow-auto rounded-md bg-foreground/[0.04] p-2 font-mono text-[11px] leading-4 whitespace-pre">
          {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}
