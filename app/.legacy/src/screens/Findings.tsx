import { useState, type ReactNode } from "react"
import { SelectField, Tabs } from "@graphical"
import { Disclosure, Muted, Page, SeverityLabel, Tag } from "@/components/app/blocks"
import { VERDICT_TONE } from "@/lib/tones"
import { ReportDraftDialog } from "@/components/app/drafts"
import {
  DIFF_SIGN,
  PROJECT,
  assetById,
  moduleByKey,
  type DiffMark,
  type Finding,
} from "@/data/fixtures"
import { countByAccess, isOpen, openFindings, verdictLabel, verdictOf } from "@/lib/answer"
import { useFindings } from "@/lib/actions"
import { href, usePanel } from "@/lib/route"
import { cn } from "cn"

/*
 * Findings, as a review queue first (restraint).
 * - Review: only what needs a human now — a machine-proven finding waiting to
 *   be accepted, or a new / reopened open finding. This is the default tab.
 * - All: the full project list, open and worst first, with filters folded away.
 * Each finding is one quiet row in a document, not a dense grid: a row can
 * never crush or wrap because it does not fight a table's column widths.
 * Public access checks never read as "clean" (the silent-zero rule).
 * A row opens the Finding panel (#/findings?panel=finding/<id>).
 */

const ALL = "all"

const DIFF_ORDER: DiffMark[] = ["New", "Reopened", "Fixed", "Open", "Changed", "Not run"]

