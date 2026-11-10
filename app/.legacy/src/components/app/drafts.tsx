import { useState } from "react"
import { Button, Dialog, Tabs, Toast } from "@graphical"
import { Muted, Tag } from "@/components/app/blocks"
import {
  DISCLOSURE_DRAFT,
  GRANT,
  MODULES,
  PROJECT,
  REPORT_DRAFT,
  RUN_131,
  assetById,
  findingById,
  type Finding,
} from "@/data/fixtures"
import { answer, ranOn, verdictLabel } from "@/lib/answer"
import { locationKey } from "@/lib/finding-text"

/*
 * Drafts.
 * The harness drafts. A human sends. Nothing here leaves this machine.
 *
 * - ReportDraftDialog: the project report as Markdown or JSON. It has a
 *   "What we could not see" section. No score.
 * - DisclosureDraftDialog: a disclosure draft for one finding. There is no
 *   Send button. You copy it and send it yourself.
 *
 * Exports carry plain words and technical terms, whatever the Words setting.
 */

type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger"

function copyText(text: string) {
  void navigator.clipboard.writeText(text).catch(() => undefined)
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement("a")
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}

/* ---------- Report ---------- */

function reportData() {
  const result = answer()
  return {
    title: REPORT_DRAFT.title,
    note: REPORT_DRAFT.note,
    project: PROJECT.name,
    grant: { version: GRANT.version, scopeHash: GRANT.scopeHash },
    answer: {
      state: result.state,
      reason: result.reason,
      checked: result.checked,
      of: result.of,
      accessMix: result.accessMix,
      byAccess: result.byAccess,
    },
    thingsToFix: result.fixes.map((finding) => ({
      id: finding.id,
      title: finding.title,
      severity: finding.severity,
      verdict: verdictLabel(finding),
      asset: assetById(finding.asset)?.name ?? finding.asset,
      access: finding.access,
      why: finding.why,
      fix: finding.fix,
      technical: {
        location: locationKey(finding),
        fingerprint: finding.fingerprint,
        inputs: finding.inputs,
        cap: finding.capReason,
      },
    })),
    whatWeChecked: MODULES.map((module) => {
      const { ran, of } = ranOn(module)
      return { module: module.name, on: module.on, ran, of }
    }),
    whatWeCouldNotSee: result.couldNotSee,
    modelsUsed: RUN_131.modelsUsed,
  }
}

function reportMarkdown(): string {
  const data = reportData()
  const lines: string[] = [`# ${data.title}`, "", data.note, ""]

  lines.push("## Answer", "")
  lines.push(`${data.answer.state}. ${data.answer.reason}`)
  lines.push(`Checked ${data.answer.checked} of ${data.answer.of} modules.`)
  lines.push(
    `Access: ${data.answer.accessMix} (${data.answer.byAccess.Source} Source, ${data.answer.byAccess.Public} Public).`,
  )
  lines.push("")

  lines.push("## Things to fix", "")
  if (data.thingsToFix.length === 0) lines.push("Nothing open.")
  for (const item of data.thingsToFix) {
    lines.push(`- ${item.id} ${item.title}. ${item.severity}, ${item.verdict}. ${item.asset}, ${item.access} access.`)
    lines.push(`  Why: ${item.why}`)
    lines.push(`  Fix: ${item.fix}`)
    lines.push(`  Technical: ${item.technical.location}. Inputs: ${item.technical.inputs.join(", ")}.`)
  }
  lines.push("")

  lines.push("## What we checked", "")
  for (const row of data.whatWeChecked) {
    lines.push(row.on ? `- ${row.module}: ran on ${row.ran} of ${row.of} assets.` : `- ${row.module}: off.`)
  }
  lines.push("")

  lines.push("## What we could not see", "")
  for (const note of data.whatWeCouldNotSee) lines.push(`- ${note}`)
  lines.push("- Public access checks do not show that the code is clean.")
  lines.push("")

  lines.push("## Models used", "")
  for (const row of data.modelsUsed) lines.push(`- ${row.role}: ${row.model}`)
  lines.push("")
  lines.push(`Scope ${data.grant.version}, scope hash ${data.grant.scopeHash}.`)

  return lines.join("\n")
}

