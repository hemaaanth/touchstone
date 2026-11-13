// The ACTIVE inference provider wired as a pi-ai provider for pi-durable.
// Provider-agnostic: id, base URL, key and the model list all come from the
// active provider (see providers.mjs). Every provider here speaks the OpenAI
// Chat Completions format.
import { createAssistantMessageEventStream, createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { estimateContextTokens, estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { activeProvider, providerKey } from "./providers.mjs";
import { charge, guard, runSpend } from "./inference.mjs";
import { event, withAgent } from "./event.mjs";

// Charge each response before the harness can start another call, including
// retries and subagents. Forward the final event only after accounting.
export function budgetedApi(api, agentForSession = () => undefined) {
  const wrap = (method) => (model, context, options) => {
    const output = createAssistantMessageEventStream();
    withAgent(agentForSession(options?.sessionId), async () => {
      try {
        const check = () => {
          try { guard(); }
          catch (err) { event("budget-reached", { ...runSpend(), error: err.message }); throw err; }
        };
        check();
        const source = api[method](model, context, {
          ...options,
          onPayload: async (payload, m) => {
            check();
            return options?.onPayload ? options.onPayload(payload, m) : undefined;
          },
        });
        // pi-ai sends "start" once the provider has answered with a 2xx.
        let started = false;
        for await (const e of source) {
          if (e.type !== "done" && e.type !== "error") started = true;
          if (e.type === "done" || e.type === "error") {
            const message = e.type === "done" ? e.message : e.error;
            const usage = e.type === "error" ? billedUsage(context, message, started) : message.usage;
            if (usage) {
              charge(model.id, usage);
              event("spend", { ...runSpend(), ...contextUse(model, usage) });
            }
          }
          output.push(e.type === "error" ? markTransient(e) : e);
        }
      } catch (err) {
        output.push({ type: "error", reason: "error", error: {
          role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "error", errorMessage: transientMessage(err?.message ?? err), timestamp: Date.now(),
        } });
      } finally { output.end(); }
    });
    return output;
  };
  return { stream: wrap("stream"), streamSimple: wrap("streamSimple") };
}

// The engine retries a failed model call (bounded, with backoff: settings.retry
// in agent-run.mjs) only when pi-ai's isRetryableAssistantError matches the
// error text. Some transport failures slip past that check. The Lyber gateway
// ends a stream with an SSE error chunk that reads just "Stream interrupted";
// pi-ai knows only "stream was interrupted", so one dropped stream ended a whole
// run with model_error and no retry. Tag those errors with words the check
// knows. A 4xx status (other than 429) is never tagged: a bad key, a bad request
// or a missing model must fail fast. Budget and cap stops never match these
// patterns. Spend is charged above, once per attempt, before this runs; a retry
// is a new call and goes through check() again, so both budgets still apply.
const TRANSPORT_DROP = /stream (?:was )?interrupted|ECONNRESET|ETIMEDOUT|ECONNABORTED|EPIPE|premature close/i;
// A 4xx where providers put the status: first ("401 Unauthorized", "400: {...}"),
// in brackets ("Lyber (403): ..."), or after "status"/"HTTP"/"code". Not a port
// such as ":443". 408 (request timeout) and 429 (rate limit) are transient.
const statusAt = (code) => new RegExp(`^\\s*${code}\\b|\\(${code}\\)|\\b(?:status|http|code)\\W{0,3}${code}\\b`, "i");
const CLIENT_STATUS = statusAt("4(?!29|08)\\d\\d");
// Any 4xx: the provider refused the request, so it billed no prompt tokens.
// The others never sent it: our own budget or cap stop (raised in onPayload),
// a missing key, or a host that could not be reached.
const REFUSED_STATUS = statusAt("4\\d\\d");
const NOT_SENT = /out of budget|Run budget reached|No API key|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i;
function transientMessage(text) {
  const t = String(text ?? "");
  if (!TRANSPORT_DROP.test(t) || CLIENT_STATUS.test(t) || isRetryableAssistantError({ stopReason: "error", errorMessage: t })) return t;
  return `${t} (transient network error)`;
}
function markTransient(e) {
  if (e.error?.stopReason !== "error") return e;
  const errorMessage = transientMessage(e.error.errorMessage);
  return errorMessage === e.error.errorMessage ? e : { ...e, error: { ...e.error, errorMessage } };
}

// What a failed call cost. pi-ai's openai-completions adapter gets usage only
// in the last chunk, so a stream that drops reports zero input tokens. The
// provider still read the whole prompt and very likely bills it, and each retry
// reads it again. So a failed call with no reported input is charged an
// estimate of its prompt when the request reached the provider: the stream had
// started, or a server answered with a 5xx, or the request timed out after it
// was sent. With none of these ("Connection error.", "fetch failed") no answer
// came back, so the call is charged nothing. That includes a socket that was
// reset after the request was sent: the SDK gives it the same text as a refused
// host, so the two cannot be told apart.
const SERVER_STATUS = statusAt("5\\d\\d");
const TIMED_OUT = /timed out|timeout|ETIMEDOUT/i;
function billedUsage(context, message, started) {
  const usage = message.usage ?? {};
  if (message.stopReason !== "error" || (usage.input ?? 0) > 0 || (usage.cacheRead ?? 0) > 0) return message.usage;
  const text = String(message.errorMessage ?? "");
  if (REFUSED_STATUS.test(text) || NOT_SENT.test(text)) return message.usage;
  if (!started && !SERVER_STATUS.test(text) && !TIMED_OUT.test(text)) return message.usage;
  return { ...usage, input: promptTokens(context), output: usage.output ?? 0 };
}
function promptTokens(context) {
  try {
    let n = estimateContextTokens(context?.messages ?? []).tokens;
    if (typeof context?.systemPrompt === "string") n += estimateTextTokens(context.systemPrompt);
    if (context?.tools?.length) n += estimateTextTokens(JSON.stringify(context.tools));
    return n;
  } catch {
    return 0;
  }
}

// How full the model's context was on this call: every token it read plus the
// tokens it wrote, against the model's window. Nothing when either is unknown.
function contextUse(model, usage) {
  const used = usage.totalTokens || (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + (usage.output ?? 0);
  const window = model.contextWindow;
  return used > 0 && window > 0 ? { ctx: { used, window } } : {};
}

// Api-key auth that reads the key saved in Settings, else the provider's env var.
function settingsKeyAuth(P) {
  return {
    name: `${P.label} key`,
    resolve: async ({ signal }) => {
      signal?.throwIfAborted();
      const k = providerKey(P);
      return k ? { auth: { apiKey: k }, source: P.apiKey ? "settings" : P.keyEnv } : undefined;
    },
  };
}

export function inferenceModels({ agentForSession } = {}) {
  const P = activeProvider();
  const list = Object.values(P.models).map((m) => ({
    id: m.id,
    name: m.id,
    api: "openai-completions",
    provider: P.id,
    baseUrl: P.baseUrl,
    reasoning: m.reasoning ?? true,
    input: ["text"],
    cost: { input: m.input, output: m.output, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.context,
    maxTokens: Math.min(20000, m.maxOut ?? 20000), // reasoning-on turns burn ~13k; too low and the turn ends mid-think with no answer
    // supportsStore:false — the openai-completions adapter otherwise sends
    // `store:false` on every call, and some OpenAI-compatible gateways (Lyber)
    // reject it with `400 unsupported_parameter: store`, which the harness maps
    // to a `model_error` that fails the whole run before any inference. `store`
    // is only a "don't persist this completion" hint, so dropping it is a no-op
    // on gateways that do accept it (NEAR, Boundless).
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, thinkingFormat: "openai", supportsStore: false },
  }));
  const models = createModels();
  models.setProvider(createProvider({
    id: P.id,
    name: P.label,
    baseUrl: P.baseUrl,
    auth: { apiKey: settingsKeyAuth(P) },
    models: list,
    api: budgetedApi(openAICompletionsApi(), agentForSession),
  }));
  return models;
}

// Back-compat alias for callers that still import nearModels.
export { inferenceModels as nearModels };
