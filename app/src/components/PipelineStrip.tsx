import type { RunState } from "@/lib/runModel"
import type { Finding } from "@/lib/types"
import { pipelineModules } from "@/lib/pipeline"
import { Fold } from "./bits"

export function PipelineStrip({ run, finding = null }: { run: RunState; finding?: Finding | null }) {
  const modules = pipelineModules(run, finding)
  const scope = run.scope
  return (
    <section aria-label="Run pipeline" className="flex flex-col gap-(--space-s) px-(--space-xl) pb-(--space-m)">
      <dl className="grid gap-(--space-m) bg-(--neutral-2) p-(--space-m)" style={{ gridTemplateColumns: `repeat(${modules.length + 1}, minmax(0, 1fr))` }}>
        <div className="flex min-w-0 flex-col gap-(--space-xxs)">
          <dt className="type-xs weight-medium text-(--cte-text)">Scope</dt>
          <dd className="type-xs text-(--cte-text)">{scope ? ({ lab: "Lab", "local-source": "Local source", brief: "Brief" })[scope.kind] : finding ? "Saved target" : "No event"}</dd>
          <dd className="type-xxs text-(--cte-text-muted)">{scope?.title ?? finding?.target ?? "Not recorded"}</dd>
        </div>
        {modules.map((module) => (
          <div key={module.label} className="flex min-w-0 flex-col gap-(--space-xxs)">
            <dt className="type-xs weight-medium text-(--cte-text)">{module.label}</dt>
            <dd className={`type-xs ${module.passed ? "text-(--success)" : "text-(--cte-text)"}`}>{module.status}</dd>
            <dd className="type-xxs text-(--cte-text-muted)">{module.detail}</dd>
            <dd className="min-h-[calc(var(--line-xxs)*2)] type-xxs text-(--cte-text-muted)" aria-hidden={!module.agreement}>{module.agreement}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-col gap-(--space-xs)">
        <p className="type-xxs text-(--cte-text-muted)">Agreement ranks leads. Only replay proves a finding.</p>
        <Fold label="Pipeline evidence" className="w-full max-w-none [&_.ui-disclosure-panel]:max-h-[220px] [&_.ui-disclosure-panel]:overflow-y-auto [&_.ui-disclosure-panel]:rounded-(--radius-zero) [&_.ui-disclosure-panel]:bg-transparent [&_.ui-copy]:w-full [&_.ui-copy]:max-w-none">
          <dl className="grid grid-cols-2 gap-(--space-m) type-xs text-(--cte-text-muted)">
            {scope ? <div><dt className="weight-medium text-(--cte-text)">Proof surface</dt><dd>{scope.proofSurface.note}</dd></div> : null}
            {modules.map((module) => (
              <div key={module.label}>
                <dt className="weight-medium text-(--cte-text)">{module.label}</dt>
                <dd>{module.evidence}</dd>
              </div>
            ))}
          </dl>
        </Fold>
      </div>
    </section>
  )
}
