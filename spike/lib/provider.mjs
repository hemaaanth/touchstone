// The ACTIVE inference provider wired as a pi-ai provider for pi-durable.
// Provider-agnostic: id, base URL, key and the model list all come from the
// active provider (see providers.mjs). Every provider here speaks the OpenAI
// Chat Completions format.
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { activeProvider, providerKey } from "./providers.mjs";

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

export function inferenceModels() {
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
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, thinkingFormat: "openai" },
  }));
  const models = createModels();
  models.setProvider(createProvider({
    id: P.id,
    name: P.label,
    baseUrl: P.baseUrl,
    auth: { apiKey: settingsKeyAuth(P) },
    models: list,
    api: openAICompletionsApi(),
  }));
  return models;
}

// Back-compat alias for callers that still import nearModels.
export { inferenceModels as nearModels };
