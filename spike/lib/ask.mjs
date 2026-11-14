// D wiring: handle any stdin object with an own `ask` key before the text filter.
// Install askHumanTool for root and all children, outside the shared pack queue.
// Gated tools call askHuman(input, { signal: ctx.abortSignal }) in their trusted
// withAgent context. Only answer.done === true permits the gated action.
// Call disposeAsks() on stop, parent-pipe end, and before fleet/harness close.
import { randomUUID } from "node:crypto";
import { defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { arr, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { currentAgent, event, withAgent } from "./event.mjs";

const kinds = ["question", "test-account", "wallet-fund", "wallet-spend", "email-send", "login", "payment", "sign-transaction", "takeover"];
const timeoutMs = 30 * 60_000;
const pending = new Map();
const byAgent = new Map();
let disposed = false;

const askFields = ["kind", "question", "options", "select", "min", "max"];
const optionFields = ["id", "label", "description"];

function validateFields(input, allowDetail = false) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
    Object.keys(input).some((key) => !askFields.includes(key) && !(allowDetail && key === "detail"))) {
    throw new Error("Ask input contains unsupported fields.");
  }
}

function exceedsCharacters(text, limit) {
  let count = 0;
  for (const character of text) {
    if (++count > limit) return true;
  }
  return false;
}

// Presentation is display metadata only; selections still use the Reply channel.
function presentationFor(input) {
  if (!Object.hasOwn(input, "options")) {
    if (["select", "min", "max"].some((key) => Object.hasOwn(input, key))) {
      throw new Error("Ask selection fields require options.");
    }
    return undefined;
  }
  if (input.kind !== "question") throw new Error("Ask options are only allowed for question requests.");
  if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 12) {
    throw new Error("Ask options must contain 2 to 12 choices.");
  }
  const ids = new Set();
  const options = [];
  for (const option of input.options) {
    if (!option || typeof option !== "object" || Array.isArray(option) ||
      Object.keys(option).some((key) => !optionFields.includes(key))) {
      throw new Error("Each Ask option must contain only an id, label and optional description.");
    }
    const { id, label, description } = option;
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || id !== id.trim() || ids.has(id)) {
      throw new Error("Ask option ids must be unique lowercase identifiers of 1 to 64 characters.");
    }
    const trimmedLabel = typeof label === "string" ? label.trim() : "";
    if (!trimmedLabel || exceedsCharacters(trimmedLabel, 200)) {
      throw new Error("Ask option labels must contain 1 to 200 characters after trimming.");
    }
    if (Object.hasOwn(option, "description") && (typeof description !== "string" || exceedsCharacters(description, 500))) {
      throw new Error("Ask option descriptions must be strings of at most 500 characters.");
    }
    ids.add(id);
    options.push({ id, label: trimmedLabel, ...(Object.hasOwn(option, "description") ? { description } : {}) });
  }
  const select = Object.hasOwn(input, "select") ? input.select : "single";
  if (select !== "single" && select !== "multiple") throw new Error("Ask select must be single or multiple.");
  const presentation = { options, select };
  if (select === "single") {
    if (Object.hasOwn(input, "min") || Object.hasOwn(input, "max")) {
      throw new Error("Ask min and max are only allowed with multiple selection.");
    }
  } else {
    const min = Object.hasOwn(input, "min") ? input.min : 1;
    const max = Object.hasOwn(input, "max") ? input.max : options.length;
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || min > max || max > options.length) {
      throw new Error("Ask selection bounds must be integers with 1 <= min <= max <= the option count.");
    }
    presentation.min = min;
    presentation.max = max;
  }
  if (Buffer.byteLength(JSON.stringify(presentation), "utf8") > 16384) {
    throw new Error("Ask presentation must not exceed 16384 UTF-8 bytes.");
  }
  return presentation;
}
// Process-local only. pi-durable 1.5.0 replays interrupted safe tools, but marks
// unsafe tools interrupted (dist/harness/tool.js:114-140). Never restore approval.
export async function askHuman(input, { signal } = {}) {
  validateFields(input, true);
  const { kind, question, detail } = input;
  if (!kinds.includes(kind) || typeof question !== "string" || !question.trim() || question.length > 4000) {
    throw new Error("Ask needs a supported kind and a question of 1 to 4000 characters.");
  }
  const presentation = presentationFor(input);
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
      event("ask-human", {
        id, agent, kind, question: question.trim(),
        ...(detail === undefined ? {} : { detail }),
        ...(presentation === undefined ? {} : { presentation }),
      });
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
  description: "Ask the human and wait for Done, Reply, or Cancel. Questions may offer single or multiple choices with optional selection bounds. A choice is a reply, not approval. Keep passwords and codes in the takeover browser, never in chat. Do not request credentials here.",
  parameters: obj({
    kind: oneOf(kinds),
    question: str({ minLength: 1, maxLength: 4000 }),
    options: opt(arr(obj({
      id: str({ pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" }),
      label: str(),
      description: opt(str({ maxLength: 500 })),
    }), { minItems: 2, maxItems: 12 })),
    select: opt(oneOf(["single", "multiple"])),
    min: opt(int({ minimum: 1, maximum: 12 })),
    max: opt(int({ minimum: 1, maximum: 12 })),
  }),
  replay: "unsafe",
  prepareArguments: (input) => {
    // The Harness coerces schema values next; reject raw metadata before that.
    validateFields(input);
    presentationFor(input);
    return input;
  },
  execute: async (input, api, ctx) => {
    if (input && Object.hasOwn(input, "detail")) throw new Error("Ask tool input contains unsupported fields.");
    if (!Number.isSafeInteger(api.conversationId) || api.conversationId < ROOT_CONVERSATION_ID) {
      throw new Error("Ask needs a trusted conversation ID.");
    }
    const agent = api.conversationId === ROOT_CONVERSATION_ID ? "coordinator" : `a-${api.conversationId}`;
    return withAgent(agent, async () => {
      const answer = await askHuman(input, { signal: ctx.abortSignal });
      return { output: [{ type: "text", text: "reply" in answer ? answer.reply : answer.done === true ? "done" : "cancelled" }] };
    });
  },
});
