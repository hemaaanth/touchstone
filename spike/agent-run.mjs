// Vertical slice of the real agent loop: one Contracts run end to end.
//
//   node agent-run.mjs                 run qwen-abl against the planted reentrancy bug
//   ALIAS=ds-abl node agent-run.mjs    pick the model
//   MAX_POC=20 node agent-run.mjs      raise the PoC attempt budget
//
// The agent gets real tools over a per-run Foundry sandbox: it reads the contract
// source, writes its own exploit tests, runs them offline in Docker, and must
// prove each exploit.
//
// The audit is comprehensive. One contract can have several bugs. The agent first
// ranks every suspect, worst first. Then it tries to prove each one. Each passing
// test is submitted as its own finding, and the audit keeps going. submit_finding
// never blocks and never ends the run. When the run settles, the engine replays
// every submitted test once more and records each finding with its own proof.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, defineTool, Harness, LiveDoc, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { obj, str } from "@earendil-works/pi-schema";
import { MODELS, PROVIDER_ID, charge, guard, spent } from "./lib/inference.mjs";
import { inferenceModels } from "./lib/provider.mjs";
import { cleanupWorkspace, concreteSolc, forgeTest, makeWorkspace, readTouchstone, warmSolc, writePoc } from "./lib/sandbox.mjs";
import { runPrepass } from "./lib/prepass.mjs";
import { moduleOn } from "./lib/modules.mjs";
import { fetchSource } from "./lib/fetch.mjs";
import { proveFindings } from "./lib/record.mjs";

const ctx = BACKGROUND_CONTEXT;
const ALIAS = process.env.ALIAS ?? Object.keys(MODELS)[0];
if (!MODELS[ALIAS]) {
  throw new Error(`Unknown ALIAS "${ALIAS}" for provider "${PROVIDER_ID}". Known: ${Object.keys(MODELS).join(", ")}`);
}
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

// Total run_poc attempts for the whole audit. A comprehensive audit proves
// several findings, so this is larger than a one-bug run needs. The prompt tells
// the agent the number so it can plan its attempts across suspects.
const MAX_POC = Number(process.env.MAX_POC ?? 12);
const PER_SUSPECT = 3;

// How the audit works. Shared by the lab and brief prompts. The key change from
// a one-bug run: a finding never ends the audit, and a low or medium finding
// never stops the agent from looking for a worse one.
const AUDIT = `How the audit works:
- A contract can have SEVERAL vulnerabilities. Your job is to find and prove ALL
  of them, not just the first one.
- One finding per ROOT CAUSE. A root cause is one code change that fixes it. If
  fixing bug A also stops attack B, then B is not a new finding: it is part of A's
  impact, so describe it in A's explanation. This covers bigger or smaller drains,
  the insolvency a drain leaves behind, other ways to trigger the same flaw, and a
  chain of two bugs you already have. Do not write tests for these.
- Not findings: design choices that let no attacker take or lock anyone else's
  funds. Examples: no receive() function, ETH sent by mistake staying put, or a
  user who can only lose their own funds through their own setup (such as a
  depositor contract that cannot receive ETH).
- Plan first. Before you write any test, list every suspect root cause you see,
  ranked worst first. Include suspects the analyzers did not flag. Write the list
  in your reply.
- Work down the list, worst first. Spend at most ${PER_SUSPECT} run_poc attempts on one
  suspect. If it still fails, mark it "not proven" and move on.
- Use a NEW test contract name for each suspect (for example \`ReentrancyTest\`,
  \`RoundingTest\`). Never reuse a name for a different bug.
- The moment a test passes, call submit_finding for it. Then CONTINUE with the
  next suspect. Submitting a finding never ends the audit. A low or medium finding
  never means you can skip a worse suspect.
- Submit each passing test once. One finding per test contract.
- You have ${MAX_POC} run_poc attempts in total. That is a limit, not a target.
  Unused attempts are fine. A contract with one bug should give one finding.
- Stop when every suspect root cause is proven or ruled out, or the budget is spent.
  Then write a short coverage summary: one line per suspect, marked "proven",
  "not exploitable", or "not tried".

Severity:
- critical: an attacker steals or locks most of the funds.
- high: an attacker steals some funds, or breaks the core accounting.
- medium: the loss needs unusual conditions, or it is small.
- low: no direct loss of funds.

A proof is a test that passes AND shows the harm: funds move to the attacker, or
other users' funds are locked or lost.`;

