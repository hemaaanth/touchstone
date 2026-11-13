import { memo } from "react"
import { ChevronRight, ShieldQuestionMark } from "lucide-react"
import type { FindingSummary, RunSummary } from "@/lib/types"
import { candidateShortState, candidateState, scopeOf } from "@/lib/findings-view"
import { cn } from "@/lib/utils"
import { SeverityMark } from "@/components/assistant-ui/elements/indicators"
import { ModuleDots } from "@/components/module-dots"
import { RowMenu, RowMenuItem, RowMeta, RowTitle, TruncatedText } from "@/components/page-parts"
import { rowClass } from "@/components/page-parts-style"
import { CANDIDATE_FOCUS } from "@/lib/candidate"

// A candidate on the Findings page (N3). It sits in the findings' row grid, so
// its columns line up with theirs, but it is neutral (docs/restraint.md): a
// grey question-mark shield, grey severity bars, and its state in words,
// "Candidate · measurement repeated" or "Candidate · needs review". It has no
// report and no bundle: it opens its run, where the Candidates section holds
// its write-up and evidence.
export const CandidateListRow = memo(function CandidateListRow({
  finding: f,
  cols,
  moduleTitle,
  run,
  onOpenRun,
  when,
}: {
  finding: FindingSummary
  // The findings' grid columns and the dots' ring colour (findings-page.tsx
  // FINDING_ROW_COLS, DOTS_RING), so the row lines up with a finding row.
  cols: string
  moduleTitle: string
  run: RunSummary | undefined
  // The run, and the candidate to land on in it (CANDIDATE_FOCUS + its poc).
  onOpenRun: (id: string, focus?: string) => void
  // The run's start, as the finding rows show it (findings-page.tsx).
  when?: (ms: number) => string
}) {
  const c = f.candidate!
  const open = () => run && onOpenRun(run.id, `${CANDIDATE_FOCUS}${c.poc}`)
  const pack = f.pack ?? ""
  return (
    <li data-slot="finding-row" data-candidate onClick={open} className={cn(cols, rowClass(Boolean(run)))}>
      <span aria-hidden className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">
        <ShieldQuestionMark className="size-4" />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <RowTitle title={f.title || "Candidate"} opens={Boolean(run)} popup={false} />
        <RowMeta
          items={[
            // On a phone (below sm) the state is one short word that never
            // shrinks, and the date is left out: the row keeps its words and
            // never runs under the severity bars. From sm up, the full words.
            <span key="state" data-slot="candidate-state" className="flex min-w-0 shrink-0 sm:shrink" title={candidateState(c)}>
              <span className="whitespace-nowrap sm:hidden">{candidateShortState(c)}</span>
              <span className="hidden min-w-0 truncate sm:inline">{candidateState(c)}</span>
            </span>,
            c.measured && c.measured.count > 1 ? <span key="count" className="shrink-0 whitespace-nowrap tabular-nums">{c.measured.count} places</span> : null,
            <TruncatedText key="scope" text={scopeOf(f)} />,
            <span key="at" data-slot="candidate-date" className="shrink-0 whitespace-nowrap tabular-nums max-sm:hidden" title="When the run started">
              {f.at != null && when ? when(f.at) : "Date not recorded"}
            </span>,
          ]}
        />
      </div>
      <span data-col="severity" className="flex justify-center">
        <SeverityMark severity={f.severity} proven={false} />
      </span>
      {/* The module as one dot in the same 28 px box as the finding row. No
          module keeps the empty box. */}
      <span data-col="module" className="flex justify-end">
        <ModuleDots ids={[pack]} packs={[{ id: pack, title: moduleTitle }]} />
      </span>
      <RowMenu label={`Actions for ${f.title}`}>
        <RowMenuItem disabled={!run} onClick={open}>
          <ChevronRight /> Open in run
        </RowMenuItem>
      </RowMenu>
    </li>
  )
})
