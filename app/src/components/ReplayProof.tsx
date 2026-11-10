import type { ReactNode } from "react"
import { Separator, ThemedIcon } from "@graphical"
import type { Finding } from "@/lib/types"
import { CopyButton, Fold, Stat, formatNum, formatUsd } from "./bits"
import { explanationSections, inlineParts } from "@/lib/explanation"
import { tokenize } from "@/lib/highlight"

// A single PoC attempt. The engine ran the exploit twice: the first attempt
// failed, the second passed. Both are shown — the failure is part of the proof.
function RunRow({ n, pass, gas }: { n: number; pass: boolean; gas: number | null }) {
  return (
    <div className="flex items-center gap-(--space-s) type-xs">
      <span className="font-data text-(--cte-text-muted)">#{n}</span>
      <span
        className="font-data weight-medium"
        style={{ color: pass ? "var(--success)" : "var(--cte-text-muted)" }}
      >
        {pass ? "PASS" : "FAIL"}
      </span>
      <span className="font-data text-(--cte-text-muted)">
        gas {formatNum(gas)}
      </span>
    </div>
  )
}

function BalanceDelta({ label, before, after }: { label: string; before: string; after: string | null }) {
  return (
    <div className="flex flex-col gap-(--space-xxs)">
      <span className="type-xxs text-(--cte-text-muted)">{label}</span>
      <div className="flex items-center gap-(--space-xs) font-data type-s text-(--cte-text)">
        <span className="tabular-nums">{before}</span>
        <ThemedIcon name="arrowRight" />
        <span className="tabular-nums weight-medium">{after ?? "—"}</span>
      </div>
    </div>
  )
}