/** The report draft. Markdown and JSON exports. No score. */
export function ReportDraftDialog({
  label = "Report draft",
  variant = "secondary",
}: {
  label?: string
  variant?: ButtonVariant
}) {
  const toasts = Toast.useToastManager()
  const [open, setOpen] = useState(false)
  const [format, setFormat] = useState<"markdown" | "json">("markdown")
  const markdown = open ? reportMarkdown() : ""
  const json = open ? JSON.stringify(reportData(), null, 2) : ""
  const text = format === "markdown" ? markdown : json
  const fileName = format === "markdown" ? "report-draft.md" : "report-draft.json"

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Button variant={variant} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="w-[min(640px,calc(100vw-var(--space-xl)))] max-w-[min(640px,calc(100vw-var(--space-xl)))]">
          <div className="flex items-center gap-(--space-s)">
            <Dialog.Title>{REPORT_DRAFT.title}</Dialog.Title>
            <Tag>Draft</Tag>
          </div>
          <Dialog.Description className="max-w-none">
            {REPORT_DRAFT.note} It has no score. It lists what we could not see.
          </Dialog.Description>
          <Tabs.Root value={format} onValueChange={(value) => setFormat(value as "markdown" | "json")}>
            <Tabs.List>
              <Tabs.Tab value="markdown">Markdown</Tabs.Tab>
              <Tabs.Tab value="json">JSON</Tabs.Tab>
            </Tabs.List>
          </Tabs.Root>
          <pre className="max-h-[50vh] overflow-auto rounded-(--radius-m) bg-(--cte-surface-muted) p-(--space-m) font-data type-xs whitespace-pre-wrap">
            {text}
          </pre>
          <div className="flex flex-wrap justify-end gap-(--space-s)">
            <Dialog.Close type="button">Close</Dialog.Close>
            <Button
              variant="secondary"
              onClick={() => {
                download(fileName, text, format === "markdown" ? "text/markdown" : "application/json")
                toasts.add({ title: `Saved ${fileName}`, description: "The file is on this machine only." })
              }}
            >
              Download
            </Button>
            <Button
              onClick={() => {
                copyText(text)
                toasts.add({ title: "Report copied", description: "Paste it where you need it." })
              }}
            >
              Copy {format === "markdown" ? "Markdown" : "JSON"}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/* ---------- Disclosure ---------- */

function disclosureText(finding: Finding): { to: string; subject: string; body: string } {
  const asset = assetById(finding.asset)
  const known = finding.id === DISCLOSURE_DRAFT.finding
  const to = known ? DISCLOSURE_DRAFT.to : `The security contact for ${asset?.name ?? finding.asset}`
  const subject = known ? DISCLOSURE_DRAFT.subject : `${finding.title} (${finding.id})`
  const body = [
    "Hello,",
    "",
    `We found a security problem in ${asset?.name ?? finding.asset}.`,
    "",
    `What: ${finding.why}`,
    `Severity: ${finding.severity}. Verdict: ${verdictLabel(finding)}.`,
    `Where: ${locationKey(finding)}`,
    `Suggested fix: ${finding.fix}`,
    "",
    "We tested only in a local sandbox. Nothing was sent to a live chain or service.",
    "Please reply to confirm that you got this message.",
  ].join("\n")
  return { to, subject, body }
}

/** A disclosure draft for one finding. No Send button: a human sends it. */
export function DisclosureDraftDialog({
  findingId,
  label = "Disclosure draft",
  variant = "secondary",
}: {
  findingId: string
  label?: string
  variant?: ButtonVariant
}) {
  const toasts = Toast.useToastManager()
  const [open, setOpen] = useState(false)
  const finding = findingById(findingId)
  if (!finding) return null
  const draft = disclosureText(finding)
  const full = `To: ${draft.to}\nSubject: ${draft.subject}\n\n${draft.body}`

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Button variant={variant} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="w-[min(560px,calc(100vw-var(--space-xl)))] max-w-[min(560px,calc(100vw-var(--space-xl)))]">
          <div className="flex items-center gap-(--space-s)">
            <Dialog.Title>Disclosure draft</Dialog.Title>
            <Tag>Draft</Tag>
          </div>
          <Dialog.Description className="max-w-none">{DISCLOSURE_DRAFT.note}</Dialog.Description>
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-(--space-l) gap-y-(--space-xs) type-s">
            <dt className="text-(--cte-text-muted)">To</dt>
            <dd className="min-w-0">{draft.to}</dd>
            <dt className="text-(--cte-text-muted)">Subject</dt>
            <dd className="min-w-0">{draft.subject}</dd>
          </dl>
          <pre className="max-h-[40vh] overflow-auto rounded-(--radius-m) bg-(--cte-surface-muted) p-(--space-m) font-data type-xs whitespace-pre-wrap">
            {draft.body}
          </pre>
          <Muted className="type-xs">The harness has no Send button. You send it from your own mail.</Muted>
          <div className="flex justify-end gap-(--space-s)">
            <Dialog.Close type="button">Close</Dialog.Close>
            <Button
              onClick={() => {
                copyText(full)
                toasts.add({ title: "Draft copied", description: "Send it yourself. The harness never sends it." })
              }}
            >
              Copy draft
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
