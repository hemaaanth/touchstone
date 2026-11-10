import { Button, ThemedIcon } from "@graphical"
import type { ModelChoice, SpendState } from "@/lib/types"

// There is one active model. Keep its server alias without asking the operator
// to choose it, and never submit before the model list has loaded.
export function RunLauncher({
  models,
  spend,
  busy,
  error,
  onStart,
}: {
  models: ModelChoice[]
  spend: SpendState | null
  busy: boolean
  error: string | null
  onStart: (alias: string) => void
}) {
  const model = models[0]
  const capped = spend ? spend.usd >= spend.cap : false

  return (
    <div className="flex flex-col gap-(--space-m)">
      <h1 className="type-m weight-medium text-(--cte-text)">New run</h1>
      <p className="type-s text-(--cte-text-muted)">
        Attack Vault.sol in a sandbox. Only a passing replay can become a finding.
      </p>
      <div className="flex flex-wrap items-center justify-between gap-(--space-s)">
        <span className="type-xs text-(--cte-text-muted)">
          {model ? `${model.alias}${model.abliterated ? " · abliterated" : ""}` : "Loading model…"}
        </span>
        <Button variant="primary" disabled={busy || capped || !model} onClick={() => model && onStart(model.alias)}>
          {busy ? <span className="motion-safe:animate-spin"><ThemedIcon name="loader" /></span> : <ThemedIcon name="play" />}
          {busy ? "Starting…" : "Run"}
        </Button>
      </div>
      {capped ? <p className="type-xs text-(--cte-text-muted)">Spend cap reached.</p> : null}
      {error ? <p role="alert" className="type-xs text-(--cte-text-muted)">{error}</p> : null}
    </div>
  )
}
