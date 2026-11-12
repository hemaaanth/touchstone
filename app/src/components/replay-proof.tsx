import type { ReactNode } from "react"
import { ArrowRight, Check } from "lucide-react"
import type { Balance, Finding, FindingBase, Proof, Transfer } from "@/lib/types"
import { formatNum } from "@/lib/format"
import { cn } from "cn"
import { Separator } from "@/components/ui/separator"
import { Block, CopyButton, ExportReport, Fold, RunDetails, Verdict, WhyItWorks } from "./proof-parts"
import { HttpProofCard } from "./http-proof"
import { EvidenceProofCard } from "./evidence-proof"

// The printed replay proof for a recorded finding. A finding's proof kind picks
// the card: forge (the Foundry replay below), http, or evidence. The shared
// parts (verdict, folds, explanation, run details) live in proof-parts.tsx.
//
// The forge card: the hero verdict, the static / fuzz leads that fed the agent,
// the money the exploit moved, the lines the replay logged and checked, the
// command to reproduce it, and the agent's own explanation with its code
// highlighted. Green shows ONLY on the hero and the passing checks, and ONLY
// because a sandbox Foundry replay passed; everything else stays monochrome.

// A single PoC attempt. The engine ran the exploit twice: the first failed, the
// second passed. Both show — the failure is part of the proof. Monochrome: the
// pass gets weight, never a hue.
function RunRow({ n, pass, gas }: { n: number; pass: boolean; gas: number | null }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="font-mono text-muted-foreground">#{n}</span>
      <span className={cn("font-mono", pass ? "font-medium text-foreground" : "text-muted-foreground")}>
        {pass ? "PASS" : "FAIL"}
      </span>
      <span className="font-mono text-muted-foreground">gas {formatNum(gas)}</span>
    </div>
  )
}

function BalanceDelta({ label, before, after }: Balance) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1.5 font-mono text-sm text-foreground">
        <span className="tabular-nums">{before}</span>
        <ArrowRight className="size-3.5 text-muted-foreground" />
        <span className="font-medium tabular-nums">{after ?? "—"}</span>
      </div>
    </div>
  )
}