function options(values: string[]): { value: string; label: string }[] {
  return [{ value: ALL, label: "All" }, ...values.map((value) => ({ value, label: value }))]
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

/** SelectField renders its label and trigger as siblings. This stacks them. */
function Filter({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-(--space-xs)">{children}</div>
}

/** Open first and worst first, then closed. */
function sorted(findings: Finding[]): Finding[] {
  return [...openFindings(findings), ...findings.filter((finding) => !isOpen(finding))]
}

/** The review queue: a human must accept a machine proof, or look at a new / reopened open finding. */
function needsReview(finding: Finding): boolean {
  if (verdictLabel(finding) === "Proven (machine)") return true
  return isOpen(finding) && (finding.diff === "New" || finding.diff === "Reopened")
}

export function Findings() {
  const panel = usePanel()
  const [severity, setSeverity] = useState(ALL)
  const [verdict, setVerdict] = useState(ALL)
  const [access, setAccess] = useState(ALL)
  const [moduleKey, setModuleKey] = useState(ALL)

  const all = sorted(useFindings())
  const review = all.filter(needsReview)
  const shown = all.filter(
    (finding) =>
      (severity === ALL || finding.severity === severity) &&
      (verdict === ALL || verdictOf(finding) === verdict) &&
      (access === ALL || finding.access === access) &&
      (moduleKey === ALL || finding.module === moduleKey),
  )
  const open = all.filter(isOpen).length
  const byAccess = countByAccess()
  const moduleOptions = [
    { value: ALL, label: "All" },
    ...unique(all.map((finding) => finding.module)).map((key) => ({
      value: key,
      label: moduleByKey(key)?.name ?? key,
    })),
  ]
  const activeFilters = [severity, verdict, access, moduleKey].filter((value) => value !== ALL).length

  return (
    <Page
      crumbs={[{ label: PROJECT.name, to: "home" }]}
      title="Findings"
      meta={`${open} open, ${all.length - open} closed`}
      actions={<ReportDraftDialog />}
    >
      <Tabs.Root defaultValue={review.length > 0 ? "review" : "all"} className="flex flex-col gap-(--space-l)">
        <Tabs.List>
          <Tabs.Tab value="review">Review ({review.length})</Tabs.Tab>
          <Tabs.Tab value="all">All ({all.length})</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="review">
          <div className="flex flex-col gap-(--space-m)">
            {review.length === 0 ? (
              <Muted className="type-s">Nothing is waiting for you. Every proof is accepted and no new finding is open.</Muted>
            ) : (
              <>
                <Muted className="type-s">
                  These need you: accept a machine proof, or look at a new or reopened finding.
                </Muted>
                <FindingsList findings={review} panel={panel} />
              </>
            )}
          </div>
        </Tabs.Panel>

        <Tabs.Panel value="all">
          <div className="flex flex-col gap-(--space-m)">
            <Disclosure summary="Filters" meta={activeFilters > 0 ? `${activeFilters} on` : undefined}>
              <div className="flex flex-wrap items-start gap-(--space-l)">
                <Filter>
                  <SelectField
                    label="Severity"
                    options={options(["Critical", "High", "Medium", "Low"])}
                    value={severity}
                    onValueChange={(value) => setSeverity(value ?? ALL)}
                  />
                </Filter>
                <Filter>
                  <SelectField
                    label="Verdict"
                    options={options(["Proven", "Likely", "Unproven", "Not exploitable", "Fixed"])}
                    value={verdict}
                    onValueChange={(value) => setVerdict(value ?? ALL)}
                  />
                </Filter>
                <Filter>
                  <SelectField
                    label="Access"
                    options={options(["Source", "Public"])}
                    value={access}
                    onValueChange={(value) => setAccess(value ?? ALL)}
                  />
                </Filter>
                <Filter>
                  <SelectField
                    label="Module"
                    options={moduleOptions}
                    value={moduleKey}
                    onValueChange={(value) => setModuleKey(value ?? ALL)}
                  />
                </Filter>
              </div>
            </Disclosure>

            <Muted className="type-s">
              Assets in scope: {byAccess.Source} with Source access, {byAccess.Public} with Public access. Public
              access checks do not show that the code is clean.
            </Muted>

            {shown.length === 0 ? (
              <Muted className="type-s">No finding matches these filters.</Muted>
            ) : (
              <FindingsList findings={shown} panel={panel} />
            )}

            <Muted className="flex flex-wrap gap-x-(--space-m) gap-y-(--space-xs) type-xs">
              {activeFilters > 0 ? <span>{`${shown.length} of ${all.length} shown.`}</span> : null}
              {DIFF_ORDER.map((mark) => (
                <span key={mark}>
                  <span className="font-data">{DIFF_SIGN[mark]}</span> {mark}
                </span>
              ))}
            </Muted>
          </div>
        </Tabs.Panel>
      </Tabs.Root>
    </Page>
  )
}

/** The findings list. Shared by the Review and All tabs. */
function FindingsList({ findings, panel }: { findings: Finding[]; panel: string | null }) {
  return (
    <ul className="flex flex-col divide-top">
      {findings.map((finding) => (
        <li key={finding.id}>
          <FindingRow finding={finding} panel={panel} />
        </li>
      ))}
    </ul>
  )
}

/** One finding as a two-line row: the title line, then its quiet metadata. */
function FindingRow({ finding, panel }: { finding: Finding; panel: string | null }) {
  const view = `finding/${finding.id}`
  const current = panel === view
  const asset = assetById(finding.asset)
  const closed = !isOpen(finding)
  return (
    <a
      href={href("findings", view)}
      aria-current={current ? "true" : undefined}
      className={cn(
        "flex flex-col gap-(--space-xxs) rounded-(--radius-s) px-(--space-s) py-(--space-s) focus-ring hover:bg-(--cte-surface-muted)",
        current && "bg-(--cte-surface-muted)",
      )}
    >
      <div className="flex items-baseline gap-(--space-s)">
        <span
          className="shrink-0 font-data type-xs text-(--cte-text-muted)"
          title={finding.diff}
          aria-label={finding.diff}
        >
          {DIFF_SIGN[finding.diff]}
        </span>
        <span className={cn("min-w-0 flex-1 truncate type-s weight-medium", closed && "text-(--cte-text-muted)")}>
          <span className="font-data type-xs text-(--cte-text-muted)">{finding.id}</span> {finding.title}
        </span>
        <span className="shrink-0 type-s">
          <SeverityLabel severity={finding.severity} />
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-(--space-m) gap-y-(--space-xxs) pl-(--space-l) type-xs text-(--cte-text-muted)">
        <span className="inline-flex items-center gap-(--space-xs)">
          <Tag tone={VERDICT_TONE[verdictOf(finding)]}>{verdictLabel(finding)}</Tag>
          {finding.accepted ? <span>Accepted</span> : null}
        </span>
        <span>{finding.access} access</span>
        <span className="inline-flex items-center gap-(--space-xs)">
          {asset?.name ?? finding.asset}
          {asset?.limited ? <Tag tone="warning">Limited</Tag> : null}
        </span>
      </div>
    </a>
  )
}
