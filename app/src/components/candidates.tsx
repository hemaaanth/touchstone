import { useState } from "react"
import { ChevronRight, ShieldQuestionMark } from "lucide-react"
import { cn } from "cn"
import { Markdown } from "@/components/markdown"
import { WHY_UNPROVEN, type Candidate } from "@/lib/candidate"

// The run's candidates. A candidate is unproven and agent-asserted: the agent
// saw harm the pack's checks do not cover. It waits for human review. It is
// styled amber with a question-mark shield, so it never reads as a finding
// (green, a checked shield). Each row opens to its write-up, PoC and evidence.
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

// The badge every candidate carries, wherever it shows.
export function UnprovenBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border border-warn/40 px-1.5 py-px text-[10px] leading-3 font-medium whitespace-nowrap text-warn",
        className,
      )}
    >
      unproven / agent-asserted
    </span>
  )
}

function CandidateRow({ candidate: c }: { candidate: Candidate }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={cn("border-l-2 border-warn/60", open && "bg-warn/[0.04]")}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full gap-2.5 px-3 py-[7px] text-left transition-colors outline-none hover:bg-warn/[0.06] focus-visible:bg-warn/[0.06]"
      >
        <ShieldQuestionMark className="mt-px size-3.5 shrink-0 text-warn" />
        <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate text-[13px] leading-4 font-semibold">{c.title}</span>
            <span className="ml-auto shrink-0 text-[11px] leading-[14px] text-warn">Needs review</span>
          </span>
          <span className="flex min-w-0 items-center gap-2 text-xs leading-4 text-muted-foreground">
            <span className="shrink-0 capitalize">{c.severity}</span>
            <UnprovenBadge />
            <ChevronRight className={cn("ml-auto size-3 shrink-0 transition-transform", open && "rotate-90")} />
          </span>
        </span>
      </button>
      {open ? <CandidateDetail candidate={c} /> : null}
    </div>
  )
}

export function CandidateDetail({ candidate: c }: { candidate: Candidate }) {
  return (
    <div className="flex flex-col gap-2 px-3 pt-0.5 pb-2.5 pl-9 text-xs">
      <p className="text-warn">{WHY_UNPROVEN}</p>
      {c.explanation ? <Markdown text={c.explanation} className="text-xs" /> : null}
      <Field label="PoC">
        <span className="font-mono text-[11px] break-all">{c.poc}</span>
      </Field>
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
      {c.evidence != null ? (
        <Field label="Evidence">
          <pre className="max-h-48 overflow-auto rounded-md bg-foreground/[0.04] p-2 font-mono text-[11px] leading-4 whitespace-pre">
            {typeof c.evidence === "string" ? c.evidence : JSON.stringify(c.evidence, null, 2)}
          </pre>
        </Field>
      ) : null}
    </div>
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
