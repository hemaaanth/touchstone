// Lists the live model catalog for the ACTIVE provider, using its key.
//
//   PROVIDER=boundless node discover-models.mjs
//
// Shows which models the account can actually serve and their published
// pricing, so providers.mjs can be reconciled against the account's reality
// (e.g. whether an abliterated model is served or gated). Read-only: GET /models
// costs nothing, so this does not touch the spend ledger.
import { BASE_URL, PROVIDER_ID, PROVIDER_LABEL, key } from "./lib/inference.mjs";

const res = await fetch(`${BASE_URL}/models`, {
  headers: { authorization: `Bearer ${key()}`, accept: "application/json" },
});
console.log(`${PROVIDER_LABEL} (${PROVIDER_ID})  GET ${BASE_URL}/models → ${res.status}`);
if (!res.ok) {
  console.log((await res.text()).slice(0, 800));
  process.exit(1);
}
const json = await res.json();
const list = Array.isArray(json) ? json : (json.data ?? json.models ?? []);
console.log(`${list.length} model(s):`);
for (const m of list) {
  const id = m.id ?? m.name;
  const pricing = m.pricing ?? { input: m.input_price, output: m.output_price };
  const ctx = m.context_length ?? m.context_window ?? m.context;
  console.log("  " + JSON.stringify({ id, pricing, context: ctx }));
}