// Render a prose line's inline markdown (`code`, **bold**, *italic*) so none
// of it reaches the screen as raw markers. Inline `code` reads as code the way
// Slack's does: a real monospace, set a touch smaller, in an outlined chip so
// it stands apart from the surrounding prose instead of just changing colour.
function Prose({ text }: { text: string }) {
  return (
    <p className="type-s text-(--cte-text-muted)">
      {inlineParts(text).map((p, j) =>
        p.kind === "code" ? (
          <code
            key={j}
            className="font-mono text-[0.85em] text-(--cte-text)"
            style={{
              background: "var(--code-surface)",
              boxShadow: "inset 0 0 0 1px var(--code-border)",
              borderRadius: "var(--radius-s)",
              padding: "0.08em 0.34em",
            }}
          >
            {p.value}
          </code>
        ) : p.kind === "strong" ? (
          <strong key={j} className="weight-medium text-(--cte-text)">
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

// A fenced code block from the explanation, set in monospace and syntax-
// highlighted for the language the engine tagged on the fence (```solidity,
// ```ts, …). The language rides along as a quiet label so the reader knows
// what they are looking at. Highlighting is theme-coloured (see highlight.ts),
// so it stays inside the app's muted palette.
function CodeBlock({ lang, text }: { lang: string | null; text: string }) {
  return (
    <div className="flex flex-col gap-(--space-xs)">
      {lang ? (
        <span className="font-mono type-xxs text-(--cte-text-muted)">{lang}</span>
      ) : null}
      <pre
        className="overflow-x-auto rounded-(--radius-m) p-(--space-m) font-mono type-xs text-(--cte-text)"
        style={{ background: "var(--code-surface)" }}
      >
        <code>
          {tokenize(text, lang).map((t, i) =>
            t.cls === "text" ? (
              t.value
            ) : (
              <span key={i} className={`syntax-${t.cls}`}>
                {t.value}
              </span>
            ),
          )}
        </code>
      </pre>
    </div>
  )
}

// `children` are extra folds (e.g. the live run's timeline) that belong in the
// same quiet fold group as Run details and Raw replay output, so the whole
// stack shares one spacing instead of one fold sitting apart.
export function ReplayProof({ finding, children }: { finding: Finding; children?: ReactNode }) {
  const { proof, usage } = finding
  const proven = finding.stages.proven && proof.pass
  // Parse the explanation once. The newer engine format opens with its own
  // section heading (## What goes wrong, …); the older one opens with plain
  // prose. We drop the generic "Why it works" label only when the explanation
  // leads with its own heading — otherwise that label would sit directly above
  // the first heading and read as a header with nothing under it. A legacy
  // explanation (headingless lead prose) still gets the "Why it works" label.
  const sections = finding.explanation ? explanationSections(finding.explanation) : []
  const leadsWithHeading = sections[0]?.kind === "prose" && Boolean(sections[0].heading)
  return (
    <div className="flex flex-col gap-(--space-l)">
      {/* Hero verdict — green only because the replay passed on a sandbox fork. */}
      <div
        className="flex flex-col gap-(--space-s) rounded-(--radius-m) p-(--space-m)"
        style={{ background: proven ? "color-mix(in oklab, var(--success) 10%, var(--neutral-2))" : "var(--neutral-2)" }}
      >
        <div className="flex items-center gap-(--space-s)">
          <span
            className="grid size-[22px] place-items-center rounded-(--radius-full) text-(--neutral-1)"
            style={{ background: proven ? "var(--success)" : "var(--neutral-6)" }}
          >
            <ThemedIcon name={proven ? "check" : "info"} />
          </span>
          <span className="type-s weight-medium text-(--cte-text)">{proven ? "Proven by replay" : "Replay not proven"}</span>
        </div>
        <p className="font-data type-xs text-(--cte-text-muted)">
          {proof.pass ? "PASS" : "FAIL"} · {proof.test} · gas {formatNum(proof.gas)} · {proof.compiler}
        </p>
      </div>

      {/* The static pre-pass that pointed the agent here. A suspect list is only
          a lead — neutral, never green. The green verdict above is the replay's
          alone. This section shows the feeder → proof story: two independent
          engines ranked it, the replay proved it. Where both engines agree on a
          spot, we mark it — agreement raises rank, it never substitutes for the
          replay. */}
      {finding.staticScan ? (
        <div className="flex flex-col gap-(--space-s)">
          <span className="type-s weight-medium text-(--cte-text)">Static analysis led here</span>
          <p className="type-xs text-(--cte-text-muted)">
            {finding.staticScan.tool} flagged {finding.staticScan.suspects} suspect
            {finding.staticScan.suspects === 1 ? "" : "s"} before the agent started
            {finding.staticScan.engines.length > 1
              ? ` — ${finding.staticScan.engines.join(" and ")} ran as independent engines`
              : ""}
            . A suspect is only a lead — the replay above is what proved it.
          </p>
          <ul className="flex flex-col gap-(--space-xs)">
            {finding.staticScan.top.slice(0, 3).map((s, i) => (
              <li key={`${s.check}-${i}`} className="flex flex-wrap items-center gap-x-(--space-s) font-data type-xs">
                <span className="text-(--cte-text-muted)">[{s.impact}]</span>
                <span className="text-(--cte-text)">{s.check}</span>
                {s.where ? (
                  <span className="text-(--cte-text-muted)">
                    {s.where}
                    {s.line ? ` (line ${s.line})` : ""}
                  </span>
                ) : null}
                {s.corroborated ? (
                  <span className="text-(--cte-text-muted)" title={`Flagged independently by ${s.engines.join(" and ")}`}>
                    · {s.engines.join(" + ")} agree
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Fuzzing led here — the same feeder → proof story for an accounting bug.
          Echidna broke an invariant from ordinary calls; the replay above is what
          turned that lead into a proof. Neutral, never green: a broken invariant
          is a suspect, not a finding. */}
      {finding.fuzzScan ? (
        <div className="flex flex-col gap-(--space-s)">
          <span className="type-s weight-medium text-(--cte-text)">Fuzzing led here</span>
          <p className="type-xs text-(--cte-text-muted)">
            {finding.fuzzScan.tool} broke {finding.fuzzScan.suspects} invariant
            {finding.fuzzScan.suspects === 1 ? "" : "s"} from ordinary deposits and withdrawals before the agent started. A broken invariant is only a lead — the replay above is what proved it.
          </p>
          <ul className="flex flex-col gap-(--space-s)">
            {finding.fuzzScan.top.slice(0, 3).map((s, i) => (
              <li key={`${s.property}-${i}`} className="flex flex-col gap-(--space-xs) font-data type-xs">
                <span className="flex flex-wrap items-center gap-x-(--space-s)">
                  <span className="text-(--cte-text-muted)">[{s.impact}]</span>
                  <span className="text-(--cte-text)">{s.check}</span>
                  {s.where ? <span className="text-(--cte-text-muted)">{s.where}</span> : null}
                  <span className="text-(--cte-text-muted)">({s.property})</span>
                </span>
                {s.sequence.length > 0 ? (
                  <span className="text-(--cte-text-muted)">{s.sequence.join(" → ")}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Real on-chain deltas the exploit produced. */}
      {proof.balances.length > 0 ? (
        <div className="flex flex-col gap-(--space-s)">
          <span className="type-s weight-medium text-(--cte-text)">What the exploit moved</span>
          <div className="flex flex-wrap gap-(--space-xl)">
            {proof.balances.map((b) => (
              <BalanceDelta key={b.label} {...b} />
            ))}
          </div>
        </div>
      ) : null}

      {/* The passing assertions — the literal conditions the replay checked. */}
      {proven && proof.assertions.length > 0 ? (
        <div className="flex flex-col gap-(--space-s)">
          <span className="type-s weight-medium text-(--cte-text)">Replay checked</span>
          <ul className="flex flex-col gap-(--space-xs)">
            {proof.assertions.map((a) => (
              <li key={a} className="flex items-start gap-(--space-xs) font-data type-xs text-(--cte-text-muted)">
                <span className="mt-[2px] text-(--success)">
                  <ThemedIcon name="check" />
                </span>
                <span className="min-w-0 break-words">{a}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Reproduce it yourself. */}
      {proof.rerunCommand ? (
        <div className="flex flex-col gap-(--space-xs)">
          <span className="type-s weight-medium text-(--cte-text)">Reproduce it yourself</span>
          <p className="type-xs text-(--cte-text-muted)">
            Run this in the generated Foundry project to replay the exploit and watch the same assertions pass.
          </p>
          <div
            className="mt-(--space-xs) flex items-center justify-between gap-(--space-s) rounded-(--radius-m) px-(--space-m) py-(--space-s)"
            style={{ background: "var(--code-surface)" }}
          >
            <code className="min-w-0 truncate font-mono type-xs text-(--cte-text)">{proof.rerunCommand}</code>
            <CopyButton value={proof.rerunCommand} label="Copy" />
          </div>
        </div>
      ) : null}

      <Separator />

      {/* The engine's own explanation — prose with its code set in highlighted
          code blocks. The "Why it works" label only leads a plain-prose
          explanation; a self-structured one supplies its own headings. */}
      {sections.length > 0 ? (
        <section className="flex flex-col gap-(--space-m)" aria-label="Why it works">
          {leadsWithHeading ? null : (
            <h3 className="type-s weight-medium text-(--cte-text)">Why it works</h3>
          )}
          {sections.map((section, i) =>
            section.kind === "code" ? (
              <CodeBlock key={i} lang={section.lang} text={section.text} />
            ) : (
              <div key={i} className="flex flex-col gap-(--space-xs)">
                {section.heading ? <h4 className="type-s weight-medium text-(--cte-text)">{section.heading}</h4> : null}
                {section.text ? <Prose text={section.text} /> : null}
              </div>
            ),
          )}
        </section>
      ) : null}

      {/* Secondary detail — one consistent fold vocabulary, closed by default. */}
      <div className="divide-top flex flex-col gap-(--space-xs) pt-(--space-m)">
        <Fold label="Run details">
          <div className="flex flex-col gap-(--space-l)">
            <div className="flex flex-wrap gap-(--space-xl)">
              {finding.model ? <Stat label="Model">{finding.model}</Stat> : null}
              <Stat label="Cost">{formatUsd(usage.usd)}</Stat>
              {usage.in != null ? <Stat label="Tokens in">{formatNum(usage.in)}</Stat> : null}
              {usage.out != null ? <Stat label="Tokens out">{formatNum(usage.out)}</Stat> : null}
              {usage.reasoning != null ? <Stat label="Reasoning">{formatNum(usage.reasoning)}</Stat> : null}
            </div>
            {proof.runs.length > 0 ? (
              <div className="flex flex-col gap-(--space-xs)">
                <span className="type-s weight-medium text-(--cte-text)">Replay attempts</span>
                {proof.runs.map((r) => <RunRow key={r.n} n={r.n} pass={r.pass} gas={r.gas} />)}
              </div>
            ) : null}
          </div>
        </Fold>

        {proof.runs.length > 0 ? (
          <Fold label="Raw replay output">
            <div className="flex flex-col gap-(--space-m)">
              {proof.runs.map((r) => (
                <pre
                  key={r.n}
                  className="overflow-x-auto rounded-(--radius-m) p-(--space-m) font-mono type-xxs text-(--cte-text-muted)"
                  style={{ background: "var(--code-surface)" }}
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
