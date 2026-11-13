import { memo } from "react"
import { ChevronRight, ShieldQuestionMark } from "lucide-react"
import type { FindingSummary, RunSummary } from "@/lib/types"
import { candidateState, scopeOf } from "@/lib/findings-view"
import { cn } from "@/lib/utils"
import { SeverityMark } from "@/components/assistant-ui/elements/indicators"
import { ModulePill } from "@/components/module-pill"
import { RowMenu, RowMenuItem, RowMeta, RowTitle, TruncatedText } from "@/components/page-parts"
import { rowClass } from "@/components/page-parts-style"

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
}: {
  finding: FindingSummary
  // The findings' grid columns (findings-page.tsx FINDING_ROW_COLS).
  cols: string
  moduleTitle: string
  run: RunSummary | undefined
  onOpenRun: (id: string) => void
}) {
  const c = f.candidate!
  const open = () => run && onOpenRun(run.id)
  const pack = f.pack ?? ""
  return (
    <li data-slot="finding-row" data-candidate onClick={open} className={cn(cols, rowClass(Boolean(run)))}>
      <span aria-hidden className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">
        <ShieldQuestionMark className="size-4" />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <RowTitle title={f.title || "Candidate"} opens={Boolean(run)} />
        <RowMeta
          items={[
            <span key="state" className="shrink-0 whitespace-nowrap">{candidateState(c)}</span>,
            c.measured && c.measured.count > 1 ? <span key="count" className="shrink-0 whitespace-nowrap tabular-nums">{c.measured.count} places</span> : null,
            <TruncatedText key="scope" text={scopeOf(f)} />,
          ]}
        />
      </div>
      <span data-col="severity" className="flex justify-center">
        <SeverityMark severity={f.severity} proven={false} />
      </span>
      <span data-col="module" className="flex min-w-0 justify-end overflow-hidden">
        {pack ? (
          <span title={moduleTitle} className="flex max-w-full">
            <ModulePill id={pack} label={moduleTitle} compact className="[&>span:last-child]:sr-only" />
          </span>
        ) : null}
      </span>
      <RowMenu label={`Actions for ${f.title}`}>
        <RowMenuItem disabled={!run} onClick={open}>
          <ChevronRight /> Open in run
        </RowMenuItem>
      </RowMenu>
    </li>
  )
})
