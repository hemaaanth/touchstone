// Tests 1-4 over raw Chat Completions, so we control every request field.
// Each case runs REPS times on every model. Results go to results/raw.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { MODELS, chat, spent } from "./lib/near.mjs";

const REPS = Number(process.env.REPS ?? 3);
const ONLY = process.env.ONLY?.split(",");

const ADDR_A = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const ADDR_B = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_balance",
      description: "Read the native ETH balance of an address on the forked chain.",
      parameters: {
        type: "object",
        properties: { address: { type: "string", description: "0x-prefixed address" }, block: { type: "string", enum: ["latest", "pending"] } },
        required: ["address"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_poc",
      description: "Run a Foundry proof of concept on the fork and return the test output.",
      parameters: {
        type: "object",
        properties: { test_name: { type: "string" }, verbosity: { type: "integer", minimum: 1, maximum: 5 } },
        required: ["test_name"],
      },
    },
  },
];

function parseArgs(s) {
  try { return JSON.parse(s); } catch { return undefined; }
}
function callsOf(r) {
  // Normalize both streaming and non-streaming shapes.
  if (r.toolCalls) return r.toolCalls.map((c) => ({ name: c.name, args: parseArgs(c.arguments), raw: c.arguments, deltas: c.deltas }));
  return (r.choices?.[0]?.message?.tool_calls ?? []).map((c) => ({ name: c.function?.name, args: parseArgs(c.function?.arguments), raw: c.function?.arguments }));
}
const finishOf = (r) => r.finish ?? r.choices?.[0]?.finish_reason;
const textOf = (r) => r.text ?? r.choices?.[0]?.message?.content ?? "";

// ---- Long context haystack: deterministic, varied log lines.
function haystack(targetChars, needle, depth) {
  let x = 0x9e3779b9;
  const rnd = () => ((x ^= x << 13), (x ^= x >>> 17), (x ^= x << 5), (x >>> 0));
  const ops = ["SLOAD", "SSTORE", "CALL", "DELEGATECALL", "STATICCALL", "LOG3", "REVERT", "RETURN"];
  const lines = [];
  let n = 0;
  while (n < targetChars) {
    const l = `[trace ${String(lines.length).padStart(6, "0")}] ${ops[rnd() % ops.length]} slot=0x${rnd().toString(16).padStart(8, "0")}${rnd().toString(16).padStart(8, "0")} gas=${rnd() % 90000} from=0x${rnd().toString(16)}${rnd().toString(16)}`;
    lines.push(l);
    n += l.length + 1;
  }
  lines.splice(Math.floor(lines.length * depth), 0, needle);
  return lines.join("\n");
}

