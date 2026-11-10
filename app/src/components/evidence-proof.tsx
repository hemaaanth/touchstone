import type { ReactNode } from "react"
import type { EvidenceProof, FindingBase } from "@/lib/types"
import { Separator } from "@/components/ui/separator"
import { Block, CellRows, RunDetails, Stat, Verdict, WhyItWorks, shortHash } from "./proof-parts"

// The proof card for an evidence finding (supply chain, secrets, domains,
// surface). The finding cites evidence; the replay checked it again against the
// snapshot pinned before the agent started. Secrets show redacted with their
// hash, never whole. Green only on the verdict, because the replay passed.

export function EvidenceProofCard({ finding, children }: { finding: FindingBase & { proof: EvidenceProof }; children?: ReactNode }) {
  const { proof } = finding
  const proven = finding.stages.proven && proof.pass
  return (
    <div className="flex flex-col gap-5">
      <Verdict
        proven={proven}
        line={`${proof.pass ? "PASS" : "FAIL"} · ${proof.check || "evidence check"}${proof.snapshotHash ? ` · snapshot ${shortHash(proof.snapshotHash)}` : ""}`}
      />

      {proof.cited.length > 0 ? (
        <Block title="Evidence cited">
          <CellRows cells={proof.cited} />
        </Block>
      ) : null}

      {proof.detail ? (
        <Block title="Replay result">
          <p className="text-sm leading-relaxed text-muted-foreground">{proof.detail}</p>
        </Block>
      ) : null}

      <Separator />
      <WhyItWorks explanation={finding.explanation} />

      <div className="flex flex-col gap-1 border-t pt-4">
        <RunDetails
          finding={finding}
          extra={
            <div className="flex flex-wrap gap-8">
              {proof.snapshotHash ? (
                <Stat label="Snapshot sha256">
                  <span className="break-all font-mono">{proof.snapshotHash}</span>
                </Stat>
              ) : null}
              {proof.commit ? (
                <Stat label="Commit">
                  <span className="font-mono">{proof.commit}</span>
                </Stat>
              ) : null}
            </div>
          }
        />
        {children}
      </div>
    </div>
  )
}
