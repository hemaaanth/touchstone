import { ThemedIcon } from "@graphical"
import type { Step } from "@/lib/runModel"

// A neutral dot records an ordinary step. Only a passing replay earns a check.
// An operator message is marked with a filled accent dot, so a steer stands out
// from the agent's own steps at a glance down the spine.
function StepMark({ step }: { step: Step }) {
  const replay = step.kind === "poc"
  if (step.kind === "operator") {
    return (
      <span className="grid size-(--space-xl) shrink-0 place-items-center" aria-hidden="true">
        <span className="size-(--space-s) rounded-(--radius-full) bg-(--cte-accent)" />
      </span>
    )
  }
  return (
    <span className={`grid size-(--space-xl) shrink-0 place-items-center ${replay && step.state === "pass" ? "text-(--success)" : "text-(--cte-text-muted)"}`} aria-hidden="true">
      {replay ? (
        <span className={step.state === "running" ? "motion-safe:animate-spin" : undefined}>
          <ThemedIcon name={step.state === "running" ? "loader" : step.state === "pass" ? "check" : "minus"} />
        </span>
      ) : (
        <span className="size-(--space-xs) rounded-(--radius-full) bg-(--neutral-6)" />
      )}
    </span>
  )
}

function StepRow({ step, last }: { step: Step; last: boolean }) {
  // The operator's own words, set apart as a message bubble so the transcript
  // reads as a dialogue — the agent's steps on the spine, the human's steers
  // called out on a faint wash.
  if (step.kind === "operator") {
    return (
      <li className="flex gap-(--space-s)">
        <div className="flex shrink-0 flex-col items-center">
          <StepMark step={step} />
          {last ? null : <span className="w-px flex-1 bg-(--neutral-5)" />}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-(--space-xxs) pb-(--space-s)">
          <span className="type-xxs weight-medium text-(--cte-text-muted)">You steered the run</span>
          <p
            className="type-s text-(--cte-text)"
            style={{
              background: "var(--code-surface)",
              boxShadow: "inset 0 0 0 1px var(--code-border)",
              borderRadius: "var(--radius-m)",
              padding: "var(--space-xs) var(--space-s)",
            }}
          >
            {step.label}
          </p>
        </div>
      </li>
    )
  }
  const detail = [step.contract, step.detail ?? (step.kind === "poc" && step.state === "running" ? "Replay running…" : null)].filter(Boolean).join(" · ")
  return (
    <li className="flex min-h-[calc(var(--line-s)*2+var(--space-s)*2)] gap-(--space-s)">
      <div className="flex shrink-0 flex-col items-center">
        <StepMark step={step} />
        {last ? null : <span className="w-px flex-1 bg-(--neutral-5)" />}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-(--space-xxs) pb-(--space-s)">
        <div className="flex flex-wrap items-center gap-x-(--space-s)">
          <span className="type-s text-(--cte-text)">{step.label}</span>
          {step.kind === "poc" && step.state === "pass" ? <span className="type-xxs weight-medium text-(--success)">PASS</span> : null}
          {step.kind === "poc" && step.state === "fail" ? <span className="type-xxs text-(--cte-text-muted)">Did not pass</span> : null}
        </div>
        <p className="min-h-(--line-xs) type-xs text-(--cte-text-muted)">{detail}</p>
      </div>
    </li>
  )
}

export function RunTimeline({ steps }: { steps: Step[] }) {
  if (steps.length === 0) {
    return <p className="type-xs text-(--cte-text-muted)">Starting the agent and warming the sandbox…</p>
  }
  return (
    <ol className="flex flex-col" aria-label="Agent steps">
      {steps.map((step, i) => <StepRow key={step.key} step={step} last={i === steps.length - 1} />)}
    </ol>
  )
}
