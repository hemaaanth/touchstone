import { LiveDoc, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { event } from "./event.mjs";
import { unsentFinal } from "./final-text.mjs";

// Deltas are full snapshots. Each conversation and tool round has its own step.
export async function watchCognition(harness, conversationId, { agent, base = 0, skipStale = false, uniqueTurns = false } = {}, ctx) {
  const w = await harness.watchDoc(LiveDoc, conversationId, ctx);
  if (!w) return undefined;
  const identity = { conv: conversationId === ROOT_CONVERSATION_ID ? "root" : String(conversationId), ...(agent ? { agent } : {}) };
  let turn = -1, lastSay = "", lastThink = "";
  const snapshots = new Map();
  const read = (message) => {
    if (!Array.isArray(message?.content)) return null;
    return {
      say: message.content.filter((b) => b.type === "text").map((b) => b.text).join(""),
      think: message.content.filter((b) => b.type === "thinking").map((b) => b.thinking).join(""),
    };
  };
  const initial = skipStale ? read(w.value?.generation?.message) : null;
  let stale = initial ? initial.think + "\u0000" + initial.say : null;
  const emit = (live) => {
    const r = read(live?.generation?.message);
    if (!r) return;
    if (stale !== null) {
      if (r.think + "\u0000" + r.say === stale) return;
      stale = null;
    }
    const t = uniqueTurns ? (live?.run?.taskId ?? turn) : base + (live?.run?.turns ?? 0);
    if (t !== turn) {
      turn = t;
      ({ say: lastSay, think: lastThink } = snapshots.get(turn) ?? { say: "", think: "" });
    }
    if (r.think && r.think !== lastThink) {
      lastThink = r.think;
      event("thinking-delta", { ...identity, attempt: turn, text: r.think });
    }
    if (r.say && r.say !== lastSay) {
      lastSay = r.say;
      event("assistant-delta", { ...identity, attempt: turn, text: r.say });
    }
    snapshots.set(turn, { say: lastSay, think: lastThink });
  };
  emit(w.value);
  w.start(async (call) => { if (call.kind === "value") emit(call.value); });
  return {
    flush(text, thinking, taskId) {
      const attempt = uniqueTurns && taskId != null ? taskId : turn < 0 ? base : turn;
      const previous = snapshots.get(attempt) ?? (attempt === turn ? { say: lastSay, think: lastThink } : { say: "", think: "" });
      if (thinking && thinking !== previous.think) {
        event("thinking-delta", { ...identity, attempt, text: thinking });
      }
      const rest = unsentFinal(previous.say, text);
      if (rest) event("assistant-delta", { ...identity, attempt, text: rest });
      snapshots.set(attempt, { say: rest || previous.say, think: thinking || previous.think });
    },
    stop: () => w.stop(),
  };
}
