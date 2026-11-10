// Vertical slice of the real agent loop: one Contracts run end to end.
//
//   node agent-run.mjs                 run qwen-abl against the planted reentrancy bug
//   ALIAS=ds-abl node agent-run.mjs    pick the model
//   APPROVE=deny node agent-run.mjs    deny the finding instead of approving it
//
// The agent gets real tools over a per-run Foundry sandbox: it reads the contract
// source, writes its own exploit test, runs it offline in Docker, and must prove
// the drain. Recording the finding is gated behind a human decision.
//
// Durable approval, the way pi-durable intends it: the agent worker runs until it
// reaches submit_finding, persists the pending request, and the worker exits. A
// separate "decide" invocation then resumes the run over the same SQLite file and
// approves or denies it. The agent process can be fully down while waiting. This
// is exactly milestone 3's shape: the UI server is the decider.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineDoc, defineDocFamily, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { obj, str } from "@earendil-works/pi-schema";
import { MODELS, PROVIDER_ID, charge, guard, spent } from "./lib/inference.mjs";
import { inferenceModels } from "./lib/provider.mjs";
import { cleanupWorkspace, concreteSolc, forgeTest, makeWorkspace, readTouchstone, warmSolc, writePoc } from "./lib/sandbox.mjs";
import { runPrepass } from "./lib/prepass.mjs";
import { moduleOn } from "./lib/modules.mjs";
import { fetchSource } from "./lib/fetch.mjs";
import { proofDelta } from "./lib/proof.mjs";

const ctx = BACKGROUND_CONTEXT;
const ALIAS = process.env.ALIAS ?? Object.keys(MODELS)[0];
if (!MODELS[ALIAS]) {
  throw new Error(`Unknown ALIAS "${ALIAS}" for provider "${PROVIDER_ID}". Known: ${Object.keys(MODELS).join(", ")}`);
}
const APPROVE = process.env.APPROVE ?? "auto"; // auto | deny
// Which lab to audit. Defaults to the reentrancy lab (Slither's showcase); set
// TARGET=../lab/vault-accounting to run the fuzzing showcase. A relative value is
// resolved against this file; an absolute path is used as-is.
const TARGET = process.env.TARGET
  ? new URL(process.env.TARGET, import.meta.url).pathname
  : new URL("../lab/vault-reentrancy/", import.meta.url).pathname;
const DIR = new URL("./results/agent/", import.meta.url).pathname;
mkdirSync(DIR, { recursive: true });

function event(name, data = {}) {
  const line = JSON.stringify({ t: Date.now(), ev: name, ...data });
  console.log("EVENT " + line);
  if (process.env.EVENTS_FILE) appendFileSync(process.env.EVENTS_FILE, line + "\n");
}

// Approval state: one doc per request plus an index the decider watches.
const Approval = defineDocFamily({
  kind: "app.approval", version: 1, scope: "session", family: true,
  initial: (seed) => ({ ...seed, status: "pending" }),
  checkpointWhen: () => false,
});
const Pending = defineDoc({
  kind: "app.pending", version: 1, scope: "session",
  initial: () => ({ ids: [] }),
  checkpointWhen: () => false,
});
// The set of PoC contracts that have actually passed a replay. This is the hard
// gate: submit_finding records a finding ONLY if its named test is in here. It is
// durable state (not an in-memory set) so the gate holds across the resume that
// the approval step forces — the decide process never re-runs run_poc, yet still
// sees which tests passed in the original run.
const PocPassed = defineDoc({
  kind: "app.pocpassed", version: 1, scope: "session",
  initial: () => ({ names: [] }),
  checkpointWhen: () => false,
});

