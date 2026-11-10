import type { ReactNode } from "react"
import type { FindingBase, HttpExchange, HttpProof } from "@/lib/types"
import { Separator } from "@/components/ui/separator"
import { Block, CellRows, Fold, RunDetails, Verdict, WhyItWorks } from "./proof-parts"

// The proof card for a web finding. The replay ran the request script against
// the practice service on a private network, and the oracle checked the harm in
// the responses. Shows the oracle's result, one line per request, and the full
// request and response log folded away. Green only on the verdict, because the
// replay passed.

function ExchangeLine({ x }: { x: HttpExchange }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 font-mono text-xs">
      <span className="text-muted-foreground">{x.label}</span>
      <span className="min-w-0 break-all text-foreground">
        {x.request.method} {x.request.url}
      </span>
      <span className="text-muted-foreground">→ {x.response.status ?? "no response"}</span>
    </li>
  )
}

function Raw({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] text-muted-foreground">{title}</span>
      {children}
    </div>
  )
}

function ExchangeLog({ x }: { x: HttpExchange }) {
  const body = "overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-[11px] leading-relaxed text-muted-foreground"
  return (
    <div className="flex flex-col gap-3">
      <span className="text-xs font-medium text-foreground">{x.label}</span>
      <Raw title="Request">
        <p className="break-all font-mono text-xs text-foreground">
          {x.request.method} {x.request.url}
        </p>
        {x.request.headers.length > 0 ? <CellRows cells={x.request.headers} /> : null}
        {x.request.body ? <pre className={body}>{x.request.body}</pre> : null}
      </Raw>
      <Raw title={`Response${x.response.status != null ? ` ${x.response.status}` : ""}`}>
        {x.response.headers.length > 0 ? <CellRows cells={x.response.headers} /> : null}
        {x.response.body ? <pre className={body}>{x.response.body}</pre> : null}
      </Raw>
    </div>
  )
}

export function HttpProofCard({ finding, children }: { finding: FindingBase & { proof: HttpProof }; children?: ReactNode }) {
  const { proof } = finding
  const proven = finding.stages.proven && proof.pass
  return (
    <div className="flex flex-col gap-5">
      <Verdict
        proven={proven}
        line={`${proof.pass ? "PASS" : "FAIL"} · oracle${proof.oracle.name ? ` ${proof.oracle.name}` : ""} · ${proof.exchanges.length} request${proof.exchanges.length === 1 ? "" : "s"}`}
      />

      {proof.oracle.detail ? (
        <Block title="What the oracle checked">
          <p className="text-sm leading-relaxed text-muted-foreground">{proof.oracle.detail}</p>
        </Block>
      ) : null}

      {proof.exchanges.length > 0 ? (
        <Block title="Requests the replay sent">
          <ul className="flex flex-col gap-1.5">
            {proof.exchanges.map((x, i) => (
              <ExchangeLine key={i} x={x} />
            ))}
          </ul>
        </Block>
      ) : null}

      <Separator />
      <WhyItWorks explanation={finding.explanation} />

      <div className="flex flex-col gap-1 border-t pt-4">
        <RunDetails finding={finding} />
        {proof.exchanges.length > 0 ? (
          <Fold label="Request and response log">
            <div className="flex flex-col gap-6">
              {proof.exchanges.map((x, i) => (
                <ExchangeLog key={i} x={x} />
              ))}
            </div>
          </Fold>
        ) : null}
        {children}
      </div>
    </div>
  )
}
