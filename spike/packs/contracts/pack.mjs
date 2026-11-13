// The Contracts pack: audit Solidity code and prove each bug with a Foundry test.
//
// A pack is one module of Touchstone (Contracts, Supply chain, Web, ...). It owns
// its prompts, its tools and its proof. The engine (agent-run.mjs) stays the same
// for every pack: it opens the harness, installs the pack's tools as one
// pi-durable extension, streams the run, and records the findings.
//
// This pack wraps open-source engines (Slither, Aderyn, Echidna, Medusa, Foundry)
// that run as separate binaries in Docker. See SKILL.md and TOOLS.md.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { defineTool } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { concreteSolc, forgeTest, readTouchstone, warmSolc, writePoc } from "../../lib/sandbox.mjs";
import { moduleOn } from "../../lib/modules.mjs";
import { fetchSource } from "../../lib/fetch.mjs";
import { event } from "../../lib/event.mjs";
import { attemptCap, leftCount, leftText } from "../../lib/attempt-cap.mjs";
import { runPrepass } from "../../lib/prepass.mjs";
import { gate, proveFindings } from "../../lib/record.mjs";
import { proofDelta } from "../../lib/proof.mjs";
import { CANDIDATE_HINT, FORGE_POC, candidateTool, forgeLookup, recordForge } from "../../lib/candidate.mjs";

// Total run_poc attempts for the whole audit. No count cap unless MAX_POC is
// set: the run's spend budget is the stop (see lib/attempt-cap.mjs). When a cap
// is set, the prompt tells the agent the number so it can plan across suspects.
const MAX_POC = attemptCap("MAX_POC");
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
- Work down the list, worst first. Give one suspect about ${PER_SUSPECT} run_poc attempts.
  If it still fails, mark it "not proven" for now and move on. Come back to it once
  the other suspects are done, if budget is left.
