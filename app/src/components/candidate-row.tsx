import { memo } from "react"
import { ChevronRight, ShieldQuestionMark } from "lucide-react"
import type { FindingSummary, RunSummary } from "@/lib/types"
import { candidateShortState, candidateState, scopeOf } from "@/lib/findings-view"
import { cn } from "@/lib/utils"
import { SeverityMark } from "@/components/assistant-ui/elements/indicators"
import { ModuleDots } from "@/components/module-dots"
import { RowMenu, RowMenuItem, RowTitle, TruncatedText } from "@/components/page-parts"
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
        {/* The row's one muted line, as RowMeta draws it, but each part that
            is left out on a phone (below sm) carries its own dot, so no dot
            is left behind. On a phone the state is one short word that never
            shrinks; from sm up, the full words, the places count and the date. */}
        <div data-slot="candidate-meta" className="flex min-w-0 items-center gap-1.5 text-xs leading-5 text-muted-foreground">
          <span data-slot="candidate-state" className="flex min-w-0 shrink-0 sm:shrink" title={candidateState(c)}>
            <span className="whitespace-nowrap sm:hidden">{candidateShortState(c)}</span>
            <span className="hidden min-w-0 truncate sm:inline">{candidateState(c)}</span>
          </span>
          {c.measured && c.measured.count > 1 ? (
            <span data-slot="candidate-count" className="flex shrink-0 items-center gap-1.5 whitespace-nowrap tabular-nums max-sm:hidden">
              <Dot />
              {c.measured.count} places
            </span>
          ) : null}
          <Dot />
          <TruncatedText text={scopeOf(f)} />
          <span data-slot="candidate-date" className="flex shrink-0 items-center gap-1.5 whitespace-nowrap tabular-nums max-sm:hidden" title="When the run started">
            <Dot />
            {f.at != null && when ? when(f.at) : "Date not recorded"}
          </span>
        </div>
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

// The separator dot RowMeta draws between its parts.
function Dot() {
  return (
    <span aria-hidden className="shrink-0 opacity-60">
      ·
    </span>
  )
}
