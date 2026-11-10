// Follow-ups after the first pass:
//  a) #1369 direct: an assistant tool-call turn WITH reasoning_content, replayed with tool results. DeepSeek x3, plus a control without reasoning.
//  b) t3 again on Qwen base with a bigger max_tokens (its reasoning ate the 4k budget).
//  c) Does /v1/messages accept our models?
//  d) Can we fetch a response signature for a chat id?
import { writeFileSync } from "node:fs";
import { BASE_URL, MODELS, chat, charge, guard, key, spent } from "./lib/near.mjs";

const ADDR_A = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const ADDR_B = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const TOOLS = [{ type: "function", function: { name: "get_balance", description: "Read the native ETH balance of an address.", parameters: { type: "object", properties: { address: { type: "string" } }, required: ["address"] } } }];
const out = { replay1369: [], t3big: [], messages: null, signature: null };

// a) #1369
const REASONING = `The user wants the ETH balances of two addresses and their sum. I have a get_balance tool. I'll call it once for ${ADDR_A} and once for ${ADDR_B}, then add the two results and answer in one line.`;
for (const alias of ["ds-abl", "ds", "qwen-abl"]) {
  for (const withReasoning of [true, false]) {
    for (let rep = 0; rep < (withReasoning ? 3 : 1); rep++) {
      const assistant = {
        role: "assistant", content: "",
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "get_balance", arguments: JSON.stringify({ address: ADDR_A }) } },
          { id: "call_b", type: "function", function: { name: "get_balance", arguments: JSON.stringify({ address: ADDR_B }) } },
        ],
        ...(withReasoning ? { reasoning_content: REASONING } : {}),
      };
      const r = await chat(MODELS[alias].id, {
        messages: [
          { role: "user", content: `What is the sum of the ETH balances of ${ADDR_A} and ${ADDR_B}? Use the tools.` },
          assistant,
          { role: "tool", tool_call_id: "call_a", content: "12.5 ETH" },
          { role: "tool", tool_call_id: "call_b", content: "3.25 ETH" },
        ],
        tools: TOOLS, tool_choice: "auto", max_tokens: 3000,
      });
      const msg = r.choices?.[0]?.message ?? {};
      const row = { alias, withReasoning, rep, http: r.httpError, error: r.error?.slice(0, 200), finish: r.choices?.[0]?.finish_reason, content: (msg.content ?? "").slice(0, 120), toolCalls: msg.tool_calls?.length ?? 0, pass: !r.httpError && /15\.75/.test(msg.content ?? "") };
      out.replay1369.push(row);
      console.log("1369", JSON.stringify(row));
    }
  }
}

// b) t3 with room for reasoning
const schema = { type: "object", additionalProperties: false, properties: { title: { type: "string" }, severity: { type: "string", enum: ["critical", "high", "medium", "low"] }, contract: { type: "string" }, steps: { type: "array", items: { type: "string" }, minItems: 2 } }, required: ["title", "severity", "contract", "steps"] };
for (let rep = 0; rep < 3; rep++) {
  const r = await chat(MODELS.qwen.id, {
    messages: [{ role: "user", content: `Write a finding: the withdraw() function in Vault at ${ADDR_A} sends ETH before it zeroes the balance, so a contract can re-enter and drain it.` }],
    response_format: { type: "json_schema", json_schema: { name: "finding", strict: true, schema } },
    max_tokens: 16000,
  }, { estimateUsd: 0.025, timeoutMs: 300_000 });
  const text = r.choices?.[0]?.message?.content ?? "";
  let v; try { v = JSON.parse(text); } catch {}
  const ok = !!v && ["critical", "high", "medium", "low"].includes(v.severity) && Array.isArray(v.steps) && v.steps.length >= 2 && Object.keys(v).length === 4;
  const row = { rep, finish: r.choices?.[0]?.finish_reason, pass: ok, completion: r.usage?.completion_tokens, reasoning: r.usage?.completion_tokens_details?.reasoning_tokens };
  out.t3big.push(row);
  console.log("t3big", JSON.stringify(row));
}

// c) /v1/messages with an abliterated model
guard(0.002);
{
  const res = await fetch(`${BASE_URL}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key()}`, "x-api-key": key(), "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODELS["qwen-abl"].id, max_tokens: 400, messages: [{ role: "user", content: "Reply with the single word: ready" }] }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch {}
  if (j?.usage) charge(MODELS["qwen-abl"].id, { input: j.usage.input_tokens, output: j.usage.output_tokens });
  out.messages = { status: res.status, type: j?.type, stop: j?.stop_reason, blocks: j?.content?.map((b) => b.type), body: res.ok ? undefined : text.slice(0, 300) };
  console.log("messages", JSON.stringify(out.messages));
}

// d) signature for one non-streamed completion
{
  const r = await chat(MODELS["qwen-abl"].id, { messages: [{ role: "user", content: "Reply with the single word: ready" }], max_tokens: 400 }, { estimateUsd: 0.002 });
  const tries = [];
  for (let i = 0; i < 4; i++) {
    await new Promise((s) => setTimeout(s, 1500));
    const res = await fetch(`${BASE_URL}/signature/${encodeURIComponent(r.id)}?signing_algo=ecdsa&model=${encodeURIComponent(MODELS["qwen-abl"].id)}`, { headers: { authorization: `Bearer ${key()}`, accept: "application/json" } });
    const text = await res.text();
    let j; try { j = JSON.parse(text); } catch {}
    tries.push({ status: res.status, keys: j ? Object.keys(j) : undefined, kind: j?.signature_kind, algo: j?.signing_algo, textShape: typeof j?.text === "string" ? j.text.replace(/[0-9a-f]{64}/g, "<sha256>").slice(0, 120) : undefined, err: j?.error_code ?? (res.ok ? undefined : text.slice(0, 200)) });
    if (res.ok && j?.signature) break;
  }
  out.signature = { chatId: r.id?.slice(0, 12) + "...", tries };
  console.log("signature", JSON.stringify(out.signature));
}

writeFileSync(new URL("./results/extra.json", import.meta.url), JSON.stringify(out, null, 2));
console.log("spent total", spent().toFixed(4));