const SYSTEM = `You are an authorized offensive-security agent in an isolated sandbox.
The target is a Solidity smart contract the operator owns and has asked you to audit.
Your job: find a real, exploitable vulnerability and PROVE it with a runnable Foundry test.

Rules of the environment:
- The sandbox has no network. forge-std is vendored. Solidity is 0.8.38.
- Use list_sources and read_source to read the contract under src/.
- Two static analyzers (Slither + Aderyn) have already scanned the target. Call
  static_findings to read their ranked list of suspect functions and the exact
  vulnerable lines; a spot both engines flag is a stronger lead. Treat each as a
  LEAD, not a verdict: a lead counts only once your PoC proves it.
- Two property fuzzers (Echidna + Medusa) may also have run. Call fuzz_findings to
  read any invariant they broke, with the exact call sequence that broke it; an
  invariant both engines broke is a stronger lead. This finds accounting bugs (bad
  rounding, unfunded payouts, insolvency) that the static analyzers cannot see. A
  broken invariant is also only a LEAD — reproduce it as a passing Foundry PoC
  before you submit it.
- Write a Foundry test (a contract that imports forge-std/Test.sol) and run it with
  run_poc. A proof is a test that demonstrably moves funds the attacker should not
  get, and passes. Iterate on run_poc until your proof passes.
- When your proof passes, call submit_finding exactly once with the vulnerability
  class, severity, the name of your passing test contract, and a short explanation.
  submit_finding needs a human approval before it is recorded.

Write the explanation so a smart 15-year-old with no security or Solidity
background can follow it. Use Simplified Technical English: short sentences, one
idea per sentence, plain words, no jargon you do not define. Say what goes wrong,
why the contract lets it happen, and what the attacker gains. Put identifiers
(function names, variables, contract names) in \`backticks\`. Put every
multi-line code snippet in a fenced code block, and ALWAYS start the fence with
the language token for that code so it can be highlighted: \`\`\`solidity for
Solidity, \`\`\`javascript or \`\`\`typescript for JS/TS, and the matching token
for any other language. End the fence with \`\`\`. End the whole write-up with a
line that starts with "Fix:" describing the one-line change.
Keep going without asking the operator questions. Work from the actual source.`;

// A brief scope has no local source at the start. The code to audit lives behind
// the links in BRIEF.md; the agent fetches it into vendor/ with fetch_source,
// then audits and proves it the same way. The proof is still an offline Foundry
// test that deploys the contracts in a local EVM — there is no forking and no
// live chain, so a proof can never touch real funds.
const SYSTEM_BRIEF = `You are an authorized offensive-security agent in an isolated sandbox.
The operator has given you a brief — a markdown write-up of a target they own and
have asked you to audit. Your job: find a real, exploitable vulnerability in the
code the brief points at and PROVE it with a runnable Foundry test.

How this scope works:
- Read the brief first: read_source BRIEF.md. It describes the target and links
  its source code.
- The sandbox has no network, so you cannot open those links yourself. Instead
  call fetch_source with a link's URL; the host fetches it for you into vendor/.
  A GitHub repo or tree link is cloned into vendor/<repo>/; a single-file (blob)
  link is saved under vendor/files/; any other page is returned as text. Fetch
  the sources the brief names before you audit.
- After fetching, use list_sources to see every file now under src/ and vendor/,
  and read_source <path> to read any of them (pass the path list_sources shows).
- Write a Foundry test (a contract that imports forge-std/Test.sol) that imports
  the fetched contracts from vendor/, DEPLOYS them in setUp in the local EVM, and
  demonstrates the exploit. There is no chain fork and no live network — prove the
  bug against your own local deployment only. Run it with run_poc and iterate
  until it passes.
- forge-std is vendored. Solidity is chosen automatically to match each file's
  pragma, so you do not pin a compiler version.
- When your proof passes, call submit_finding exactly once with the vulnerability
  class, severity, the name of your passing test contract, and a short explanation.
  submit_finding needs a human approval before it is recorded.

Write the explanation so a smart 15-year-old with no security or Solidity
background can follow it. Use Simplified Technical English: short sentences, one
idea per sentence, plain words, no jargon you do not define. Put identifiers in
\`backticks\`, every multi-line snippet in a fenced block whose opening fence
names the language, and end with a line that starts with "Fix:".
Keep going without asking the operator questions. Work from the actual code.`;

// Which system prompt a run uses, from the workspace config. A brief needs the
// fetch-first instructions; a lab (local source) uses the standard one.
function systemFor(ws) {
  return readTouchstone(ws).kind === "brief" ? SYSTEM_BRIEF : SYSTEM;
}

const MAX_POC = Number(process.env.MAX_POC ?? 6); // bound runtime: qwen can iterate 2–11 times otherwise

// Which workspace subtrees the agent may list and read. A lab's code is copied
// into src/; a brief's fetched code lands under vendor/. Nothing else in the
// workspace is exposed — not lib/ (the vendored forge-std), not out/ (build
// artifacts), not .touchstone.json (the engine's own config).
const READ_ROOTS = ["src", "vendor"];
const FILE_READ_CAP = 512 * 1024; // 512 KB per read — a source file, not a blob

// Every .sol file under the readable roots, as workspace-relative paths. Recursive
// so a brief's cloned repo (vendor/<repo>/.../*.sol) is fully visible, not just a
// flat src/. Skips build output and vendored git/npm noise.
function listSol(ws) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try { entries = readdirSync(join(ws, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === ".git" || e.name === "node_modules" || e.name === "out") continue;
      const childRel = join(rel, e.name);
      if (e.isDirectory()) walk(childRel);
      else if (e.name.endsWith(".sol")) out.push(childRel);
    }
  };
  for (const root of READ_ROOTS) walk(root);
  return out.sort();
}

