import type { ReactNode } from "react"
import { Button, ThemedIcon, Toast } from "@graphical"
import { DetailAccordion, KeyValues, Muted, ProofBlock, Section, SeverityLabel, Tag } from "@/components/app/blocks"
import { VERDICT_TONE } from "@/lib/tones"
import { PanelLink } from "@/components/app/cards/frame"
import { DisclosureDraftDialog, ReportDraftDialog } from "@/components/app/drafts"
import {
  AFTER_APPROVE,
  DIFF_SIGN,
  MODEL_SHORT,
  NEAR_LIMITED,
  PROOF,
  RETENTION,
  RUN_131,
  assetById,
  findingById,
  type Finding,
} from "@/data/fixtures"
import { accept, findingWith, isApproved, setPreview, useActions } from "@/lib/actions"
import { isOpen, verdictLabel, verdictOf } from "@/lib/answer"
import { findingClass, locationKey } from "@/lib/finding-text"
import { useWords } from "@/lib/words"

/*
 * The Finding panel, with Evidence (W-3).
 * It fits the 440px right column. PanelHost draws the title and close link.
 *
 * Rules:
 * - "Proven (machine)" until you accept it. Then "Proven" and the time (B5).
 *   No person names. One user.
 * - The location key has the chain ID and selector. The function name is a
 *   label only (C2).
 * - The cap names its input (C3). NEAR assets show Limited.
 * - History says "Seen in Source access" or "Seen in Public access" (C6).
 * - Hashes show only in Technical words. Plain words say what each file is.
 * - Evidence is kept 90 days, then deleted. Each deletion is logged.
 * - Accept and Preview live in lib/actions.ts, so the Findings list and the
 *   run agree with this panel.
 */

export function FindingPanel({ id }: { id: string | null }) {
  const actions = useActions()
  const base = id ? findingById(id) : undefined
  if (!base) return <Muted>No finding with the id {id ?? "(none)"}.</Muted>
  // The preview plays AFTER_APPROVE in this panel only. Nothing runs.
  const preview = actions.preview && base.id === AFTER_APPROVE.finding.id && !isApproved(actions)
  return (
    <FindingBody
      finding={findingWith(base, actions, preview)}
      preview={preview}
      acceptedAt={actions.accepted[base.id] ?? null}
    />
  )
}

/* ---------- Helpers ---------- */

function copyText(text: string) {
  void navigator.clipboard.writeText(text).catch(() => undefined)
}

function CopyButton({ text, label, onCopied }: { text: string; label: string; onCopied?: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => {
        copyText(text)
        onCopied?.()
      }}
      className="grid shrink-0 place-items-center rounded-(--radius-s) p-(--space-xxs) type-s text-(--cte-text-muted) hover:bg-(--neutral-4) hover:text-(--cte-text) focus-ring"
    >
      <ThemedIcon name="copy" />
    </button>
  )
}

/** The proof after you approve step 5 of run #131. Only F-0042 has one. */
function hasForkProof(finding: Finding): boolean {
  return (
    finding.id === AFTER_APPROVE.finding.id &&
    finding.proofTest?.kind === "fork test" &&
    finding.proofTest.state === "passed"
  )
}

const REFUTER_MODEL = RUN_131.modelsUsed.find((row) => row.role === "Refuter")?.model ?? ""

/** Unique model IDs from models.json, with their roles. */
function modelRows(): { model: string; roles: string[] }[] {
  const rows: { model: string; roles: string[] }[] = []
  for (const { role, model } of RUN_131.modelsUsed) {
    const row = rows.find((entry) => entry.model === model)
    if (row) row.roles.push(role)
    else rows.push({ model, roles: [role] })
  }
  return rows
}

function fixForEngineer(finding: Finding): string {
  const lines = [
    `${finding.id} ${finding.title} (${finding.severity}, ${verdictLabel(finding)})`,
    `Where: ${locationKey(finding)}`,
    `Problem: ${finding.why}`,
    `Fix: ${finding.fix}`,
  ]
  if (hasForkProof(finding)) lines.push(`Check: ${PROOF.command}`, "The fork test must fail after the fix.")
  if (finding.evidenceHash) lines.push(`Evidence: ${finding.evidenceHash}`)
  lines.push(`Inputs: ${finding.inputs.join(", ")}`, `Fingerprint: ${finding.fingerprint}`)
  return lines.join("\n")
}

/* ---------- Body ---------- */