- Use a NEW test contract name for each suspect (for example \`ReentrancyTest\`,
  \`RoundingTest\`). Never reuse a name for a different bug.
- The moment a test passes, call submit_finding for it. Then CONTINUE with the
  next suspect. Submitting a finding never ends the audit. A low or medium finding
  never means you can skip a worse suspect.
- Submit each passing test once. One finding per test contract.
- ${MAX_POC === Infinity ? "There is no fixed count of run_poc attempts. The run's spend budget is the limit." : `You have ${MAX_POC} run_poc attempts in total. That is a limit, not a target.`}
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
other users' funds are locked or lost. The engine checks this on a replay: the
test must call a contract deployed from the audited code (src/ or vendor/), and
that call must move ETH out of it or change its storage. A test that only
asserts, only reads, or only touches contracts the test file defines is refused.`;

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
  call fetch_source with a GitHub link exactly as the brief lists it; the host
  fetches it for you into vendor/. A repo or tree link is cloned into
  vendor/<owner>__<repo>/ (with "@<ref>" for a tree link); a single-file (blob)
  link is saved under vendor/files/<owner>__<repo>@<ref>/<its path>. Only the
  brief's own GitHub links can be fetched; other URLs are refused. Fetch the
  sources the brief names before you audit.
- Only Solidity from the brief's sources can be proven. Until a fetch brings
  Solidity into vendor/, run_poc and submit_finding are closed.
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
// so a brief's cloned repo (vendor/<owner>__<repo>/.../*.sol) is fully visible, not just a
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

// Content gate (the proof surface comes from content, never from a UI hint). A
// run may prove only when Solidity from the scope itself is in the workspace:
// a lab's or folder's src/, or a member fetched into vendor/. A scope added
// under Contracts whose repos turn out to hold no Solidity keeps run_poc,
// submit_finding and prove closed, so it can only report leads, like Review.
// The agent cannot add such a file: run_poc writes only test/AgentPoc.t.sol.
export function proofOpen(ws) {
  return listSol(ws).length > 0;
}
const PROOF_CLOSED = "No Solidity from this scope is in the workspace yet (nothing under src/ or vendor/), so nothing can be proven. Fetch the GitHub links BRIEF.md lists with fetch_source first. If they hold no Solidity, this scope has no Foundry proof: report what you found as leads only.";

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
    description: "Read one source file. Pass a path list_sources printed (e.g. Vault.sol or vendor/acme__vault/src/Vault.sol), or BRIEF.md to read the brief.",
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
    description: "Fetch one of the brief's GitHub links into the workspace so you can read and compile it. Pass the URL exactly as BRIEF.md lists it: a repo or tree link is cloned into vendor/<owner>__<repo>/ (\"@<ref>\" for a tree), a blob (single-file) link is saved under vendor/files/<owner>__<repo>@<ref>/<path>. Any other URL is refused. The fetch happens on the host; the proof still runs offline.",
    parameters: obj({ url: str({ description: "one GitHub link exactly as BRIEF.md lists it" }) }),
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
      if (!proofOpen(ws)) {
        event("run_poc-closed", { contract: args.contract_name });
        return { output: [{ type: "text", text: PROOF_CLOSED }], isError: true };
      }
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
      recordForge(state, args.contract_name, r.output);
      const note = r.passed && !state.found.some((f) => f.poc === args.contract_name)
        ? `\n\nThis test PASSED. If it proves a real bug, call submit_finding for \`${args.contract_name}\` now, then continue with the next suspect.`
        : "";
      return { output: [{ type: "text", text: `${r.output || "(no output)"}${note}\n\n(${leftText(MAX_POC, pocAttempts, "run_poc")})` }] };
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
      if (!proofOpen(ws)) {
        event("submit-rejected", { poc, reason: "no-solidity" });
        return { output: [{ type: "text", text: PROOF_CLOSED }], isError: true };
      }
      // Hard gate: a finding is real ONLY when its own Foundry test passed AND
      // its replay shows harm to a scope target. Otherwise it is refused here.
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
      // Harm gate: passing is not enough. Replay the exact passing source and
      // read the trace. It must call a scope target and drain its ETH or write
      // its storage (lib/proof.mjs judgeHarm). A tautology is refused here.
      let proof = null;
      try {
        const delta = await proofDelta(ws, { source, contract: poc });
        proof = delta && gate({ kind: "forge", ...delta });
      } catch { proof = null; }
      if (!proof?.pass) {
        const why = proof?.harm?.reason ?? proof?.reason ?? "the replay produced no result";
        event("submit-rejected", { poc, reason: "no-harm", detail: String(why).slice(0, 200) });
        return { output: [{ type: "text", text: `Cannot record this finding: the replay of \`${poc}\` passed but shows no harm (${why}). A proof must call a contract deployed from the audited code and, in that call, move ETH out of it or change its storage. Rewrite the test so it performs the real attack, run it with run_poc, then call submit_finding again. ${CANDIDATE_HINT}` }], isError: true };
      }
      const n = state.found.length + 1;
      state.found.push({ n, title: args.title, severity: args.severity, poc, explanation: args.explanation, source });
      event("finding-submitted", { n, title: args.title, severity: args.severity, poc });
      return { output: [{ type: "text", text: `Recorded finding #${n}: ${args.title} (${args.severity}). Do NOT stop. Continue with the next suspect root cause on your list, worst first. Skip anything this finding's fix would also stop. ${leftText(MAX_POC, state.poc, "run_poc")} When every suspect is proven or ruled out, write the coverage summary.` }] };
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
  const forge = forgeLookup({ ws, state });
  const lookup = async (contract) => { if (!proofOpen(ws)) throw new Error("no Solidity is in the workspace yet"); return forge(contract); };
  out.push(runPoc, submitFinding, candidateTool({ pack: "contracts", state, lookup, poc: FORGE_POC }));
  return out;
}