// Resolve a path the agent asked to read to an absolute path inside an allowed
// root, or null. Path-traversal guard: the resolved path must stay within ws and
// under src/ or vendor/ (or be BRIEF.md at the workspace root). A bare name
// ("Vault.sol") is also tried under src/, so a lab's flat reads keep working.
function resolveReadable(ws, raw) {
  const name = String(raw).trim();
  for (const abs of [resolve(ws, name), resolve(ws, "src", name)]) {
    const rel = relative(ws, abs);
    if (!rel || rel.startsWith("..") || rel.startsWith(sep)) continue; // escaped ws
    const top = rel.split(sep)[0];
    if (top === "src" || top === "vendor" || rel === "BRIEF.md") {
      try { if (statSync(abs).isFile()) return abs; } catch {}
    }
  }
  return null;
}

function tools(ws) {
  const modules = readTouchstone(ws).modules ?? [];
  let pocAttempts = 0;
  const listSources = defineTool({
    name: "list_sources",
    description: "List every Solidity source file available to audit, as workspace-relative paths. A lab's code is under src/; a brief's fetched code is under vendor/ (fetch it first with fetch_source).",
    parameters: obj({}),
    replay: "safe",
    execute: async () => {
      event("list_sources");
      const files = listSol(ws);
      const text = files.length ? files.join("\n") : "(no Solidity files yet — for a brief, call fetch_source on the links in BRIEF.md first)";
      return { output: [{ type: "text", text }] };
    },
  });
  const readSource = defineTool({
    name: "read_source",
    description: "Read one source file. Pass a path list_sources printed (e.g. Vault.sol or vendor/acme-vault/src/Vault.sol), or BRIEF.md to read the brief.",
    parameters: obj({ file: str({ description: "a path from list_sources, under src/ or vendor/, or BRIEF.md" }) }),
    replay: "safe",
    execute: async (args) => {
      const raw = String(args.file).trim();
      event("read_source", { file: raw });
      const abs = resolveReadable(ws, raw);
      if (!abs) return { output: [{ type: "text", text: `No such readable file: ${raw}. Pass a path list_sources shows (under src/ or vendor/), or BRIEF.md.` }], isError: true };
      let text;
      try {
        text = readFileSync(abs, "utf8");
        if (text.length > FILE_READ_CAP) text = text.slice(0, FILE_READ_CAP) + `\n\n…[truncated at ${FILE_READ_CAP} bytes]`;
      } catch { return { output: [{ type: "text", text: `Could not read: ${raw}` }], isError: true }; }
      return { output: [{ type: "text", text }] };
    },
  });
  const fetchSourceTool = defineTool({
    name: "fetch_source",
    description: "Fetch a source link from the brief into the workspace so you can read and compile it. Pass one https link: a GitHub repo or tree link is cloned into vendor/<repo>/, a GitHub blob (single-file) link is saved under vendor/files/, any other page is returned as text. The fetch happens on the host; the proof still runs offline.",
    parameters: obj({ url: str({ description: "one https:// link from the brief" }) }),
    replay: "unsafe",
    execute: async (args) => {
      const url = String(args.url).trim();
      event("fetch_source", { url });
      let report;
      try {
        report = await fetchSource(ws, url);
      } catch (e) {
        event("fetch_source-done", { url, ok: false, error: String(e?.message ?? e).slice(0, 200) });
        return { output: [{ type: "text", text: `Could not fetch ${url}: ${String(e?.message ?? e)}` }], isError: true };
      }
      // Pre-install the solc each fetched file pins into the shared cache, with
      // network, so the later offline proof can compile them. Best-effort — a warm
      // failure is not fatal; the proof just reports a clear compiler error if a
      // version is truly unavailable.
      const versions = new Set();
      for (const f of report.files ?? []) for (const p of f.pragmas ?? []) { const v = concreteSolc(p); if (v) versions.add(v); }
      const warmed = [];
      for (const v of versions) { const w = await warmSolc(v); warmed.push(`${w.version}${w.ok ? "" : " (warm failed)"}`); }
      event("fetch_source-done", { url, ok: true, kind: report.kind, files: (report.files ?? []).length, warmed });
      const lines = [report.note];
      if (report.files?.length) lines.push("", "Solidity files now available:", ...report.files.map((f) => `  ${f.path}${f.pragmas?.length ? `  (pragma ${f.pragmas.join(", ")})` : ""}`));
      if (warmed.length) lines.push("", `Compiler versions prepared: ${warmed.join(", ")}.`);
      if (report.text) lines.push("", report.text.slice(0, 8000));
      lines.push("", "Use list_sources to see all files, then read_source to read them.");
      return { output: [{ type: "text", text: lines.join("\n") }] };
    },
  });
  const runPoc = defineTool({
    name: "run_poc",
    description: "Compile and run a Foundry proof-of-concept test against the target. Pass the full Solidity source of a test file and the name of the test contract in it. Returns the real forge output.",
    parameters: obj({
      test_source: str({ description: "complete .sol source: imports forge-std/Test.sol, one or more test contracts" }),
      contract_name: str({ description: "name of the test contract to run, e.g. VaultDrainTest" }),
    }),
    replay: "unsafe",
    execute: async (args, api, c) => {
      pocAttempts++;
      if (pocAttempts > MAX_POC) {
        event("run_poc-capped", { contract: args.contract_name, attempts: pocAttempts });
        return { output: [{ type: "text", text: `PoC attempt budget exhausted (${MAX_POC} runs used). Stop iterating. If an earlier run passed, call submit_finding now with that test contract. Otherwise report that you could not prove an exploit.` }], isError: true };
      }
      event("run_poc", { contract: args.contract_name, attempt: pocAttempts });
      // Surface the exact PoC source for this attempt as a versioned artifact, so
      // the console's document pane shows v1/v2/v3 of the file the agent iterates
      // on — one version per attempt, sharing a stable fileId — instead of a
      // single card mutating in place. Purely additive telemetry: it drives no
      // control flow and spends nothing. The id is unique per attempt (a new
      // version); fileId groups the rewrites of the same test file.
      const artId = `poc-${args.contract_name}-${pocAttempts}`;
      event("artifact-open", { id: artId, fileId: `poc-${args.contract_name}`, title: `${args.contract_name}.t.sol`, kind: "poc", lang: "solidity", attempt: pocAttempts, contract: args.contract_name });
      event("artifact-delta", { id: artId, text: args.test_source });
      event("artifact-done", { id: artId });
      writePoc(ws, args.test_source);
      const r = await forgeTest(ws, { matchContract: args.contract_name });
      event("run_poc-done", { contract: args.contract_name, passed: r.passed, failed: r.failed, timedOut: r.timedOut });
      // Record a genuine pass durably, so submit_finding's gate can trust it even
      // after the process is killed and resumed at the approval step.
      if (r.passed) {
        await api.commit(async (tx) => {
          const d = await tx.doc(PocPassed);
          if (!d.names.includes(args.contract_name)) d.names.push(args.contract_name);
        }, c);
      }
      return { output: [{ type: "text", text: r.output || "(no output)" }] };
    },
  });
  const submitFinding = defineTool({
    name: "submit_finding",
    description: "Record a confirmed vulnerability finding. Needs a human approval before it is recorded. Call once, after your PoC passes.",
    parameters: obj({
      title: str(), severity: str({ description: "critical | high | medium | low" }),
      poc_contract: str({ description: "name of your passing test contract" }),
      explanation: str({ description: "Plain-language write-up a non-expert 15-year-old can follow: short sentences, one idea each, identifiers in `backticks`, every multi-line code snippet in a fenced block whose opening fence names the language (```solidity, ```javascript, ```typescript, …), and a final line starting with \"Fix:\"." }),
    }),
    replay: "safe",
    execute: async (args, api, c) => {
      // Hard gate: a finding is real ONLY when its own Foundry test passed a
      // replay. Read the durable pass-set and refuse any submission whose named
      // test is not in it. No pending request is created, so an unproven claim
      // never reaches the approval queue and can never be recorded.
      let proven = false;
      await api.commit(async (tx) => {
        const d = await tx.doc(PocPassed);
        proven = d.names.includes(args.poc_contract);
      }, c);
      if (!proven) {
        event("submit-rejected", { poc: args.poc_contract });
        return { output: [{ type: "text", text: `Cannot record this finding: your named test \`${args.poc_contract}\` has not passed run_poc in this session. A finding is only real once its own Foundry test passes and moves funds. Make that exact test pass, then call submit_finding again.` }], isError: true };
      }
      const id = await api.memo("approvalId", randomUUID(), c);
      await api.commit(async (tx) => {
        await tx.doc(Approval, id, { tool: "submit_finding", args });
        const p = await tx.doc(Pending);
        if (!p.ids.includes(id)) p.ids.push(id);
      }, c);
      event("approval-pending", { id, title: args.title, severity: args.severity, poc: args.poc_contract });
      const watch = await api.watchDoc(Approval, id, c);
      const decided = await new Promise((resolve) => {
        if (watch.value.status !== "pending") return resolve(watch.value);
        watch.start(async (call) => {
          if (call.kind === "value" && call.value.status !== "pending") resolve(call.value);
        });
      });
      await watch.stop();
      event("approval-decided", { id, status: decided.status });
      if (decided.status !== "approved") throw new Error(`Finding denied by ${decided.by ?? "reviewer"}`);
      return { output: [{ type: "text", text: `Finding recorded: ${args.title} (${args.severity}).` }] };
    },
  });
  const staticFindings = defineTool({
    name: "static_findings",
    description: "Read the static-analysis report for the target: a ranked list of suspect functions from two independent engines (Slither + Aderyn), each with the exact lines and the dangerous pattern they saw. Suspects both engines agree on are marked and ranked first. Use it to decide what to try to exploit first. A suspect is only a lead — prove it with run_poc.",
    parameters: obj({}),
    replay: "safe",
    execute: async () => {
      event("static_findings");
      let items = [];
      try { items = JSON.parse(process.env.STATIC_JSON || "[]"); } catch { items = []; }
      if (!items.length) return { output: [{ type: "text", text: "Static analysis reported no actionable suspects. Audit the source directly." }] };
      const text = items
        .map((d, i) => {
          const engines = Array.isArray(d.engines) && d.engines.length ? d.engines.join(" + ") : "Slither";
          const agree = d.corroborated ? ` — ${engines} AGREE here (stronger lead)` : ` — flagged by ${engines}`;
          const loc = d.where ? ` at ${d.where}` : d.file ? ` in ${d.file}` : "";
          const line = d.lines?.length ? ` (line ${d.lines[0]})` : "";
          const checks = Array.isArray(d.checks) && d.checks.length > 1 ? `\ndetectors: ${d.checks.join(", ")}` : "";
          return `#${i + 1} [${d.impact}${d.confidence ? "/" + d.confidence : ""}] ${d.check}${loc}${line}${agree}${checks}\n${d.description}`;
        })
        .join("\n\n");
      return { output: [{ type: "text", text }] };
    },
  });
  const fuzzFindings = defineTool({
    name: "fuzz_findings",
    description: "Read the property fuzzer report for the target: any invariant two independent fuzzers (Echidna + Medusa) broke, with the exact sequence of ordinary deposits and withdrawals that broke it. This catches accounting bugs a static analyzer cannot see. Invariants both fuzzers broke are marked and ranked first. A broken invariant is only a lead — reproduce it with run_poc before you submit it.",
    parameters: obj({}),
    replay: "safe",
    execute: async () => {
      event("fuzz_findings");
      let items = [];
      try { items = JSON.parse(process.env.FUZZ_JSON || "[]"); } catch { items = []; }
      if (!items.length) return { output: [{ type: "text", text: "Property fuzzing broke no invariant (or no fuzz template fit this target). Audit the source directly." }] };
      const text = items
        .map((d, i) => {
          const engines = Array.isArray(d.engines) && d.engines.length ? d.engines.join(" + ") : "Echidna";
          const agree = d.corroborated ? ` — ${engines} AGREE (stronger lead)` : ` — broken by ${engines}`;
          return `#${i + 1} [${d.impact}] ${d.check} at ${d.where} (invariant ${d.property})${agree}\n${d.description}${d.sequence?.length ? `\nBreaking call sequence: ${d.sequence.join(" → ")}` : ""}`;
        })
        .join("\n\n");
      return { output: [{ type: "text", text }] };
    },
  });
  // The tool set is gated on this run's module plan, so the agent holds only the
  // tools the run actually enabled — and the run child and the decide child build
  // the identical set from .touchstone.json, so the resume at the approval step
  // sees the same tools the original run did (pi-durable requires a stable tool
  // set across a resume). list_sources, read_source, run_poc and submit_finding
  // are always present; static_findings and fuzz_findings exist only when their
  // pre-pass module ran; fetch_source only for a brief that fetches its sources.
  const out = [listSources, readSource];
  if (moduleOn(modules, "static")) out.push(staticFindings);
  if (moduleOn(modules, "fuzz")) out.push(fuzzFindings);
  if (moduleOn(modules, "fetch")) out.push(fetchSourceTool);
  out.push(runPoc, submitFinding);
  return out;
}