const SYSTEM = `You are an authorized offensive-security agent in an isolated sandbox.
The target is a Solidity smart contract the operator owns and has asked you to audit.
Your job: find EVERY real, exploitable vulnerability and PROVE each one with a
runnable Foundry test.

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
- When a proof passes, call submit_finding with the vulnerability class,
  severity, the name of that passing test contract, and a short explanation.

${AUDIT}

Write each explanation so a smart 15-year-old with no security or Solidity
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
have asked you to audit. Your job: find EVERY real, exploitable vulnerability in
the code the brief points at and PROVE each one with a runnable Foundry test.

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
- When a proof passes, call submit_finding with the vulnerability class,
  severity, the name of that passing test contract, and a short explanation.

${AUDIT}

Write each explanation so a smart 15-year-old with no security or Solidity
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

// Per-process audit state. One run is one process, so plain memory is enough.
//   poc     run_poc attempts so far
//   passed  test contract name -> the exact source that last passed
//   found   submitted findings, in submit order
function auditState() {
  return { poc: 0, passed: new Map(), found: [] };
}

function tools(ws, state) {
  const modules = readTouchstone(ws).modules ?? [];
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
    execute: async (args) => {
      const pocAttempts = ++state.poc;
      if (pocAttempts > MAX_POC) {
        event("run_poc-capped", { contract: args.contract_name, attempts: pocAttempts });
        const unsent = [...state.passed.keys()].filter((name) => !state.found.some((f) => f.poc === name));
        const hint = unsent.length ? ` These passing tests are not submitted yet: ${unsent.join(", ")}. Submit any that prove a real bug.` : "";
        return { output: [{ type: "text", text: `PoC attempt budget exhausted (${MAX_POC} runs used). Stop running tests.${hint} Then write the coverage summary: one line per suspect, marked "proven", "not exploitable", or "not tried".` }], isError: true };
      }
      // Surface the exact PoC source for this attempt as a versioned artifact, so
      // the console's document pane shows v1/v2/v3 of the file the agent iterates
      // on — one version per attempt, sharing a stable fileId — instead of a
      // single card mutating in place. Purely additive telemetry: it drives no
      // control flow and spends nothing. The id is unique per attempt (a new
      // version); fileId groups the rewrites of the same test file. Emitted
      // BEFORE run_poc so the file chip lands above its "Exploit attempt N" step
      // in the transcript (the reducer orders steps by event order), matching the
      // "draft, then run it" reading of the demo fixture.
      const artId = `poc-${args.contract_name}-${pocAttempts}`;
      event("artifact-open", { id: artId, fileId: `poc-${args.contract_name}`, title: `${args.contract_name}.t.sol`, kind: "poc", lang: "solidity", attempt: pocAttempts, contract: args.contract_name });
      event("artifact-delta", { id: artId, text: args.test_source });
      event("artifact-done", { id: artId });
      event("run_poc", { contract: args.contract_name, attempt: pocAttempts });
      writePoc(ws, args.test_source);
      const r = await forgeTest(ws, { matchContract: args.contract_name });
      event("run_poc-done", { contract: args.contract_name, passed: r.passed, failed: r.failed, timedOut: r.timedOut });
      // Remember the exact source that passed. submit_finding's gate reads this,
      // and the final replay proof re-runs this source, not a later edit.
      if (r.passed) state.passed.set(args.contract_name, args.test_source);
      const left = MAX_POC - pocAttempts;
      const note = r.passed && !state.found.some((f) => f.poc === args.contract_name)
        ? `\n\nThis test PASSED. If it proves a real bug, call submit_finding for \`${args.contract_name}\` now, then continue with the next suspect.`
        : "";
      return { output: [{ type: "text", text: `${r.output || "(no output)"}${note}\n\n(${left} run_poc attempt${left === 1 ? "" : "s"} left.)` }] };
    },
  });
  const submitFinding = defineTool({
    name: "submit_finding",
    description: "Record one proven vulnerability: one root cause, meaning one code fix. Call it as soon as a test passes. Never submit a second finding for the same root cause. It returns at once; then continue the audit with the next suspect.",
    parameters: obj({
      title: str(), severity: str({ description: "critical | high | medium | low" }),
      poc_contract: str({ description: "name of your passing test contract" }),
      explanation: str({ description: "Plain-language write-up a non-expert 15-year-old can follow: short sentences, one idea each, identifiers in `backticks`, every multi-line code snippet in a fenced block whose opening fence names the language (```solidity, ```javascript, ```typescript, …), and a final line starting with \"Fix:\"." }),
    }),
    replay: "safe",
    execute: async (args) => {
      const poc = String(args.poc_contract ?? "").trim();
      // Hard gate: a finding is real ONLY when its own Foundry test passed. An
      // unproven claim is refused here and can never be recorded.
      const source = state.passed.get(poc);
      if (!source) {
        event("submit-rejected", { poc, reason: "not-passed" });
        return { output: [{ type: "text", text: `Cannot record this finding: your named test \`${poc}\` has not passed run_poc in this session. A finding is only real once its own Foundry test passes and shows the harm. Make that exact test pass, then call submit_finding again.` }], isError: true };
      }
      const dup = state.found.find((f) => f.poc === poc);
      if (dup) {
        event("submit-rejected", { poc, reason: "duplicate" });
        return { output: [{ type: "text", text: `\`${poc}\` is already recorded as finding #${dup.n} ("${dup.title}"). Each finding needs its own test contract. If this is a different bug, write a new test with a new contract name. Otherwise continue with the next suspect.` }], isError: true };
      }
      const n = state.found.length + 1;
      state.found.push({ n, title: args.title, severity: args.severity, poc, explanation: args.explanation, source });
      event("finding-submitted", { n, title: args.title, severity: args.severity, poc });
      const left = Math.max(0, MAX_POC - state.poc);
      return { output: [{ type: "text", text: `Recorded finding #${n}: ${args.title} (${args.severity}). Do NOT stop. Continue with the next suspect root cause on your list, worst first. Skip anything this finding's fix would also stop. You have ${left} run_poc attempt${left === 1 ? "" : "s"} left. When every suspect is proven or ruled out, write the coverage summary.` }] };
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
  // tools the run actually enabled. It is built from .touchstone.json, so it is
  // stable for the whole run (pi-durable requires a stable tool set). list_sources, read_source, run_poc and submit_finding
  // are always present; static_findings and fuzz_findings exist only when their
  // pre-pass module ran; fetch_source only for a brief that fetches its sources.
  const out = [listSources, readSource];
  if (moduleOn(modules, "static")) out.push(staticFindings);
  if (moduleOn(modules, "fuzz")) out.push(fuzzFindings);
  if (moduleOn(modules, "fetch")) out.push(fetchSourceTool);
  out.push(runPoc, submitFinding);
  return out;
}

async function openHarness(db, ws, state) {
  const registry = createRegistry();
  registry.install(defineExtension({ name: "contracts", tools: tools(ws, state) }));
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

// Stream the agent's live thinking and prose to the UI. pi-durable commits a
// throttled partial of the in-flight response into the root conversation's
// LiveDoc (`generation.message`), so we watch that doc and, on every commit,
// re-derive the full text and reasoning of the current answer. The reducer
// REPLACES a streamed step by (conv, attempt), so emitting the growing snapshot
// types the text on screen. We key `attempt` on the run's tool-round index
// (`run.turns`), so each round's prose lands as its own step instead of
// overwriting the last. Without this a live run shows tool steps but no
// cognition — exactly the gap the operator saw. Returns the watch handle so the
// caller can stop it; a no-op if the harness has no live doc yet.
async function streamCognition(harness) {
  const w = await harness.watchDoc(LiveDoc, ROOT_CONVERSATION_ID, ctx);
  if (!w) return undefined;
  let turn = -1;
  let lastSay = "", lastThink = "";
  const emit = (live) => {
    const msg = live?.generation?.message;
    if (!msg || !Array.isArray(msg.content)) return;
    const t = live?.run?.turns ?? 0;
    // A new tool round resets the partial; start a fresh step and dedupe baseline.
    if (t !== turn) { turn = t; lastSay = ""; lastThink = ""; }
    let say = "", think = "";
    for (const b of msg.content) {
      if (b?.type === "text" && typeof b.text === "string") say += b.text;
      else if (b?.type === "thinking" && typeof b.thinking === "string") think += b.thinking;
    }
    if (think && think !== lastThink) { lastThink = think; event("thinking-delta", { attempt: turn, text: think }); }
    if (say && say !== lastSay) { lastSay = say; event("assistant-delta", { attempt: turn, text: say }); }
  };
  emit(w.value);
  w.start(async (call) => { if (call.kind === "value") emit(call.value); });
  return w;
}

async function chargeUsage(harness) {
  const u = await harness.usage(ctx);
  let usd = 0;
  const prefix = new RegExp("^" + PROVIDER_ID + "/");
  for (const [key, v] of Object.entries(u.models ?? {})) usd += charge(key.replace(prefix, ""), { input: v.input, output: v.output });
  return { usd, models: Object.fromEntries(Object.entries(u.models ?? {}).map(([k, v]) => [k, { in: v.input, out: v.output, reasoning: v.reasoning }])) };
}

// ---- Child worker: one process runs the whole audit.
async function child([, , , mode, db, ws]) {
  const state = auditState();
  const { harness, root, reports } = await openHarness(db, ws, state);
  event("opened", { mode });
  const staticBriefText = process.env.STATIC_BRIEF;
  const fuzzBriefText = process.env.FUZZ_BRIEF;
  // A brief starts with no local source and no pre-pass leads — its first move is
  // to read BRIEF.md and fetch the linked code; the proof deploys that code in a
  // local EVM with no fork and no live chain. A lab's code is already under src/.
  const base = readTouchstone(ws).kind === "brief"
    ? "Read BRIEF.md first. Fetch the sources it links with fetch_source, then audit the fetched code under vendor/. Do a complete audit: list every suspect worst first, then prove each one you can with its own passing Foundry PoC that deploys the code locally — no forking, no live chain. Submit each proven finding as soon as its test passes, and keep going until every suspect is proven or ruled out. End with the coverage summary."
    : "Audit the contract(s) under src/. Do a complete audit: list every suspect worst first, then prove each one you can with its own passing Foundry PoC. Submit each proven finding as soon as its test passes, and keep going until every suspect is proven or ruled out. End with the coverage summary.";
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
    // Stream the agent's thinking and prose to the UI for the whole live turn.
    await streamCognition(harness);
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

  let settled = await sub.wait(ctx);

  // One nudge. Models often stop after their first finding. If the agent found
  // something, still has PoC budget, and ended its turn cleanly, ask it once to
  // work through the suspects it has not tried. One nudge only, so a model that
  // truly finished just writes its coverage summary and stops.
  if (settled.status === "done" && state.found.length > 0 && state.poc < MAX_POC) {
    const list = state.found.map((f) => `#${f.n} ${f.title} (${f.severity}, test \`${f.poc}\`)`).join("\n");
    const left = MAX_POC - state.poc;
    event("audit-continue", { found: state.found.length, left });
    const more = await root.submit({
      type: "input", requestId: "continue1",
      content: `You have recorded ${state.found.length} finding${state.found.length === 1 ? "" : "s"} so far:\n${list}\n\nThe audit is not done yet. Go back to your suspect list. Try every suspect root cause you have not proven or ruled out, worst first. You have ${left} run_poc attempt${left === 1 ? "" : "s"} left. Submit a finding only for a NEW root cause, one that the fixes for the findings above would not already stop. If no such suspects are left, write the coverage summary now: one line per suspect, marked "proven", "not exploitable", or "not tried".`,
    }, ctx);
    settled = await more.wait(ctx);
  }

  const s = await summarize(root);
  const usage = await chargeUsage(harness);
  event("settled", { status: settled.status, reason: settled.reason, summary: s, findings: state.found, usage, reports });
  await harness.close(ctx);
  process.exit(0);
}

// Spawn a worker; resolve on exit.
function runChild(mode, db, ws, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [new URL(import.meta.url).pathname, "child", mode, db, ws], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const events = [];
    let buf = "", err = "";
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.startsWith("EVENT ")) { if (line.trim()) process.stderr.write("  [child] " + line + "\n"); continue; }
        const e = JSON.parse(line.slice(6));
        events.push(e);
        console.log("· " + e.ev + (e.ev === "settled" ? "" : " " + JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !["t", "ev"].includes(k))))));
      }
    });
    p.stderr.on("data", (d) => { err += d; });
    p.on("exit", (code, signal) => resolve({ code, signal, events, stderr: err.slice(-1500) }));
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

  // One worker runs the whole audit. submit_finding never blocks, so nothing
  // has to be killed or resumed; the run settles on its own.
  console.log(`\n== agent run (${ALIAS}) ==`);
  const runEnv = { ...env, ...leads };
  const first = await runChild("run", db, ws, runEnv);
  const all = first.events;
  const settled = all.find((e) => e.ev === "settled");
  const pocRuns = all.filter((e) => e.ev === "run_poc").length;

  // Structured proof delta for EACH finding — the engine's own reading of each
  // proven exploit. Each finding's exact passing source is replayed once more in
  // JSON trace mode, so its proof panel shows what the chain DID, not what the
  // test was written to assert. "Proven" binds to the submitted test only; a
  // throwaway diagnostic that happens to pass never turns a record green. Runs
  // before the workspace is torn down below.
  const findings = await proveFindings(ws, settled?.findings ?? [], all, (m) => console.log("· " + m));
  for (const f of findings) {
    console.log("· proof-delta " + JSON.stringify({ poc: f.poc, severity: f.severity, status: f.proof?.status ?? null, transfers: f.proof?.transfers?.map((t) => `${t.label}:${t.net}`) ?? [] }));
  }
  const worst = findings[0] ?? null;

  const result = {
    alias: ALIAS, approveMode: "auto", ms: Date.now() - t0,
    status: settled?.status, reason: settled?.reason,
    // The static pre-pass that fed the agent its leads. Kept in the record so the
    // report can show the feeder → proof story: a suspect Slither ranked, then
    // proven by replay. A suspect is never a finding on its own.
    static: { tool: scan.tool, engines: scan.engines, mode: scan.mode, files: scan.files, analysed: scan.analysed, suspects: scan.findings.length, top: scanEvent.top },
    // The fuzz pre-pass that fed the agent its accounting leads. Same story as
    // static: a broken invariant is a suspect the fuzzer ranked, then proven by
    // replay. A suspect is never a finding on its own.
    fuzz: { tool: fuzz.tool, engines: fuzz.engines, template: fuzz.template, applicable: fuzz.applicable, suspects: fuzz.findings.length, top: fuzzEvent.top },
    pocRuns,
    // Every proven finding, worst first, each with its own replay proof: real
    // pass/fail, gas, decoded logs, and the signed money-moved table.
    findings,
    // Back-compat single-finding fields: the worst finding.
    findingSubmitted: findings.length > 0,
    finding: worst ? { title: worst.title, severity: worst.severity, poc: worst.poc } : null,
    pocProved: worst?.pocProved ?? false,
    proof: worst?.proof ?? null,
    decision: findings.length ? "approved" : null,
    recorded: findings.length > 0,
    calls: settled?.summary?.calls?.map((c) => c.name),
    final: settled?.summary?.final?.text?.slice(0, 1200),
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