const CASES = {
  // 1a. tool_choice auto: should pick get_balance with the exact address.
  "t1-auto": async (m) => {
    const r = await chat(m.id, {
      messages: [{ role: "user", content: `What is the ETH balance of ${ADDR_A}? Use the tools.` }],
      tools: TOOLS, tool_choice: "auto", max_tokens: 3000,
    });
    if (r.httpError) return { pass: false, http: r.httpError, error: r.error };
    const c = callsOf(r);
    return { pass: c.length >= 1 && c[0].name === "get_balance" && c[0].args?.address === ADDR_A, finish: finishOf(r), calls: c };
  },
  // 1b. tool_choice required: must call a tool even for a chatty prompt.
  "t1-required": async (m) => {
    const r = await chat(m.id, {
      messages: [{ role: "user", content: "Run the PoC named test_reentrancy_drain at verbosity 3." }],
      tools: TOOLS, tool_choice: "required", max_tokens: 3000,
    });
    if (r.httpError) return { pass: false, http: r.httpError, error: r.error };
    const c = callsOf(r);
    return { pass: c.length >= 1 && c[0].name === "run_poc" && c[0].args?.test_name === "test_reentrancy_drain", finish: finishOf(r), calls: c };
  },
  // 1c. tool_choice names one function.
  "t1-named": async (m) => {
    const r = await chat(m.id, {
      messages: [{ role: "user", content: `Check ${ADDR_B}.` }],
      tools: TOOLS, tool_choice: { type: "function", function: { name: "get_balance" } }, max_tokens: 3000,
    });
    if (r.httpError) return { pass: false, http: r.httpError, error: r.error };
    const c = callsOf(r);
    return { pass: c.length === 1 && c[0].name === "get_balance" && c[0].args?.address === ADDR_B, finish: finishOf(r), calls: c };
  },
  // 1d. Bug #1367: tool_choice auto with no tools. Pass = the server does not reject it.
  "t1-auto-no-tools": async (m) => {
    const r = await chat(m.id, { messages: [{ role: "user", content: "Say ok." }], tool_choice: "auto", max_tokens: 500 }, { estimateUsd: 0.001 });
    if (r.httpError) return { pass: false, http: r.httpError, error: r.error };
    return { pass: true, finish: finishOf(r), text: textOf(r).slice(0, 40) };
  },
  // 2a. Streaming: a tool call assembled from deltas must be valid JSON.
  "t2-stream": async (m) => {
    const r = await chat(m.id, {
      messages: [{ role: "user", content: `What is the ETH balance of ${ADDR_A} at the pending block? Use the tools.` }],
      tools: TOOLS, tool_choice: "auto", max_tokens: 3000,
    }, { stream: true });
    if (r.httpError) return { pass: false, http: r.httpError, error: r.error };
    const c = callsOf(r);
    return { pass: c.length >= 1 && c[0].name === "get_balance" && c[0].args?.address === ADDR_A && c[0].args?.block === "pending", finish: r.finish, chunks: r.chunks, calls: c, usage: !!r.usage };
  },
  // 2b. Streaming parallel calls: two balances in one turn.
  "t2-stream-parallel": async (m) => {
    const r = await chat(m.id, {
      messages: [{ role: "user", content: `Get the ETH balances of ${ADDR_A} and ${ADDR_B}. Call get_balance once per address, both in this turn.` }],
      tools: TOOLS, tool_choice: "auto", parallel_tool_calls: true, max_tokens: 3000,
    }, { stream: true });
    if (r.httpError) return { pass: false, http: r.httpError, error: r.error };
    const c = callsOf(r);
    const addrs = new Set(c.filter((x) => x.name === "get_balance").map((x) => x.args?.address));
    return { pass: addrs.has(ADDR_A) && addrs.has(ADDR_B), finish: r.finish, calls: c };
  },
  // 3. JSON schema output. DeepSeek is expected to lack it; we record what happens.
  "t3-json-schema": async (m) => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
        contract: { type: "string" },
        steps: { type: "array", items: { type: "string" }, minItems: 2 },
      },
      required: ["title", "severity", "contract", "steps"],
    };
    const r = await chat(m.id, {
      messages: [{ role: "user", content: `Write a finding: the withdraw() function in Vault at ${ADDR_A} sends ETH before it zeroes the balance, so a contract can re-enter and drain it.` }],
      response_format: { type: "json_schema", json_schema: { name: "finding", strict: true, schema } },
      max_tokens: 4000,
    });
    if (r.httpError) return { pass: false, http: r.httpError, error: r.error };
    const text = textOf(r).trim();
    const v = parseArgs(text);
    const ok = v && typeof v.title === "string" && ["critical", "high", "medium", "low"].includes(v.severity) && typeof v.contract === "string" && Array.isArray(v.steps) && v.steps.length >= 2 && Object.keys(v).length === 4;
    return { pass: !!ok, finish: finishOf(r), parsed: !!v, extraKeys: v ? Object.keys(v).filter((k) => !(k in schema.properties)) : null, sample: text.slice(0, 160) };
  },
  // 4. Long context recall: one needle in about 100k tokens of trace lines, at 60% depth.
  "t4-long-context": async (m, rep) => {
    const code = `K-${7731 + rep}-QX`;
    const hay = haystack(330_000, `NOTE: the vault admin key id is ${code}. Keep it secret.`, 0.6);
    const r = await chat(m.id, {
      messages: [{ role: "user", content: `${hay}\n\nQuestion: what is the vault admin key id in the notes above? Reply with only the id.` }],
      max_tokens: 3000,
    }, { estimateUsd: 0.05, timeoutMs: 300_000 });
    if (r.httpError) return { pass: false, http: r.httpError, error: r.error };
    const text = textOf(r);
    return { pass: text.includes(code), finish: finishOf(r), promptTokens: r.usage?.prompt_tokens, answer: text.trim().slice(0, 60) };
  },
};

const results = [];
const aliases = Object.keys(MODELS).filter((a) => !ONLY || ONLY.includes(a));
// Models run in parallel; cases and reps run one after another per model.
await Promise.all(aliases.map(async (alias) => {
  const m = MODELS[alias];
  for (const [name, fn] of Object.entries(CASES)) {
    for (let rep = 0; rep < REPS; rep++) {
      const t0 = Date.now();
      let out;
      try { out = await fn(m, rep); } catch (e) { out = { pass: false, thrown: String(e?.message ?? e) }; }
      const row = { alias, case: name, rep, ms: Date.now() - t0, ...out };
      results.push(row);
      console.log(`${alias.padEnd(9)} ${name.padEnd(20)} #${rep} ${out.pass ? "PASS" : "FAIL"} ${row.ms}ms ${out.finish ?? ""} ${out.http ? "HTTP " + out.http : ""}${out.thrown ? " " + out.thrown : ""}`);
      if (String(out.thrown ?? "").startsWith("Spend cap")) throw new Error(out.thrown);
    }
  }
}));

mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
writeFileSync(new URL("./results/raw.json", import.meta.url), JSON.stringify(results, null, 2));
const table = {};
for (const r of results) {
  const k = `${r.case}`;
  (table[k] ??= {})[r.alias] = ((table[k][r.alias] ?? "") + (r.pass ? "✓" : "✗"));
}
console.table(table);
console.log("spent total", spent().toFixed(4));
