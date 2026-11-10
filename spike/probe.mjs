// One tiny request per model: does it answer, and where does reasoning show up?
import { MODELS, chat, spent } from "./lib/near.mjs";

for (const [alias, m] of Object.entries(MODELS)) {
  const t0 = Date.now();
  const r = await chat(m.id, { messages: [{ role: "user", content: "Reply with the single word: ready" }], max_tokens: 400 }, { estimateUsd: 0.002 });
  if (r.httpError) {
    console.log(alias, "HTTP", r.httpError, r.error);
    continue;
  }
  const msg = r.choices?.[0]?.message ?? {};
  console.log(JSON.stringify({
    alias,
    ms: Date.now() - t0,
    finish: r.choices?.[0]?.finish_reason,
    content: (msg.content ?? "").slice(0, 80),
    messageKeys: Object.keys(msg),
    reasoningChars: (msg.reasoning_content ?? msg.reasoning ?? "").length,
    usage: r.usage,
  }));
}
console.log("spent", spent().toFixed(5));