// One address's signed net ETH move, read by the engine from the real trace of
// the proving replay. The +/- in `net` carries the direction, so the figure
// stays monochrome; the party that ended richer gets weight so the eye lands on
// where the money went. The address rides along quietly as the ground truth.
function TransferDelta({ label, address, net, gained }: Transfer) {
  const shortAddr = address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span
        className={cn(
          "font-mono text-sm tabular-nums",
          gained ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        {net}
      </span>
      <span className="font-mono text-[11px] text-muted-foreground">{shortAddr}</span>
    </div>
  )
}

function ForgeProofCard({ finding, children }: { finding: FindingBase & { proof: Proof }; children?: ReactNode }) {
  const { proof } = finding
  const proven = finding.stages.proven && proof.pass

  return (
    <div className="flex flex-col gap-5">
      {/* Hero verdict — green only because the replay passed on a sandbox fork. */}
      <Verdict
        proven={proven}
        line={`${proof.pass ? "PASS" : "FAIL"} · ${proof.test} · gas ${formatNum(proof.gas)} · ${proof.compiler}`}
      />

      {/* The static pre-pass that pointed the agent here. A suspect list is only
          a lead — neutral, never green. The green verdict above is the replay's
          alone. Where both engines agree we mark it; agreement raises rank, it
          never substitutes for the replay. */}
      {finding.staticScan ? (
        <Block title="Static analysis led here">
          <p className="text-xs text-muted-foreground">
            {finding.staticScan.tool} flagged {finding.staticScan.suspects} suspect
            {finding.staticScan.suspects === 1 ? "" : "s"} before the agent started
            {finding.staticScan.engines.length > 1
              ? ` — ${finding.staticScan.engines.join(" and ")} ran as independent engines`
              : ""}
            . A suspect is only a lead — the replay above is what proved it.
          </p>
          <ul className="flex flex-col gap-1.5">
            {finding.staticScan.top.slice(0, 3).map((s, i) => (
              <li key={`${s.check}-${i}`} className="flex flex-wrap items-center gap-x-2 font-mono text-xs">
                <span className="text-muted-foreground">[{s.impact}]</span>
                <span className="text-foreground">{s.check}</span>
                {s.where ? (
                  <span className="text-muted-foreground">
                    {s.where}
                    {s.line ? ` (line ${s.line})` : ""}
                  </span>
                ) : null}
                {s.corroborated ? (
                  <span className="text-muted-foreground" title={`Flagged independently by ${s.engines.join(" and ")}`}>
                    · {s.engines.join(" + ")} agree
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </Block>
      ) : null}

      {/* Fuzzing led here — the same feeder → proof story for an accounting bug.
          Neutral, never green: a broken invariant is a suspect, not a finding. */}
      {finding.fuzzScan ? (
        <Block title="Fuzzing led here">
          <p className="text-xs text-muted-foreground">
            {finding.fuzzScan.tool} broke {finding.fuzzScan.suspects} invariant
            {finding.fuzzScan.suspects === 1 ? "" : "s"} from ordinary deposits and withdrawals before the agent started
            {finding.fuzzScan.engines.length > 1
              ? ` — ${finding.fuzzScan.engines.join(" and ")} ran as independent engines`
              : ""}
            . A broken invariant is only a lead — the replay above is what proved it.
          </p>
          <ul className="flex flex-col gap-2">
            {finding.fuzzScan.top.slice(0, 3).map((s, i) => (
              <li key={`${s.property}-${i}`} className="flex flex-col gap-1 font-mono text-xs">
                <span className="flex flex-wrap items-center gap-x-2">
                  <span className="text-muted-foreground">[{s.impact}]</span>
                  <span className="text-foreground">{s.check}</span>
                  {s.where ? <span className="text-muted-foreground">{s.where}</span> : null}
                  <span className="text-muted-foreground">({s.property})</span>
                  {s.corroborated ? (
                    <span className="text-muted-foreground" title={`Broken independently by ${s.engines.join(" and ")}`}>
                      · {s.engines.join(" + ")} agree
                    </span>
                  ) : null}
                </span>
                {s.sequence.length > 0 ? (
                  <span className="text-muted-foreground">{s.sequence.join(" → ")}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </Block>
      ) : null}

      {/* What the exploit moved. Preferred source is the engine's structured proof
          delta: the real signed net ETH per address, read straight from the
          Foundry trace of the proving replay — machine truth, not source text.
          Older runs fall back to the source-derived before→after balances. */}
      {proof.transfers.length > 0 ? (
        <Block title="What the exploit moved">
          <p className="text-xs text-muted-foreground">
            Net ETH each address moved, read from the real replay trace — not the test's source.
          </p>
          <div className="flex flex-wrap gap-8">
            {proof.transfers.map((t) => (
              <TransferDelta key={t.address} {...t} />
            ))}
          </div>
        </Block>
      ) : proof.balances.length > 0 ? (
        <Block title="What the exploit moved">
          <div className="flex flex-wrap gap-8">
            {proof.balances.map((b) => (
              <BalanceDelta key={b.label} {...b} />
            ))}
          </div>
        </Block>
      ) : null}

      {/* The real runtime lines the proving test logged, decoded by forge from
          the replay — the exploit's own words. Shown only when the replay proved. */}
      {proven && proof.logs.length > 0 ? (
        <Block title="Replay logged">
          <ul className="flex flex-col gap-1">
            {proof.logs.map((line, i) => (
              <li key={i} className="font-mono text-xs text-muted-foreground">
                {line}
              </li>
            ))}
          </ul>
        </Block>
      ) : null}

      {/* The passing assertions — the literal conditions the replay checked. */}
      {proven && proof.assertions.length > 0 ? (
        <Block title="Replay checked">
          <ul className="flex flex-col gap-1.5">
            {proof.assertions.map((a) => (
              <li key={a} className="flex items-start gap-1.5 font-mono text-xs text-muted-foreground">
                <Check className="mt-0.5 size-3.5 shrink-0 text-ok" />
                <span className="min-w-0 break-words">{a}</span>
              </li>
            ))}
          </ul>
        </Block>
      ) : null}

      {/* Reproduce it yourself. */}
      {proof.rerunCommand ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-foreground">Reproduce it yourself</span>
          <p className="text-xs text-muted-foreground">
            Run this in the generated Foundry project to replay the exploit and watch the same assertions pass.
          </p>
          <div className="mt-1 flex items-center justify-between gap-2 rounded-md bg-muted px-4 py-2">
            <code className="min-w-0 truncate font-mono text-xs text-foreground">{proof.rerunCommand}</code>
            <CopyButton value={proof.rerunCommand} />
          </div>
        </div>
      ) : null}

      <Separator />

      <WhyItWorks explanation={finding.explanation} />

      {/* Secondary detail — one consistent fold vocabulary, closed by default. */}
      <div className="flex flex-col gap-1 border-t pt-4">
        <RunDetails
          finding={finding}
          extra={
            proof.runs.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">Replay attempts</span>
                {proof.runs.map((r) => (
                  <RunRow key={r.n} n={r.n} pass={r.pass} gas={r.gas} />
                ))}
              </div>
            ) : null
          }
        />

        {proof.runs.length > 0 ? (
          <Fold label="Raw replay output">
            <div className="flex flex-col gap-4">
              {proof.runs.map((r) => (
                <pre
                  key={r.n}
                  className="overflow-x-auto rounded-md bg-muted p-4 font-mono text-[11px] leading-relaxed text-muted-foreground"
                >
                  {r.raw}
                </pre>
              ))}
            </div>
          </Fold>
        ) : null}
        {children}
      </div>
    </div>
  )
}

export function ReplayProof({ finding, children }: { finding: Finding; children?: ReactNode }) {
  // Every proof kind ends with the same shareable-report action, below the
  // card's own children, built from this recorded finding's id.
  const footer = (
    <>
      {children}
      <ExportReport findingId={finding.id} />
    </>
  )
  if (finding.proofKind === "http") return <HttpProofCard finding={finding}>{footer}</HttpProofCard>
  if (finding.proofKind === "evidence") return <EvidenceProofCard finding={finding}>{footer}</EvidenceProofCard>
  return <ForgeProofCard finding={finding}>{footer}</ForgeProofCard>
}