async function openHarness(db, ws) {
  const registry = createRegistry();
  registry.install(defineExtension({ name: "contracts", tools: tools(ws) }));
  const reports = [];
  const harness = await Harness.open(await openNodeSqliteStorage(db), {
    models: inferenceModels(),
    registry,
    settings: { retry: { maxRetries: 2 }, stream: { timeoutMs: 180_000 } },
    onReport: (r) => reports.push({ kind: r.kind, reason: r.reason, msg: String(r.error?.message ?? r.error ?? "").slice(0, 200) }),
  }, ctx);
  const root = await harness.root(ctx, {
    agent: { model: { provider: PROVIDER_ID, modelId: MODELS[ALIAS].id }, instructions: systemFor(ws) },
  });
  return { harness, root, reports };
}

async function summarize(root) {
  const view = await root.context(ctx);
  const calls = [], results = [], assistants = [];
  for (const m of view.messages) {
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      const tc = m.content.filter((b) => b.type === "toolCall");
      tc.forEach((b) => calls.push({ name: b.name, args: b.arguments }));
      assistants.push({ stop: m.stopReason, text: text.slice(0, 4000), toolCalls: tc.length, error: m.errorMessage?.slice(0, 200) });
    }
    if (m.role === "toolResult") {
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      results.push({ name: m.toolName, isError: !!m.isError, text: text.slice(0, 300) });
    }
  }
  return { calls, results, assistants, final: assistants.at(-1) };
}

