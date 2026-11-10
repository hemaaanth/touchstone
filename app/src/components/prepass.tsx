import type { PrepassView } from "@/lib/types"
import { Fold } from "@/components/proof-parts"

// What the pack's tools found before the agent started: one closed fold, the
// same for every pack. Leads are hints for the agent, not findings, so the
// fold is neutral: no green, no red. Only a replay earns a colour.

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function PrepassFold({ prepass }: { prepass: PrepassView }) {
  if (prepass.failed) {
    return (
      <div className="py-1 text-xs text-muted-foreground">
        Tool scan did not finish. The agent worked from the source alone.
      </div>
    )
  }
  const ran = prepass.tools.filter((t) => t.status === "ran").length
  const label =
    `Tool scan · ${plural(prepass.tools.length, "tool")}` +
    (prepass.tools.length > ran ? ` (${ran} ran)` : "") +
    ` · ${plural(prepass.total, "lead")}`
  const hidden = prepass.total - prepass.leads.length
  return (
    <Fold label={label}>
      <div className="flex flex-col gap-5">
        <ul className="flex flex-col gap-1.5">
          {prepass.tools.map((t, i) => (
            <li key={`${t.name}-${i}`} className="flex flex-wrap items-baseline gap-x-2 text-xs">
              <span className="font-medium text-foreground">{t.name}</span>
              <span className="text-muted-foreground">
                {t.status === "ran" ? `ran · ${plural(t.leads, "lead")}` : `unavailable${t.reason ? ` · ${t.reason}` : ""}`}
              </span>
            </li>
          ))}
        </ul>
        {prepass.leads.length > 0 ? (
          <ol className="flex flex-col gap-3">
            {prepass.leads.map((l, i) => (
              <li key={i} className="flex min-w-0 flex-col gap-0.5">
                <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
                  <span className="font-medium text-foreground">{l.check || "Lead"}</span>
                  {l.impact ? <span className="text-muted-foreground">{l.impact}</span> : null}
                  {l.corroborated ? <span className="text-muted-foreground">· corroborated</span> : null}
                </div>
                {l.where ? <span className="break-words font-mono text-[11px] text-muted-foreground">{l.where}</span> : null}
                {l.detail ? <span className="break-words text-xs text-muted-foreground">{l.detail}</span> : null}
                {l.tools.length ? <span className="text-[11px] text-muted-foreground/70">{l.tools.join(" + ")}</span> : null}
              </li>
            ))}
          </ol>
        ) : null}
        {hidden > 0 ? <span className="text-[11px] text-muted-foreground">{plural(hidden, "more lead")} not shown.</span> : null}
      </div>
    </Fold>
  )
}
