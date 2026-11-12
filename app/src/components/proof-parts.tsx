import { useState, type ReactNode } from "react"
import { Check, ChevronRight, Copy, Info, Share2 } from "lucide-react"
import type { FindingBase, ProofCell } from "@/lib/types"
import { formatNum, formatUsd } from "@/lib/format"
import { explanationSections, inlineParts } from "@/lib/explanation"
import { tokenize, type TokenClass } from "@/lib/highlight"
import { cn } from "cn"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"

// The parts every proof card shares: the verdict, the folds, the prose and code
// of the agent's explanation, and the run details. One card per proof kind
// (forge, http, evidence) builds on these, so they read as one family.
// One accent meaning holds: green shows ONLY on a verdict a replay passed.

// Copies the real text and confirms inline — no toast plumbing.
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
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

// The shareable report of a finished finding: the finding, its proof, the harm,
// and the fix, as one self-contained page for a case study. Two formats, both
// served by the engine from this same recorded finding (server/report.mjs): an
// HTML page to open and share, and Markdown for a README or an issue. We open
// the server route in a new tab rather than build the report in the browser, so
// the shared artifact is exactly what the server records — no second source of
// truth, and the report invents no fix the run did not state. Quiet, monochrome:
// sharing is not a finding, so it never takes the one green accent.
export function ExportReport({ findingId }: { findingId: string }) {
  const base = `/api/findings/${encodeURIComponent(findingId)}/report`
  const open = (format: string) => window.open(`${base}?format=${format}`, "_blank", "noopener,noreferrer")
  return (
    <div className="flex items-center gap-2 border-t pt-4">
      <Share2 className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="mr-auto text-xs text-muted-foreground">Shareable report</span>
      <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={() => open("html")}>
        HTML
      </Button>
      <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={() => open("md")}>
        Markdown
      </Button>
    </div>
  )
}

// One disclosure pattern for every folded section — Run details, Raw replay
// output. Same chevron (rotates down when open), same quiet label. Closed by
// default; progressive disclosure per restraint.md.
export function Fold({ label, children }: { label: string; children: ReactNode }) {
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
export function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="text-xs text-foreground">{children}</span>
    </div>
  )
}

// A section with a quiet heading. Every proof block shares this frame so the
// report reads as one stack instead of a pile of differently-weighted titles.
export function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-foreground">{title}</span>
      {children}
    </div>
  )
}


// Render a prose line's inline markdown (`code`, **bold**, *italic*) so none of
// it reaches the screen as raw markers. Inline `code` reads as code in an
// outlined chip so it stands apart from the surrounding prose.
export function Prose({ text }: { text: string }) {
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
export function CodeBlock({ lang, text }: { lang: string | null; text: string }) {
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


// The hero verdict. Green only because the pack's replay passed.
export function Verdict({ proven, line }: { proven: boolean; line: string }) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-xl border p-4",
        proven ? "border-ok/25 bg-ok/[0.06]" : "border-border/60 bg-muted/40",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "grid size-[22px] shrink-0 place-items-center rounded-full",
            proven ? "bg-ok/15 text-ok" : "bg-muted-foreground/20 text-muted-foreground",
          )}
        >
          {proven ? <Check className="size-3.5" /> : <Info className="size-3.5" />}
        </span>
        <span className="text-sm font-medium text-foreground">
          {proven ? "Proven by replay" : "Replay not proven"}
        </span>
      </div>
      <p className="break-words font-mono text-xs text-muted-foreground">{line}</p>
    </div>
  )
}

// The agent's own explanation — prose with its code highlighted. The "Why it
// works" label only leads a plain-prose explanation; a self-structured one
// supplies its own headings.
export function WhyItWorks({ explanation }: { explanation: string | null }) {
  const sections = explanation ? explanationSections(explanation) : []
  if (sections.length === 0) return null
  const leadsWithHeading = sections[0]?.kind === "prose" && Boolean(sections[0].heading)
  return (
    <section className="flex flex-col gap-4" aria-label="Why it works">
      {leadsWithHeading ? null : <h3 className="text-sm font-medium text-foreground">Why it works</h3>}
      {sections.map((section, i) =>
        section.kind === "code" ? (
          <CodeBlock key={i} lang={section.lang} text={section.text} />
        ) : (
          <div key={i} className="flex flex-col gap-1.5">
            {section.heading ? <h4 className="text-sm font-medium text-foreground">{section.heading}</h4> : null}
            {section.text ? <Prose text={section.text} /> : null}
          </div>
        ),
      )}
    </section>
  )
}

// Model, cost and tokens, folded. `extra` adds kind-specific rows.
export function RunDetails({ finding, extra }: { finding: FindingBase; extra?: ReactNode }) {
  const { usage } = finding
  return (
    <Fold label="Run details">
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap gap-8">
          {finding.model ? <Stat label="Model">{finding.model}</Stat> : null}
          <Stat label="Cost">{formatUsd(usage.usd)}</Stat>
          {usage.in != null ? <Stat label="Tokens in">{formatNum(usage.in)}</Stat> : null}
          {usage.out != null ? <Stat label="Tokens out">{formatNum(usage.out)}</Stat> : null}
          {usage.reasoning != null ? <Stat label="Reasoning">{formatNum(usage.reasoning)}</Stat> : null}
        </div>
        {extra}
      </div>
    </Fold>
  )
}

const shortHash = (h: string) => (h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h)

// Name / value rows for headers and cited evidence. A redacted secret shows its
// hash, never the value. Monochrome.
export function CellRows({ cells }: { cells: ProofCell[] }) {
  return (
    <dl className="flex flex-col gap-1">
      {cells.map((c, i) => (
        <div key={`${c.name}-${i}`} className="flex flex-wrap gap-x-2 font-mono text-xs">
          <dt className="shrink-0 text-muted-foreground">{c.name}</dt>
          <dd className="min-w-0 break-words text-foreground">
            {c.redacted ? (
              <span title={c.sha256}>
                [REDACTED] <span className="text-muted-foreground">sha256 {shortHash(c.sha256)}</span>
              </span>
            ) : (
              c.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export { shortHash }