async function chargeUsage(harness) {
  const u = await harness.usage(ctx);
  let usd = 0;
  const prefix = new RegExp("^" + PROVIDER_ID + "/");
  for (const [key, v] of Object.entries(u.models ?? {})) usd += charge(key.replace(prefix, ""), { input: v.input, output: v.output });
  return { usd, models: Object.fromEntries(Object.entries(u.models ?? {}).map(([k, v]) => [k, { in: v.input, out: v.output, reasoning: v.reasoning }])) };
}

// ---- Child worker: one process, one mode.
async function child([, , , mode, db, ws]) {
  const { harness, root, reports } = await openHarness(db, ws);
  event("opened", { mode });
  if (mode === "decide") {
    harness.resume();
    // The decider: watch the pending index and approve/deny each request.
    const seen = new Set();
    const decide = async (ids) => {
      for (const id of ids) {
        await new Promise((r) => setTimeout(r, 400)); // a beat, as a human would take
        const status = APPROVE === "deny" ? "denied" : "approved";
        event("host-deciding", { id, status });
        await harness.commit(async (tx) => {
          const d = await tx.doc(Approval, id, { tool: "?", args: {} });
          d.status = status; d.by = "operator";
        }, ctx);
      }
    };
    const w = await harness.watchDoc(Pending, ctx);
    const handle = (v) => { const fresh = (v?.ids ?? []).filter((i) => !seen.has(i)); fresh.forEach((i) => seen.add(i)); if (fresh.length) decide(fresh); };
    if (w) { handle(w.value); w.start(async (call) => { if (call.kind === "value") handle(call.value); }); }
  }
  // Same requestId resumes the same submission after a restart.
  const staticBriefText = process.env.STATIC_BRIEF;
  const fuzzBriefText = process.env.FUZZ_BRIEF;
  // A brief starts with no local source and no pre-pass leads — its first move is
  // to read BRIEF.md and fetch the linked code; the proof deploys that code in a
  // local EVM with no fork and no live chain. A lab's code is already under src/.
  const base = readTouchstone(ws).kind === "brief"
    ? "Read BRIEF.md first. Fetch the sources it links with fetch_source, then audit the fetched code under vendor/. Find an exploitable vulnerability and prove it with a passing Foundry PoC that deploys the code locally and moves funds to an attacker — no forking, no live chain — then submit the finding."
    : "Audit the contract(s) under src/. Find an exploitable vulnerability, prove it with a passing Foundry PoC that moves funds to an attacker, then submit the finding.";
  const leadBlocks = [];
  if (staticBriefText) leadBlocks.push(`${staticBriefText}\n\nThese are leads from two static analyzers (Slither + Aderyn), scariest first; a spot both flag is a stronger lead. A lead is only real once your PoC proves it. Call static_findings for the full detail on any lead.`);
  if (fuzzBriefText) leadBlocks.push(`${fuzzBriefText}\n\nThese are leads from two property fuzzers (Echidna + Medusa): each is an invariant they broke from ordinary calls, and an invariant both broke is a stronger lead. A broken invariant is only a lead until your PoC reproduces it. Call fuzz_findings for the breaking call sequence.`);
  const sub = await root.submit({
    type: "input", requestId: "run1",
    content: leadBlocks.length ? `${base}\n\n${leadBlocks.join("\n\n")}` : base,
  }, ctx);

  // Native steering. While the run is in flight the UI server writes operator
  // messages to our stdin, one JSON line ({"text":"…"}) each. We inject each into
  // the agent's current turn with whenBusy:"steer" — pi-durable native steering,
  // so the message rides into the running generation instead of queuing a fresh
  // run. We emit "operator-message" only once the steer is admitted, so the
  // transcript shows a message exactly when it actually landed. In CLI mode stdin
  // is /dev/null, so this reader simply never fires.
  if (mode === "run") {
    let steerSeq = 0;
    let stdinBuf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      stdinBuf += chunk;
      let i;
      while ((i = stdinBuf.indexOf("\n")) >= 0) {
        const line = stdinBuf.slice(0, i);
        stdinBuf = stdinBuf.slice(i + 1);
        if (!line.trim()) continue;
        let text;
        try { text = JSON.parse(line).text; } catch { continue; }
        if (typeof text !== "string" || !text.trim()) continue;
        steerSeq += 1;
        root.submit({ type: "input", requestId: `steer-${steerSeq}`, content: text, whenBusy: "steer" }, ctx)
          .then(() => event("operator-message", { text }))
          .catch((e) => event("steer-error", { text, error: String(e?.message ?? e) }));
      }
    });
    process.stdin.on("error", () => {});
    process.stdin.resume();
  }

  const settled = await sub.wait(ctx);
  const s = await summarize(root);
  const pending = await harness.snapshot(Pending, ctx);
  const usage = await chargeUsage(harness);
  event("settled", { status: settled.status, reason: settled.reason, summary: s, pendingIds: pending?.ids, usage, reports });
  await harness.close(ctx);
  process.exit(0);
}

