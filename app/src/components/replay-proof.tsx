import { useState, type ReactNode } from "react"
import { ArrowRight, Check, ChevronRight, Copy, Info } from "lucide-react"
import type { Balance, Finding, Transfer } from "@/lib/types"
import { formatNum, formatUsd } from "@/lib/format"
import { explanationSections, inlineParts } from "@/lib/explanation"
import { tokenize, type TokenClass } from "@/lib/highlight"
import { cn } from "cn"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"

// The printed replay proof for a recorded finding: the hero verdict, the static
// / fuzz leads that fed the agent, the money the exploit moved, the lines the
// replay logged and checked, the command to reproduce it, and the agent's own
// explanation with its code highlighted. Ported to base-nova from the original
// Touchstone detail panel. One accent meaning holds: green shows ONLY on the
// hero and the passing checks, and ONLY because a sandbox Foundry replay passed;
// everything else — including the highlighted code — stays monochrome.

// Copies the real text and confirms inline — no toast plumbing.
function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 shrink-0 gap-1.5 px-2 text-xs"
      onClick={() => {
        void navigator.clipboard?.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : label}
    </Button>
  )
}

// One disclosure pattern for every folded section — Run details, Raw replay
// output. Same chevron (rotates down when open), same quiet label. Closed by
// default; progressive disclosure per restraint.md.
function Fold({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[panel-open]:rotate-90" />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pt-4 pl-[22px]">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

// A label / value pair used across the proof meta.
function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="text-xs text-foreground">{children}</span>
    </div>
  )
}

// A section with a quiet heading. Every proof block shares this frame so the
// report reads as one stack instead of a pile of differently-weighted titles.
function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-foreground">{title}</span>
      {children}
    </div>
  )
}

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

// Render a prose line's inline markdown (`code`, **bold**, *italic*) so none of
// it reaches the screen as raw markers. Inline `code` reads as code in an
// outlined chip so it stands apart from the surrounding prose.
function Prose({ text }: { text: string }) {
  return (
    <p className="text-sm leading-relaxed text-muted-foreground">
      {inlineParts(text).map((p, j) =>
        p.kind === "code" ? (
          <code
            key={j}
            className="rounded border bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground"
          >
            {p.value}
          </code>
        ) : p.kind === "strong" ? (
          <strong key={j} className="font-medium text-foreground">
            {p.value}
          </strong>
        ) : p.kind === "em" ? (
          <em key={j}>{p.value}</em>
        ) : (
          <span key={j}>{p.value}</span>
        ),
      )}
    </p>
  )
}

// Syntax token → a restrained utility. Monochrome by design: differentiation
// comes from weight and opacity, never hue, so the one-accent rule holds inside
// code too (the highlighter never drags its own colour theme in to fight ours).
const SYNTAX: Record<TokenClass, string> = {
  keyword: "font-medium text-foreground",
  type: "text-foreground/90",
  string: "text-muted-foreground",
  number: "text-foreground/80",
  comment: "text-muted-foreground/60 italic",
  text: "",
}

// A fenced code block from the explanation, in monospace and highlighted for
// the language the engine tagged on the fence (```solidity, ```ts, …). The
// language rides along as a quiet label.
function CodeBlock({ lang, text }: { lang: string | null; text: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      {lang ? <span className="font-mono text-[11px] text-muted-foreground">{lang}</span> : null}
      <pre className="overflow-x-auto rounded-md bg-muted p-4 font-mono text-xs leading-relaxed text-foreground">
        <code>
          {tokenize(text, lang).map((t, i) =>
            t.cls === "text" ? t.value : (
              <span key={i} className={SYNTAX[t.cls]}>
                {t.value}
              </span>
            ),
          )}
        </code>
      </pre>
    </div>
  )
}

export function ReplayProof({ finding, children }: { finding: Finding; children?: ReactNode }) {
  const { proof, usage } = finding
  const proven = finding.stages.proven && proof.pass
  // Parse the explanation once. The newer engine format opens with its own
  // section heading (## What goes wrong, …); the older one opens with plain
  // prose. We drop the generic "Why it works" label only when the explanation
  // leads with its own heading — otherwise that label would read as a header
  // with nothing under it.
  const sections = finding.explanation ? explanationSections(finding.explanation) : []
  const leadsWithHeading = sections[0]?.kind === "prose" && Boolean(sections[0].heading)

  return (
    <div className="flex flex-col gap-5">
      {/* Hero verdict — green only because the replay passed on a sandbox fork. */}
      <div
        className={cn(
          "flex flex-col gap-2 rounded-md p-4",
          proven ? "bg-emerald-500/10" : "bg-muted",
        )}
      >
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "grid size-[22px] shrink-0 place-items-center rounded-full",
              proven ? "bg-emerald-500 text-background" : "bg-muted-foreground/30 text-foreground",
            )}
          >
            {proven ? <Check className="size-3.5" /> : <Info className="size-3.5" />}
          </span>
          <span className="text-sm font-medium text-foreground">
            {proven ? "Proven by replay" : "Replay not proven"}
          </span>
        </div>
        <p className="font-mono text-xs text-muted-foreground">
          {proof.pass ? "PASS" : "FAIL"} · {proof.test} · gas {formatNum(proof.gas)} · {proof.compiler}
        </p>
      </div>

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
                <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
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

      {/* The engine's own explanation — prose with its code highlighted. The
          "Why it works" label only leads a plain-prose explanation; a
          self-structured one supplies its own headings. */}
      {sections.length > 0 ? (
        <section className="flex flex-col gap-4" aria-label="Why it works">
          {leadsWithHeading ? null : (
            <h3 className="text-sm font-medium text-foreground">Why it works</h3>
          )}
          {sections.map((section, i) =>
            section.kind === "code" ? (
              <CodeBlock key={i} lang={section.lang} text={section.text} />
            ) : (
              <div key={i} className="flex flex-col gap-1.5">
                {section.heading ? (
                  <h4 className="text-sm font-medium text-foreground">{section.heading}</h4>
                ) : null}
                {section.text ? <Prose text={section.text} /> : null}
              </div>
            ),
          )}
        </section>
      ) : null}

      {/* Secondary detail — one consistent fold vocabulary, closed by default. */}
      <div className="flex flex-col gap-1 border-t pt-4">
        <Fold label="Run details">
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap gap-8">
              {finding.model ? <Stat label="Model">{finding.model}</Stat> : null}
              <Stat label="Cost">{formatUsd(usage.usd)}</Stat>
              {usage.in != null ? <Stat label="Tokens in">{formatNum(usage.in)}</Stat> : null}
              {usage.out != null ? <Stat label="Tokens out">{formatNum(usage.out)}</Stat> : null}
              {usage.reasoning != null ? <Stat label="Reasoning">{formatNum(usage.reasoning)}</Stat> : null}
            </div>
            {proof.runs.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">Replay attempts</span>
                {proof.runs.map((r) => (
                  <RunRow key={r.n} n={r.n} pass={r.pass} gas={r.gas} />
                ))}
              </div>
            ) : null}
          </div>
        </Fold>

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