function FindingBody({
  finding,
  preview,
  acceptedAt,
}: {
  finding: Finding
  preview: boolean
  acceptedAt: string | null
}) {
  const { technical } = useWords()
  const toasts = Toast.useToastManager()
  const asset = assetById(finding.asset)
  const verdict = verdictOf(finding)
  const label = verdictLabel(finding)
  const open = isOpen(finding)
  const canAccept = label === "Proven (machine)"

  function acceptVerdict() {
    accept(finding.id)
    toasts.add({ title: `You accepted ${finding.machineVerdict} for ${finding.id}`, description: "Written to the audit log." })
  }

  return (
    <div className="flex flex-col gap-(--space-l)">
      {/* Header facts */}
      <div className="flex flex-col gap-(--space-s)">
        <div className="flex flex-wrap items-center gap-(--space-s)">
          <SeverityLabel severity={finding.severity} />
          <Tag tone={VERDICT_TONE[verdict]}>{label}</Tag>
          <Tag>
            <span className="font-data">{DIFF_SIGN[finding.diff]}</span> {finding.diff}
          </Tag>
          {asset?.limited ? <Tag tone="warning">Limited</Tag> : null}
          {preview ? <Tag tone="accent">Preview</Tag> : null}
        </div>
        {canAccept ? (
          <div className="flex flex-wrap items-center gap-(--space-s)">
            <Button disabled={preview} onClick={acceptVerdict}>
              Accept Proven
            </Button>
            <Muted className="type-xs">
              {preview
                ? "This is a preview. Approve step 5 of run #131 before you accept."
                : "The machine says Proven. It stays “Proven (machine)” until you accept it."}
            </Muted>
          </div>
        ) : null}
        {acceptedAt && finding.accepted ? (
          <Muted className="type-xs">
            You accepted {finding.accepted} at <span className="font-data">{acceptedAt}</span>.
          </Muted>
        ) : null}
        <p className="type-s">{finding.why}</p>
      </div>

      <KeyValues
        rows={[
          ["Asset", asset?.name ?? finding.asset],
          ["Access", `${finding.access} access`],
          [
            "Inputs",
            <span key="inputs" className="font-data type-xs break-words">
              {finding.inputs.join(", ")}
            </span>,
          ],
          [
            "Where",
            <span key="where" className="font-data type-xs break-all">
              {locationKey(finding)}
            </span>,
          ],
          ["Cap", `${finding.cap}. ${finding.capReason}`],
          ["Found", `${finding.found}, run #${finding.run}`],
          ...(technical
            ? ([
                [
                  "Fingerprint",
                  <span key="fingerprint" className="font-data type-xs break-all">
                    {finding.fingerprint}
                  </span>,
                ],
              ] as [ReactNode, ReactNode][])
            : []),
        ]}
      />
      {asset?.limited ? <Muted className="type-s">{NEAR_LIMITED}</Muted> : null}

      <ProofTestSection finding={finding} preview={preview} onCopied={() => toasts.add({ title: "Command copied" })} />

      {/* Restraint: the proof above and the fix below stay open; the rest folds (closed). */}
      <DetailAccordion
        items={[
          {
            value: "refuter",
            title: "Refuter",
            meta: finding.refuter ? "ran" : "not run",
            children: <RefuterBody finding={finding} />,
          },
          {
            value: "history",
            title: "History",
            meta: finding.history.length,
            children: <HistoryBody finding={finding} asset={asset} />,
          },
          {
            value: "evidence",
            title: "Evidence",
            meta: `${finding.files.length} files`,
            children: <EvidenceBody finding={finding} />,
          },
        ]}
      />

      <Section title="Fix">
        <p className="type-s">{finding.fix}</p>
        <div className="flex flex-wrap gap-(--space-s)">
          {open ? (
            <Button
              onClick={() => {
                copyText(fixForEngineer(finding))
                toasts.add({ title: "Fix copied", description: "Paste it into a ticket or a message to your engineer." })
              }}
            >
              Copy fix for engineer
            </Button>
          ) : null}
          <ReportDraftDialog />
          {open ? <DisclosureDraftDialog findingId={finding.id} /> : null}
        </div>
      </Section>
    </div>
  )
}

/* ---------- Proof test ---------- */