// Spawn a worker; resolve on exit. killOn(evt) returns ms to wait before SIGKILL, else undefined.
function runChild(mode, db, ws, env, killOn) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [new URL(import.meta.url).pathname, "child", mode, db, ws], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const events = [];
    let killed = false, buf = "", err = "";
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.startsWith("EVENT ")) { if (line.trim()) process.stderr.write("  [child] " + line + "\n"); continue; }
        const e = JSON.parse(line.slice(6));
        events.push(e);
        console.log("· " + e.ev + (e.ev === "settled" ? "" : " " + JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !["t", "ev"].includes(k))))));
        const wait = !killed && killOn ? killOn(e) : undefined;
        if (wait !== undefined) { killed = true; setTimeout(() => p.kill("SIGKILL"), wait); }
      }
    });
    p.stderr.on("data", (d) => { err += d; });
    p.on("exit", (code, signal) => resolve({ code, signal, killed, events, stderr: err.slice(-1500) }));
  });
}

async function main() {
  guard(0.25); // one agent run; well under the $2 NEAR cap
  const db = `${DIR}run-${ALIAS}.sqlite`;
  for (const f of [db, db + "-wal", db + "-shm"]) rmSync(f, { force: true });
  const ws = makeWorkspace(TARGET);
  const env = { EVENTS_FILE: `${DIR}run-${ALIAS}.events` };
  rmSync(env.EVENTS_FILE, { force: true });
  const t0 = Date.now();

  // The pre-pass ensemble — static analyzers (Slither + Aderyn) then property
  // fuzzers (Echidna + Medusa) — scans the target before the agent starts and
  // hands it a ranked suspect list. Where two engines agree, the suspect ranks
  // higher; that agreement is a stronger lead, never a verdict. A suspect is only
  // real once the agent turns it into a passing PoC. runPrepass is the SAME code
  // the web app runs, so a CLI run and a live run drive the identical pipeline and
  // emit byte-identical scan events. Callbacks print the CLI's progress and append
  // each event to the events file; the returned runEnv carries the leads to the
  // run worker.
  const { scan, scanEvent, fuzz, fuzzEvent, runEnv: leads } = await runPrepass(ws, {
    onStaticStart: () => console.log(`\n== static analysis (Slither + Aderyn) ==`),
    onStatic: (ev, scanResult) => {
      appendFileSync(env.EVENTS_FILE, JSON.stringify(ev) + "\n");
      console.log("· static-scan " + JSON.stringify({ mode: scanResult.mode, engines: ev.engines, suspects: ev.suspects, top: ev.top.map((x) => `${x.impact}:${x.check}${x.corroborated ? "*" : ""}`) }));
    },
    onFuzzStart: () => console.log(`\n== fuzzing (Echidna + Medusa) ==`),
    onFuzz: (ev) => {
      appendFileSync(env.EVENTS_FILE, JSON.stringify(ev) + "\n");
      console.log("· fuzz-scan " + JSON.stringify({ applicable: ev.applicable, engines: ev.engines, suspects: ev.suspects, top: ev.top.map((x) => `${x.impact}:${x.check}${x.corroborated ? "*" : ""}`) }));
    },
  });

  // Phase 1: run the agent until it reaches the approval point (then kill it, to
  // prove the run survives the process going away), or until it settles on its own.
  console.log(`\n== phase 1: agent run (${ALIAS}) ==`);
  const runEnv = { ...env, ...leads };
  const first = await runChild("run", db, ws, runEnv, (e) => (e.ev === "approval-pending" ? 1200 : undefined));

  // Phase 2: only if a finding is pending — resume over the same DB and decide it.
  let second = null;
  if (first.events.some((e) => e.ev === "approval-pending")) {
    console.log(`\n== phase 2: resume + ${APPROVE === "deny" ? "deny" : "approve"} ==`);
    second = await runChild("decide", db, ws, env, null);
  }

  const all = [...first.events, ...(second?.events ?? [])];
  const settled = (second ?? first).events.find((e) => e.ev === "settled");
  const pocRuns = all.filter((e) => e.ev === "run_poc").length;
  const decided = all.find((e) => e.ev === "approval-decided");
  const pendingEv = all.find((e) => e.ev === "approval-pending");
  // "Proven" binds to the SUBMITTED test, not any passing test. A throwaway
  // diagnostic that happens to pass must never turn the record green — only the
  // exact contract the finding claims, proving its own exploit, counts. The
  // submit_finding gate already refuses an unproven submission, so a pending
  // finding's named test has passed; we re-check it here so the stored record
  // carries the binding, not just the live gate.
  const provenContract = pendingEv?.poc ?? null;
  const pocPassed = provenContract
    ? all.some((e) => e.ev === "run_poc-done" && e.passed && e.contract === provenContract)
    : false;

  // Structured proof delta — the engine's own reading of the proven exploit.
  // When a finding proved, re-run its exact test ONE more time in JSON trace mode
  // and read the real money the EVM moved, per address, straight from the trace.
  // This replaces source-regex guesswork with machine truth: the proof panel shows
  // what the chain DID, not what the test was written to assert. We reconstruct
  // the proving source from the agent's last run_poc call for the proven contract,
  // and run it before the workspace is torn down below.
  let proof = null;
  if (pocPassed && provenContract) {
    const pocCalls = (settled?.summary?.calls ?? []).filter(
      (c) => c.name === "run_poc" && c.args?.contract_name === provenContract && c.args?.test_source,
    );
    const source = pocCalls.at(-1)?.args?.test_source ?? null;
    if (source) {
      try {
        proof = await proofDelta(ws, { source, contract: provenContract });
      } catch (err) {
        console.log("· proof-delta failed:", String(err?.message || err).slice(0, 200));
      }
    }
    if (proof) {
      console.log(
        "· proof-delta " +
          JSON.stringify({
            status: proof.status,
            gas: proof.gasUsed,
            transfers: proof.transfers.map((t) => `${t.label}:${t.net}`),
          }),
      );
    }
  }

  const result = {
    alias: ALIAS, approveMode: APPROVE, ms: Date.now() - t0,
    status: settled?.status, reason: settled?.reason,
    // The static pre-pass that fed the agent its leads. Kept in the record so the
    // report can show the feeder → proof story: a suspect Slither ranked, then
    // proven by replay. A suspect is never a finding on its own.
    static: { tool: scan.tool, engines: scan.engines, mode: scan.mode, files: scan.files, analysed: scan.analysed, suspects: scan.findings.length, top: scanEvent.top },
    // The fuzz pre-pass that fed the agent its accounting leads. Same story as
    // static: a broken invariant is a suspect the fuzzer ranked, then proven by
    // replay. A suspect is never a finding on its own.
    fuzz: { tool: fuzz.tool, engines: fuzz.engines, template: fuzz.template, applicable: fuzz.applicable, suspects: fuzz.findings.length, top: fuzzEvent.top },
    pocRuns, pocProved: pocPassed,
    // The engine's structured proof delta for the proven exploit: real pass/fail,
    // gas, decoded logs, and the signed money-moved table read from the trace.
    // Null when nothing proved or the replay produced no parsable JSON.
    proof,
    findingSubmitted: !!pendingEv, finding: pendingEv ? { title: pendingEv.title, severity: pendingEv.severity, poc: pendingEv.poc } : null,
    decision: decided?.status ?? null,
    recorded: decided?.status === "approved",
    killedAfterApproval: first.killed,
    calls: settled?.summary?.calls?.map((c) => c.name),
    final: settled?.summary?.final?.text?.slice(0, 400),
    usage: settled?.usage, reports: settled?.reports,
  };
  writeFileSync(`${DIR}run-${ALIAS}.json`, JSON.stringify({ result, transcript: settled?.summary }, null, 2));
  cleanupWorkspace(ws);

  console.log("\n==== run summary ====");
  console.log(JSON.stringify(result, null, 2));
  console.log("spent total NEAR $", spent().toFixed(4));
}

const cmd = process.argv[2];
if (cmd === "child") await child(process.argv);
else await main();
