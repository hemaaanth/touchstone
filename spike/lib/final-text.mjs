// The streamed prose of the last answer can stop one chunk short: the LiveDoc
// is committed on a throttle, so its last value may miss the final tokens. The
// `settled` event carries the whole answer. These two rules close the gap.
//
// unsentFinal: the text the engine still has to emit as one last
// `assistant-delta`, or null when the stream already ended on the full answer
// (or on something that is not a prefix of it, such as an earlier round).
export function unsentFinal(lastSay, finalText) {
  const full = typeof finalText === "string" ? finalText : "";
  const sent = typeof lastSay === "string" ? lastSay : "";
  if (!full || full.length <= sent.length || !full.startsWith(sent)) return null;
  return full;
}