// The first message of a run. A brief starts with no local source and no
// pre-pass leads — its first move is to read BRIEF.md and fetch the linked code;
// the proof deploys that code in a local EVM with no fork and no live chain. A
// lab's code is already under src/. `env` carries the pre-pass leads.
function kickoff(ws, env) {
  const base = readTouchstone(ws).kind === "brief"
    ? "Read BRIEF.md first. Fetch the sources it links with fetch_source, then audit the fetched code under vendor/. Do a complete audit: list every suspect worst first, then prove each one you can with its own passing Foundry PoC that deploys the code locally — no forking, no live chain. Submit each proven finding as soon as its test passes, and keep going until every suspect is proven or ruled out. End with the coverage summary."
    : "Audit the contract(s) under src/. Do a complete audit: list every suspect worst first, then prove each one you can with its own passing Foundry PoC. Submit each proven finding as soon as its test passes, and keep going until every suspect is proven or ruled out. End with the coverage summary.";
  const leadBlocks = [];
  if (env.STATIC_BRIEF) leadBlocks.push(`${env.STATIC_BRIEF}\n\nThese are leads from two static analyzers (Slither + Aderyn), scariest first; a spot both flag is a stronger lead. A lead is only real once your PoC proves it. Call static_findings for the full detail on any lead.`);
  if (env.FUZZ_BRIEF) leadBlocks.push(`${env.FUZZ_BRIEF}\n\nThese are leads from two property fuzzers (Echidna + Medusa): each is an invariant they broke from ordinary calls, and an invariant both broke is a stronger lead. A broken invariant is only a lead until your PoC reproduces it. Call fuzz_findings for the breaking call sequence.`);
  return leadBlocks.length ? `${base}\n\n${leadBlocks.join("\n\n")}` : base;
}

// One nudge. Models often stop after their first finding. If the agent found
// something and still has PoC budget, ask it once to work through the suspects
// it has not tried. Returns null when no nudge is due.
function nudge(state) {
  if (state.found.length === 0 || state.poc >= MAX_POC) return null;
  const list = state.found.map((f) => `#${f.n} ${f.title} (${f.severity}, test \`${f.poc}\`)`).join("\n");
  event("audit-continue", { found: state.found.length, left: leftCount(MAX_POC, state.poc) });
  return `You have recorded ${state.found.length} finding${state.found.length === 1 ? "" : "s"} so far:\n${list}\n\nThe audit is not done yet. Go back to your suspect list. Try every suspect root cause you have not proven or ruled out, worst first. ${leftText(MAX_POC, state.poc, "run_poc")} Submit a finding only for a NEW root cause, one that the fixes for the findings above would not already stop. If no such suspects are left, write the coverage summary now: one line per suspect, marked "proven", "not exploitable", or "not tried".`;
}

async function prepass(ws, { emit }) {
  const modules = readTouchstone(ws).modules;
  const record = {};
  const prep = await runPrepass(ws, {
    runStatic: modules == null || moduleOn(modules, "static"),
    runFuzz: modules == null || moduleOn(modules, "fuzz"),
    onStatic: (ev, scan) => {
      record.static = { tool: scan.tool, engines: scan.engines, mode: scan.mode, files: scan.files, analysed: scan.analysed, suspects: scan.findings.length, top: ev.top };
      emit(ev);
    },
    onFuzz: (ev, fuzz) => {
      record.fuzz = { tool: fuzz.tool, engines: fuzz.engines, template: fuzz.template, applicable: fuzz.applicable, suspects: fuzz.findings.length, top: ev.top };
      emit(ev);
    },
  });
  return { env: prep.runEnv, record };
}

// The pack manifest. Every pack exports this shape; see packs/README.md.
export default {
  id: "contracts",
  title: "Contracts",
  tier: "P", // passive: the code runs only in our offline sandbox
  proof: "forge", // a finding is real only when its Foundry test replays green
  system: systemFor,
  tools,
  kickoff,
  nudge,
  prepass,
  // The content gate holds at record time too: no scope Solidity, no proof.
  prove: (ws, ...rest) => (proofOpen(ws) ? proveFindings(ws, ...rest) : []),
};
