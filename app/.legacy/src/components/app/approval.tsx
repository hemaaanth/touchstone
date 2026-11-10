import { Button, ThemedIcon, Toast } from "@graphical"
import { Disclosure, Dot, KeyValues, Muted, Panel, ProofBlock } from "@/components/app/blocks"
import type { Approval, Tier } from "@/data/fixtures"
import { decide, useActions } from "@/lib/actions"

/*
 * The one approval. Our differentiator, so it reads as one question and two
 * buttons: dot + "Needs your OK" + the plain ask + Approve/Deny. Everything a
 * reviewer rarely needs (raw payload, rule, judge, rollback, fingerprint) folds
 * behind "Details", closed. Resolved or stopped shrinks to one line.
 * Shared by the run panel and the chat stream. See docs/restraint.md.
 */

const TIER_WORD: Record<Tier, string> = {
  P: "look only",
  S: "safe test",
  I: "intrusive test",
  F: "fork only",
}

export function ApprovalCard({ approval }: { approval: Approval }) {
  const toasts = Toast.useToastManager()
  const actions = useActions()
  const decision = actions.decisions[approval.id]
  const stopped = actions.stop !== null && !decision
  const closed = Boolean(decision) || stopped

  function choose(kind: "approved" | "denied") {
    decide(approval.id, kind)
    toasts.add({
      title: kind === "approved" ? `Approved step ${approval.step} once` : `Denied step ${approval.step}`,
      description: `Written to the audit log. Fingerprint ${approval.fingerprint}.`,
    })
  }

  // Resolved or stopped: one quiet history line, no card weight.
  if (closed) {
    return (
      <div className="flex items-center gap-(--space-s) type-s">
        <Dot tone={decision?.kind === "approved" ? "success" : "muted"} />
        <span className="min-w-0 flex-1">
          {decision
            ? decision.kind === "approved"
              ? `You approved step ${approval.step} ${decision.scope === "run" ? "for this run" : "once"} at ${decision.at}.`
              : `You denied step ${approval.step} at ${decision.at}. It was skipped.`
            : `You stopped the run before deciding. Step ${approval.step} did not run.`}
        </span>
      </div>
    )
  }

  return (
    <Panel role="region" aria-labelledby="run-approval-title" className="gap-(--space-m) p-(--space-m)">
      <div className="flex flex-wrap items-center gap-(--space-s)">
        <Dot tone="warning" />
        <h3 id="run-approval-title" className="type-s weight-medium">
          Needs your OK: step {approval.step}
        </h3>
        <span className="ml-auto inline-flex items-center gap-(--space-xxs) type-xs text-(--cte-text-muted)">
          <ThemedIcon name="timer" />
          Auto-deny at <span className="font-data">{approval.autoDeny}</span>
        </span>
      </div>
      <p className="type-s">{approval.plain}</p>
      <div className="flex flex-wrap items-center gap-(--space-s)">
        <Button onClick={() => choose("approved")}>Approve once</Button>
        <Button variant="outline" onClick={() => choose("denied")}>
          Deny
        </Button>
        <Muted className="type-xs">This step only.</Muted>
      </div>
      <Disclosure summary="Details">
        <KeyValues
          rows={[
            [
              "Raw",
              <ProofBlock key="raw" className="break-all whitespace-pre-wrap">
                {approval.raw}
              </ProofBlock>,
            ],
            ["Target", approval.target],
            ["Tier", `${approval.tier}, ${TIER_WORD[approval.tier]}`],
            ["Run mode", approval.runMode],
            [
              "Rule",
              <span key="rule">
                <span className="font-data">{approval.ruleId}</span> {approval.rule}
              </span>,
            ],
            ["Judge", approval.judge],
            ["Impact", approval.impact],
            ["Rollback", approval.rollback],
            ["Fingerprint", <span key="fingerprint" className="font-data">{approval.fingerprint}</span>],
          ]}
        />
      </Disclosure>
    </Panel>
  )
}
