import { Button, ThemedIcon } from "@graphical"
import type { ModelChoice, SpendState, TargetChoice } from "@/lib/types"

export function RunLauncher({ models, scope, hasTargets, spend, busy, error, onStart }: {
  models: ModelChoice[]
  scope: TargetChoice | null
  hasTargets: boolean
  spend: SpendState | null
  busy: boolean
  error: string | null
  onStart: (alias: string, targetId?: string) => void
}) {
  const model = models[0]
  const capped = spend ? spend.usd >= spend.cap : false
  return (
    <div className="flex flex-col gap-(--space-m)">
      <div className="flex flex-wrap items-center justify-between gap-(--space-s)">
        <div className="flex min-w-0 flex-col gap-(--space-xs)">
          <h1 className="type-m weight-medium text-(--cte-text)">New run</h1>
          <p className="type-xs text-(--cte-text-muted)">Contracts · {scope?.title ?? "Random scope"}</p>
        </div>
        <Button variant="primary" disabled={busy || capped || !model || !hasTargets} onClick={() => model && onStart(model.alias, scope?.id)}>
          {busy ? <span className="motion-safe:animate-spin"><ThemedIcon name="loader" /></span> : <ThemedIcon name="play" />}
          {busy ? "Starting…" : "Run"}
        </Button>
      </div>
      <span className="type-xs text-(--cte-text-muted)">{model ? `${model.alias}${model.abliterated ? " · abliterated" : ""}` : "Loading model…"}</span>
      {!hasTargets ? <p className="type-xs text-(--cte-text-muted)">No runnable scopes available.</p> : null}
      {capped ? <p className="type-xs text-(--cte-text-muted)">Spend cap reached.</p> : null}
      {error ? <p role="alert" className="type-xs text-(--cte-text-muted)">{error}</p> : null}
    </div>
  )
}
