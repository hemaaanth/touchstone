// The ACTIVE inference provider wired as a pi-ai provider for pi-durable.
// Provider-agnostic: id, base URL, key and the model list all come from the
// active provider (see providers.mjs). Every provider here speaks the OpenAI
// Chat Completions format.
import { createAssistantMessageEventStream, createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
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
        for await (const e of source) {
          if (e.type === "done" || e.type === "error") {
            const message = e.type === "done" ? e.message : e.error;
            if (message.usage) {
              charge(model.id, message.usage);
              event("spend", { ...runSpend(), ...contextUse(model, message.usage) });
            }
          }
          output.push(e);
        }
      } catch (err) {
        output.push({ type: "error", reason: "error", error: {
          role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "error", errorMessage: String(err?.message ?? err), timestamp: Date.now(),
        } });
      } finally { output.end(); }
    });
    return output;
  };
  return { stream: wrap("stream"), streamSimple: wrap("streamSimple") };
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
