import { useState } from "react"
import { Button, ThemedIcon } from "@graphical"
import type { ModelChoice, SpendState, TargetChoice } from "@/lib/types"

// Let the server choose the scope at random. Selecting this is how the operator
// says "don't overfit — surprise me," which is the default.
const RANDOM = "__random__"

type Option = { id: string; title: string; blurb: string; kind: string }

// There is one active model; keep its alias without asking. The operator's one
// real choice here is the scope: which target from the library this module is
// pointed at. Random is the default so repeated Runs stop re-breaking one bug.
export function RunLauncher({
  models,
  targets,
  spend,
  busy,
  error,
  onStart,
}: {
  models: ModelChoice[]
  targets: TargetChoice[]
  spend: SpendState | null
  busy: boolean
  error: string | null
  onStart: (alias: string, targetId?: string) => void
}) {
  const model = models[0]
  const capped = spend ? spend.usd >= spend.cap : false
  const runnable = targets.filter((t) => t.runnable)
  const [choice, setChoice] = useState<string>(RANDOM)

  const options: Option[] = [
    { id: RANDOM, title: "Random scope", blurb: "Pick a target at random each run so nothing overfits.", kind: "any" },
    ...runnable.map((t) => ({ id: t.id, title: t.title, blurb: t.blurb, kind: t.kind })),
  ]
  // A chosen scope that is no longer offered falls back to random.
  const active = options.some((o) => o.id === choice) ? choice : RANDOM

  return (
    <div className="flex flex-col gap-(--space-m)">
      <h1 className="type-m weight-medium text-(--cte-text)">New run</h1>
      <p className="type-s text-(--cte-text-muted)">
        Point one module at a scope from the target library. Only a passing replay can become a finding.
      </p>

      <div role="radiogroup" aria-label="Target scope" className="flex flex-col gap-(--space-xxs)">
        {options.map((o) => {
          const on = o.id === active
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setChoice(o.id)}
              className="focus-ring flex w-full min-w-0 flex-col gap-(--space-xxs) rounded-(--radius-m) p-(--space-m) text-left hover:bg-(--neutral-3)"
              style={on ? { background: "var(--neutral-3)" } : undefined}
            >
              <span className="flex min-w-0 items-center justify-between gap-(--space-s)">
                <span className="type-s weight-medium text-(--cte-text) truncate">{o.title}</span>
                <span className="shrink-0 type-xxs text-(--cte-text-muted)">{o.kind}</span>
              </span>
              <span className="type-xxs text-(--cte-text-muted)">{o.blurb}</span>
            </button>
          )
        })}
        {runnable.length === 0 ? (
          <p className="type-xxs text-(--cte-text-muted) p-(--space-s)">No runnable targets found.</p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-(--space-s)">
        <span className="type-xs text-(--cte-text-muted)">
          {model ? `${model.alias}${model.abliterated ? " · abliterated" : ""}` : "Loading model…"}
        </span>
        <Button
          variant="primary"
          disabled={busy || capped || !model}
          onClick={() => model && onStart(model.alias, active === RANDOM ? undefined : active)}
        >
          {busy ? <span className="motion-safe:animate-spin"><ThemedIcon name="loader" /></span> : <ThemedIcon name="play" />}
          {busy ? "Starting…" : "Run"}
        </Button>
      </div>
      {capped ? <p className="type-xs text-(--cte-text-muted)">Spend cap reached.</p> : null}
      {error ? <p role="alert" className="type-xs text-(--cte-text-muted)">{error}</p> : null}
    </div>
  )
}
