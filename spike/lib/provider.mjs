// The ACTIVE inference provider wired as a pi-ai provider for pi-durable.
// Provider-agnostic: id, base URL, key env, and the model list all come from
// whichever provider PROVIDER selects (see providers.mjs). Every provider here
// speaks the OpenAI Chat Completions format.
import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { activeProvider } from "./providers.mjs";

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
    maxTokens: 20000, // reasoning-on turns burn ~13k; too low and the turn ends mid-think with no answer
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, thinkingFormat: "openai" },
  }));
  const models = createModels();
  models.setProvider(createProvider({
    id: P.id,
    name: P.label,
    baseUrl: P.baseUrl,
    auth: { apiKey: envApiKeyAuth(`${P.label} key`, [P.keyEnv]) },
    models: list,
    api: openAICompletionsApi(),
  }));
  return models;
}

// Back-compat alias for callers that still import nearModels.
export { inferenceModels as nearModels };
