import { useEffect, useRef, useState } from "react"
import { Button, Toast } from "@graphical"
import { Muted, Scroll, Tag } from "@/components/app/blocks"
import { CardFrame } from "@/components/app/cards"
import { AgentTurn, Composer, YouTurn } from "@/components/app/chat"
import { FIRST_RUN_AFTER_CONFIRM, FIRST_RUN_CHAT, FIRST_RUN_PLAN, moduleByKey, type ChatMessage } from "@/data/fixtures"
import { useActions } from "@/lib/actions"
import { useWords } from "@/lib/words"

/*
 * First run (W-1), fixed per A9 and C7.
 *   1. Setup checks: NEAR AI, sandbox provider, self-test, PII filter.
 *   2. You add one repo and one domain.
 *   3. The agent finds the access per asset and says why.
 *   4. Scope proposal. You confirm by typing "Acme Protocol".
 *   5. Plan 1, look-only steps.
 * The top bar shows "Run mode: Observe" the whole time. Confirm approves no step.
 * Confirm goes to the shared store (lib/actions.ts). Plan 1 and the turns
 * after it are FIRST_RUN_PLAN and FIRST_RUN_AFTER_CONFIRM in the fixtures.
 */

const PROPOSAL_ID = "first-run"

export function FirstRun() {
  const done = useActions().confirmed.includes(PROPOSAL_ID)
  const planRef = useRef<HTMLDivElement>(null)
  const [youTurn, agentTurn] = FIRST_RUN_AFTER_CONFIRM

  useEffect(() => {
    if (done) planRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [done])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Scroll>
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-(--space-l) px-(--space-xl) py-(--space-xl)">
          {FIRST_RUN_CHAT.map((message, index) => <Turn key={index} message={message} />)}
          {done ? (
            <>
              {youTurn ? <YouTurn message={youTurn} /> : null}
              <div ref={planRef} className="flex scroll-mt-(--space-xl) flex-col gap-(--space-s)">
                {agentTurn ? <AgentTurn message={agentTurn} /> : null}
                <PlanOne />
              </div>
            </>
          ) : null}
        </div>
      </Scroll>
      <div className="shrink-0 bg-(--cte-surface) divide-top">
        <div className="mx-auto w-full max-w-[720px] px-(--space-xl) py-(--space-s)">
          <Composer placeholder={done ? "Ask the agent about Plan 1" : "Add a repo or a domain, or ask the agent"} />
        </div>
      </div>
    </div>
  )
}

function Turn({ message }: { message: ChatMessage }) {
  return message.role === "you" ? <YouTurn message={message} /> : <AgentTurn message={message} />
}

/** Plan 1. Look-only steps in Observe. Starting it is a mock. */
function PlanOne() {
  const { pick } = useWords()
  const toasts = Toast.useToastManager()
  const [started, setStarted] = useState(false)

  return (
    <CardFrame
      title="Plan 1"
      tone={started ? "accent" : undefined}
      meta={`Run mode: Observe · ${FIRST_RUN_PLAN.length} steps · all look only · ${started ? "Waiting for the self-test" : "Not started"}`}
      actions={
        started ? (
          <Muted className="type-xs">Queued. It starts when the sandbox self-test passes.</Muted>
        ) : (
          <>
            <Button
              onClick={() => {
                setStarted(true)
                toasts.add({
                  title: "Plan 1 queued",
                  description: "It starts when the sandbox self-test passes. This mockup does not run it.",
                })
              }}
            >
              Start Plan 1
            </Button>
            <Muted className="type-xs">No step needs approval. Each step runs in a sandbox, never on your machine.</Muted>
          </>
        )
      }
    >
      <ol className="flex flex-col">
        {FIRST_RUN_PLAN.map((step) => (
          <li
            key={step.n}
            className="flex items-baseline gap-(--space-s) py-(--space-xs) first:pt-0 last:pb-0 not-last:divide-bottom"
          >
            <span className="w-(--space-m) shrink-0 font-data tabular-nums text-(--cte-text-muted)">{step.n}</span>
            <span className="flex min-w-0 flex-1 flex-col gap-(--space-xxs)">
              <span>{pick(step.plain, step.technical)}</span>
              <Muted className="type-xs">
                {step.module ? `${moduleByKey(step.module)?.name ?? step.module} · ` : null}
                {step.profile} sandbox
              </Muted>
            </span>
            <Tag>{pick("Look only", `Tier ${step.tier}`)}</Tag>
          </li>
        ))}
      </ol>
      <ul className="flex flex-col gap-(--space-xxs) type-xs">
        <li>acme.xyz stays Look only until its DNS TXT proof passes.</li>
        <li>Safe tests on acme/contracts and the Vault need Run mode Safe. You can change it after Plan 1.</li>
      </ul>
    </CardFrame>
  )
}
