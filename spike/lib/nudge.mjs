// How a run ends after its one pack nudge. The nudge is a second chance, not a
// new ending. Each side is { settled, final, found, leads }: the turn's settle
// result, its last assistant message, and the findings and leads recorded so far.
//   - The nudge turn failed (an error, a budget stop): the first turn ended
//     cleanly, so its outcome and text stand. What the nudge turn recorded is
//     already saved as events.
//   - The nudge turn recorded nothing: its reply ("I found no lead") does not
//     replace the first turn's final text.
//   - Otherwise the nudge turn's ending stands.
export function afterNudge(first, after) {
  if (after.settled?.status !== "done") return { settled: first.settled, final: first.final };
  const added = (after.found ?? 0) > (first.found ?? 0) || (after.leads ?? 0) > (first.leads ?? 0);
  return { settled: after.settled, final: added ? after.final : first.final };
}