function ProofTestSection({
  finding,
  preview,
  onCopied,
}: {
  finding: Finding
  preview: boolean
  onCopied: () => void
}) {
  const { technical, pick } = useWords()
  const test = finding.proofTest
  const canPreview = finding.id === AFTER_APPROVE.finding.id

  if (!test) {
    return (
      <Section title="Proof test">
        <Muted className="type-s">No proof test applies. {finding.capReason}</Muted>
      </Section>
    )
  }

  const kind = test.kind.charAt(0).toUpperCase() + test.kind.slice(1)

  if (hasForkProof(finding)) {
    return (
      <Section
        title="Proof test"
        action={
          preview ? (
            <Button variant="ghost" onClick={() => setPreview(false)}>
              Back to now
            </Button>
          ) : null
        }
      >
        {preview ? (
          <Muted className="type-xs">Preview of this panel after you approve step 5 of run #131. Nothing ran.</Muted>
        ) : null}
        <Muted className="type-xs">{RUN_131.fork?.banner}</Muted>
        <KeyValues
          rows={[
            ["Result", `${kind} passed in run #${test.run} step ${test.step}.`],
            ["Moved", `${PROOF.moved} on the fork. With the guard on: ${PROOF.guardedMoved}.`],
            ["Before", PROOF.before],
            ["After", PROOF.after],
            [
              "Test",
              <span key="test" className="font-data type-xs break-all">
                {PROOF.test}
              </span>,
            ],
            ...(technical
              ? ([
                  ["Trace", <span key="trace" className="font-data type-xs">{PROOF.traceHash}</span>],
                  ["Evidence", <span key="evidence" className="font-data type-xs">{finding.evidenceHash}</span>],
                ] as [ReactNode, ReactNode][])
              : []),
          ]}
        />
        <ProofBlock className="flex-row items-start gap-(--space-s)">
          <code className="min-w-0 flex-1 break-all whitespace-pre-wrap type-xs">{PROOF.command}</code>
          <CopyButton text={PROOF.command} label="Copy command" onCopied={onCopied} />
        </ProofBlock>
        <Muted className="type-xs">{pick("Run it on your own fork to check.", "Runs against a local anvil fork only.")}</Muted>
      </Section>
    )
  }

  let status: ReactNode
  if (test.state === "waiting") {
    status = (
      <>
        <span>
          {kind} waiting for your approval (run #{test.run} step {test.step}).
        </span>
        <span className="flex flex-wrap items-center gap-(--space-s)">
          <PanelLink view={`run/${test.run}`}>Open run #{test.run}</PanelLink>
          {canPreview ? (
            <Button variant="ghost" onClick={() => setPreview(true)}>
              Preview the result
            </Button>
          ) : null}
        </span>
      </>
    )
  } else if (test.state === "not run") {
    status = (
      <span>
        {test.run ? `${kind} did not run. Step ${test.step} of run #${test.run} was skipped.` : `${kind} has not run.`}{" "}
        Until it passes, the verdict stays at {verdictOf(finding)}.
      </span>
    )
  } else if (test.state === "failed") {
    status = (
      <span>
        {kind} ran in run #{test.run}. The attack did not work.
      </span>
    )
  } else {
    status = (
      <span>
        {kind} passed in run #{test.run}.
      </span>
    )
  }

  return (
    <Section title="Proof test">
      <div className="flex flex-col gap-(--space-xs) type-s">{status}</div>
    </Section>
  )
}

/* ---------- Folded detail: Refuter, History, Evidence ---------- */

function RefuterBody({ finding }: { finding: Finding }) {
  const { pick } = useWords()
  return (
    <div className="flex flex-col gap-(--space-xxs) type-s">
      <span>{finding.refuter ?? "Not checked yet."}</span>
      <Muted className="type-xs">
        Refuter model: {pick(MODEL_SHORT[REFUTER_MODEL] ?? REFUTER_MODEL, REFUTER_MODEL)}. It is a different model
        family from the executor.
      </Muted>
    </div>
  )
}

function HistoryBody({ finding, asset }: { finding: Finding; asset: ReturnType<typeof assetById> }) {
  return (
    <ol className="flex flex-col type-s">
      {finding.history.map((row) => (
        <li key={`${row.when}-${row.text}`} className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-(--space-m) py-(--space-xs) divide-bottom">
          <span className="font-data tabular-nums type-xs text-(--cte-text-muted)">{row.when}</span>
          <span>{row.text}</span>
        </li>
      ))}
      {asset?.drift ? (
        <li className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-(--space-m) py-(--space-xs)">
          <span className="font-data type-xs text-(--cte-text-muted)">Drift</span>
          <span>{asset.drift}</span>
        </li>
      ) : null}
    </ol>
  )
}

function EvidenceBody({ finding }: { finding: Finding }) {
  const { technical, pick } = useWords()

  return (
    <>
      <ul className="flex flex-col gap-(--space-xxs) type-s">
        {finding.evidence.map((row) => (
          <li key={row.technical}>{pick<ReactNode>(row.plain, <span className="font-data type-xs break-all">{row.technical}</span>)}</li>
        ))}
      </ul>

      <ProofBlock>
        <div className="grid grid-cols-[minmax(0,1fr)_max-content] gap-x-(--space-m) gap-y-(--space-xxs) type-xs">
          {finding.files.map((file) => (
            <div key={file.name} className="contents">
              <span className="break-all">{file.name}</span>
              <span className="text-(--cte-text-muted)">{technical && file.hash ? file.hash : file.plain}</span>
            </div>
          ))}
        </div>
      </ProofBlock>

      <div className="flex flex-col gap-(--space-xxs)">
        <span className="type-xs text-(--cte-text-muted)">models.json</span>
        <ul className="flex flex-col gap-(--space-xxs) type-xs">
          {modelRows().map((row) => (
            <li key={row.model} className="flex flex-col">
              <span className="font-data break-all">{row.model}</span>
              <Muted>{row.roles.join(", ")}</Muted>
            </li>
          ))}
        </ul>
      </div>

      {technical ? (
        <Muted className="type-xs">
          Bundle hash:{" "}
          {finding.evidenceHash ? <span className="font-data">{finding.evidenceHash}</span> : "not sealed yet"}. Class:{" "}
          {findingClass(finding)}.
        </Muted>
      ) : null}
      <Muted className="type-xs">
        Kept {RETENTION.days} days, then deleted on {finding.deletes}. The deletion is logged in the audit log.
      </Muted>
    </>
  )
}
