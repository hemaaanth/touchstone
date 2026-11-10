// Turn the engine's prose explanation into renderable blocks. Fenced code
// (```…```) becomes its own code block; the rest stays prose. Markdown ATX
// headings (## Heading) and the engine's own PoC / Fix labels both become
// section headings, so nothing renders as raw `##`. Inline markup (`code`,
// **bold**, *italic*) is tokenised by inlineParts() at render time.
export type ExplanationBlock =
  | { kind: "code"; lang: string | null; text: string }
  | { kind: "prose"; heading: string | null; text: string }

// A single line that is only a markdown heading, e.g. "## Fix" -> "Fix".
// Multi-line blocks never match (the `$` has no /m flag), so a heading glued
// to its body is left alone.
function atxHeading(block: string): string | null {
  const m = /^#{1,6}\s+(.+?)\s*#*$/.exec(block.trim())
  return m ? m[1].trim() : null
}

// Strip one leading "Fix:" / "PoC" / "Proof" label and return the heading it
// implies plus the remaining text. Used for the legacy label format and to
// drop a label the engine repeats right under an ATX heading.
function demoteLabel(text: string): { heading: string | null; text: string } {
  if (/^Fix:\s*/i.test(text)) return { heading: "Fix", text: text.replace(/^Fix:\s*/i, "") }
  if (/^(PoC|Proof)\b/i.test(text))
    return { heading: "PoC narrative", text: text.replace(/^(PoC|Proof)\s*:?\s*/i, "") }
  return { heading: null, text }
}

export function explanationSections(explanation: string): ExplanationBlock[] {
  const out: ExplanationBlock[] = []
  // An ATX heading sits on its own line; attach it to the next paragraph.
  let pending: string | null = null

  const flushPending = () => {
    if (pending) {
      out.push({ kind: "prose", heading: pending, text: "" })
      pending = null
    }
  }

  const pushProse = (chunk: string) => {
    chunk
      .split(/\n\s*\n/)
      .map((t) => t.trim())
      .filter(Boolean)
      .forEach((block) => {
        const atx = atxHeading(block)
        if (atx !== null) {
          // A new heading supersedes an empty pending one.
          flushPending()
          pending = /^(poc|proof)$/i.test(atx) ? "PoC narrative" : atx
          return
        }
        let heading = pending
        pending = null
        const demoted = demoteLabel(block)
        // With a heading already set by an ATX line, only strip a duplicate
        // label (## Fix then "Fix: …"); otherwise let the label be the heading.
        const text = heading ? (demoted.heading ? demoted.text : block) : demoted.text
        if (!heading) heading = demoted.heading
        if (text) out.push({ kind: "prose", heading, text })
        else if (heading) out.push({ kind: "prose", heading, text: "" })
      })
  }

  // Pull out fenced code blocks, keeping the prose around them in order. The
  // opening fence's language token (```solidity, ```ts, …) is captured so the
  // renderer can highlight the code for that language.
  const fence = /```([a-zA-Z0-9+#-]*)[ \t]*\n?([\s\S]*?)```/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = fence.exec(explanation)) !== null) {
    pushProse(explanation.slice(last, m.index))
    flushPending() // a heading right before code still renders above it
    const lang = m[1] ? m[1].toLowerCase() : null
    const code = m[2].replace(/\n+$/, "")
    if (code.trim()) out.push({ kind: "code", lang, text: code })
    last = m.index + m[0].length
  }
  pushProse(explanation.slice(last))
  flushPending()

  return out
}

// Inline markup for a prose line: `code`, **bold**, *italic*, plain text.
// Non-nested, first-match — enough for the engine's explanations and never
// leaves raw markers on screen.
export type Inline =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string }
  | { kind: "strong"; value: string }
  | { kind: "em"; value: string }

export function inlineParts(text: string): Inline[] {
  const parts: Inline[] = []
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\n]+)\*/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ kind: "text", value: text.slice(last, m.index) })
    if (m[1] != null) parts.push({ kind: "code", value: m[1] })
    else if (m[2] != null) parts.push({ kind: "strong", value: m[2] })
    else parts.push({ kind: "em", value: m[3] })
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push({ kind: "text", value: text.slice(last) })
  return parts
}
