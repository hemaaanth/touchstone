// D wiring: handle any stdin object with an own `ask` key before the text filter.
// Install askHumanTool for root and all children, outside the shared pack queue.
// Gated tools call askHuman(input, { signal: ctx.abortSignal }) in their trusted
// withAgent context. Only answer.done === true permits the gated action.
// Call disposeAsks() on stop, parent-pipe end, and before fleet/harness close.
import { randomUUID } from "node:crypto";
import { defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { obj, oneOf, str } from "@earendil-works/pi-schema";
import { currentAgent, event, withAgent } from "./event.mjs";

const kinds = ["question", "test-account", "wallet-fund", "wallet-spend", "email-send", "login", "payment", "sign-transaction", "takeover"];
const timeoutMs = 30 * 60_000;
const pending = new Map();
const byAgent = new Map();
let disposed = false;

// Process-local only. pi-durable 1.5.0 replays interrupted safe tools, but marks
// unsafe tools interrupted (dist/harness/tool.js:114-140). Never restore approval.
export async function askHuman({ kind, question, detail }, { signal } = {}) {
  if (!kinds.includes(kind) || typeof question !== "string" || !question.trim() || question.length > 4000) {
    throw new Error("Ask needs a supported kind and a question of 1 to 4000 characters.");
  }
  if (disposed || signal?.aborted) return { done: false };
  // Undefined is the root identity in event.mjs and fleet.mjs, including solo runs.
  const agent = currentAgent() ?? "coordinator";
  if (byAgent.has(agent)) throw new Error("This agent already has a pending ask.");
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => finish({ done: false });
    const clear = () => {
      pending.delete(id);
      byAgent.delete(agent);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (answer) => {
      if (!pending.has(id)) return;
      clear();
      try {
        event("ask-answered", { id, agent, answer: "reply" in answer ? "reply" : answer.done === true ? "done" : "cancel" });
        resolve(answer);
      } catch (error) {
        // A failed event write must not leave a wait or grant permission.
        reject(error);
      }
    };
    pending.set(id, finish);
    byAgent.set(agent, id);
    timer = setTimeout(onAbort, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      event("ask-human", { id, agent, kind, question: question.trim(), ...(detail === undefined ? {} : { detail }) });
    } catch (error) {
      clear();
      reject(error);
    }
  });
}

// A parsed stdin object, not chat text. Invalid, stale, and duplicate answers
// consume nothing. Never send reply text to event() or log malformed input.
export function answerAsk(line) {
  if (!line || typeof line !== "object" || Array.isArray(line)) return false;
  const keys = Object.keys(line);
  if (keys.length !== 2 || !Object.hasOwn(line, "ask") || typeof line.ask !== "string") return false;
  let answer;
  if (Object.hasOwn(line, "done") && typeof line.done === "boolean") answer = { done: line.done };
  else if (Object.hasOwn(line, "reply") && typeof line.reply === "string" && line.reply.trim() && line.reply.trim().length <= 4000) {
    answer = { reply: line.reply.trim() };
  } else return false;
  const finish = pending.get(line.ask);
  if (!finish) return false;
  finish(answer);
  return true;
}

// Permanent shutdown of this worker. New asks fail closed; existing waits end.
export function disposeAsks() {
  disposed = true;
  for (const finish of [...pending.values()]) finish({ done: false });
}

export const askHumanTool = defineTool({
  name: "ask_human",
  description: "Ask the human and wait for Done, Reply, or Cancel. A reply is not approval. Keep passwords and codes in the takeover browser, never in chat. Do not request credentials here.",
  parameters: obj({ kind: oneOf(kinds), question: str({ minLength: 1, maxLength: 4000 }) }),
  replay: "unsafe",
  execute: async ({ kind, question }, api, ctx) => {
    if (!Number.isSafeInteger(api.conversationId) || api.conversationId < ROOT_CONVERSATION_ID) {
      throw new Error("Ask needs a trusted conversation ID.");
    }
    const agent = api.conversationId === ROOT_CONVERSATION_ID ? "coordinator" : `a-${api.conversationId}`;
    return withAgent(agent, async () => {
      const answer = await askHuman({ kind, question }, { signal: ctx.abortSignal });
      return { output: [{ type: "text", text: "reply" in answer ? answer.reply : answer.done === true ? "done" : "cancelled" }] };
    });
  },
});
