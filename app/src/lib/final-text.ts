// Repair the last prose step with the full final answer from `settled`.
// The streamed text can end one chunk short (old records keep that gap). When the
// final text starts with the step's text and is longer, the step takes the final
// text. Any other step is left alone. Pure, so a node test can load it as is.
export function repairFinalSay<T extends { kind: string; label: string }>(steps: T[], finalText: unknown): boolean {
  if (typeof finalText !== "string" || !finalText) return false
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]
    if (s.kind !== "say") continue
    if (finalText.length > s.label.length && finalText.startsWith(s.label)) {
      s.label = finalText
      return true
    }
    return false
  }
  return false
}

// The engine marks a closing text it had to cut with this at its end.
export const CUT_MARK = " …cut"

// True when a prose step already holds the closing text: its label starts
// with that text. A cut copy is a prefix of the whole text, so it matches the
// step that streamed the whole text.
export function closingHeld(steps: { kind: string; label: string }[], finalText: string): boolean {
  const text = finalText.endsWith(CUT_MARK) ? finalText.slice(0, -CUT_MARK.length) : finalText
  if (!text.trim()) return true
  return steps.some((s) => s.kind === "say" && s.label.startsWith(text))
}
