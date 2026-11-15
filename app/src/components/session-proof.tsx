import type { ReactNode } from "react"
import type { FindingBase, HttpExchange, SessionProof } from "@/lib/types"
import { Separator } from "@/components/ui/separator"
import { Block, Fold, RunDetails, Verdict, WhyItWorks } from "./proof-parts"

// The proof card for a machine-layer finding (host, crypto, forensics, binary).
// The replay ran the finding's shell script against a fresh target on a private
// network with a new random flag planted behind the bug, and the oracle read what
// the script printed. Shows the oracle's result, then the replayed script and its
// output. Green only on the verdict.

function CommandLine({ x }: { x: HttpExchange }) {
  const first = (x.request.body ?? "").split("\n").find((l) => l.trim() && !l.trim().startsWith("#"))?.trim()
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 font-mono text-xs">
      <span className="text-muted-foreground">{x.label}</span>
      <span className="min-w-0 break-all text-foreground">{first ?? "(empty script)"}</span>
      <span className="text-muted-foreground">→ exit {x.response.status ?? "?"}</span>
    </li>
  )
}

function CommandLog({ x }: { x: HttpExchange }) {
  const body = "overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-[11px] leading-relaxed text-muted-foreground"
  return (
    <div className="flex flex-col gap-3">
      <span className="text-xs font-medium text-foreground">{x.label}</span>
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] text-muted-foreground">Replayed script</span>
        <pre className={body}>{x.request.body ?? ""}</pre>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] text-muted-foreground">Output (exit {x.response.status ?? "?"})</span>
        <pre className={body}>{x.response.body ?? "(no output)"}</pre>
      </div>
    </div>
  )
}

export function SessionProofCard({ finding, children }: { finding: FindingBase & { proof: SessionProof }; children?: ReactNode }) {
  const { proof } = finding
  const proven = finding.stages.proven && proof.pass
  const rows = proof.commands ?? []
  return (
    <div className="flex flex-col gap-5">
      <Verdict proven={proven} line={`${proof.pass ? "PASS" : "FAIL"} · oracle${proof.oracle.name ? ` ${proof.oracle.name}` : ""} · ${rows.length} replay${rows.length === 1 ? "" : "s"}`} />

      {proof.oracle.detail ? (
        <Block title="What the oracle checked">
          <p className="text-sm leading-relaxed text-muted-foreground">{proof.oracle.detail}</p>
        </Block>
      ) : null}

      {rows.length > 0 ? (
        <Block title="What the replay ran">
          <ul className="flex flex-col gap-1.5">
            {rows.map((x, i) => (
              <CommandLine key={i} x={x} />
            ))}
          </ul>
        </Block>
      ) : null}

      <Separator />
      <WhyItWorks explanation={finding.explanation} />

      <div className="flex flex-col gap-1 border-t pt-4">
        <RunDetails finding={finding} />
        {rows.length > 0 ? (
          <Fold label="Replayed script and output">
            <div className="flex flex-col gap-6">
              {rows.map((x, i) => (
                <CommandLog key={i} x={x} />
              ))}
            </div>
          </Fold>
        ) : null}
        {children}
      </div>
    </div>
  )
}
