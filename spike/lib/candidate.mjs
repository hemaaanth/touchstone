// The candidate tier (docs/candidate-tier.md).
//
// A candidate sits between a proven finding and a lead. The agent ran a real
// attempt and saw harm, but the pack's proof model did not fire. The record
// keeps the captured evidence, says the agent asserted it, and waits for a
// human. A candidate is never proven: makeCandidate sets the fixed fields last,
// so no input can change them.
//
// Each proving pack gives `candidateTool` one `lookup(poc)`:
//   null                      no recorded attempt with that id: refused
//   { proved: true }          the attempt met the proof model: use submit_finding
//   { evidence, text, rootCause? }
//                             the captured evidence, the text the agent may cite
//                             from, and the root-cause key for the dup guard
import { defineTool } from "@earendil-works/pi-durable";
import { arr, obj, str } from "@earendil-works/pi-schema";
import { event } from "./event.mjs";
import { redactSecret, sha256 } from "./proof-evidence.mjs";
import { proofDelta } from "./proof.mjs";
import { gate } from "./record.mjs";
import { LangEn } from "ethers";

export const CANDIDATE_CAP = 3;
export const WHY_UNPROVEN = "No check covers this class yet.";
export const SEVERITIES = ["critical", "high", "medium", "low", "informational"];

// The line each pack adds to its "no proof" message.
export const CANDIDATE_HINT = `If you are confident this is a real, serious vulnerability that this pack's checks do not cover, record it with submit_candidate. It is marked unproven and queued for human review, not dropped. Use it rarely: at most ${CANDIDATE_CAP} per run.`;

// ---------------------------------------------------------------- scrub

const SECRET_NAME = /secret|private|token|passw|api[-_]?key|credential|authorization|cookie|session|mnemonic|seed/i;
// The name in NAME=value that marks the value as a secret.
const SECRET_VAR = /secret|token|passw|private|credential|api_?key|access_?key|(?:^|_)key(?:$|_)|^pwd$/i;
// A value under one of these names is a hash, a log topic or calldata. Its
// 64-hex words are not keys. A secret name still wins.
const HASH_NAME = /hash|sha\d*$|digest|topics?$|calldata|^(?:data|input)$/i;
const BIP39 = new Set(Array.from({ length: 2048 }, (_, i) => LangEn.wordlist().getWord(i)));

// Each regex is linear: every start sits at the start of a token run, and no
// quantifier can backtrack over text another quantifier also takes. The test
// runs each one on a 1 MB line. A `keep` group stays readable; `name` must
// pass SECRET_VAR or the match is left alone.
//
// A hex signing key: exactly 64 hex, so a calldata word inside a longer run
// stays. A value labelled as a hash in the text (snapshotHash: ...) stays.
const HEX_KEY = /(?<![0-9A-Za-z_])(?<!(?:[Hh]ash|HASH|sha256|[Tt]opics?|[Dd]igest)["']?\s{0,3}[:=]\s{0,3}["']?)(?:0x)?[0-9a-fA-F]{64}(?![0-9A-Za-z_])/g;
const SHAPES = [
  // A PEM private key, to its END line or to the end of its base64 body.
  /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[A-Za-z0-9+/=\s\\]*(?:-----END [A-Z ]{0,40}PRIVATE KEY-----)?/g,
  HEX_KEY,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /\bsk-[A-Za-z0-9_-]{16,}/g, // API keys shaped sk-...
  /(?<keep>\b(?:[Bb]earer|[Bb]asic)[ \t]+)[A-Za-z0-9._~+/=-]{6,}/g, // an Authorization value
  // NAME=value, where NAME says secret: env lines, query strings, form bodies.
  /(?<keep>(?<![A-Za-z0-9_])(?=(?<name>[A-Za-z_][A-Za-z0-9_]*))\k<name>=["']?)(?!\[REDACTED)[^\s"'&;,<>]{3,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // an AWS access key id
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, // a GitHub token
  /(?<keep>:\/\/[^/\s:@]{1,128}:)[^@\s/]{1,256}(?=@)/g, // user:password@ in a URL
];
// A run of 12 or more lowercase words. Only its BIP-39 stretches are redacted.
const WORD_RUN = /(?<![A-Za-z])[a-z]{3,8}(?:[ \t]+[a-z]{3,8}){11,}(?![A-Za-z])/g;

const fp = (v) => `[REDACTED sha256:${redactSecret(v).sha256.slice(0, 12)}]`;
const globalOf = (re) => (re.global ? re : new RegExp(re.source, `${re.flags}g`));

function redact(m, ...rest) {
  if (!m) return m;
  const groups = typeof rest.at(-1) === "object" ? rest.at(-1) : null;
  if (groups?.name !== undefined && !SECRET_VAR.test(groups.name)) return m;
  const keep = groups?.keep ?? "";
  return keep + fp(m.slice(keep.length));
}

// A seed phrase: 12 or more words in a row, each from the BIP-39 list.
function redactSeed(run) {
  const parts = run.split(/([ \t]+)/);
  let out = "";
  for (let i = 0; i < parts.length; ) {
    let j = i;
    while (j < parts.length && BIP39.has(parts[j])) j += 2;
    if ((j - i) / 2 >= 12) {
      out += fp(parts.slice(i, j - 1).join("")) + (parts[j - 1] ?? "");
      i = j;
    } else {
      out += parts[i] + (parts[i + 1] ?? "");
      i += 2;
    }
  }
  return out;
}

export function scrubText(text, extra = [], { hex = true } = {}) {
  let out = String(text ?? "");
  const shapes = hex ? SHAPES : SHAPES.filter((re) => re !== HEX_KEY);
  for (const re of [...shapes, ...extra.map(globalOf)]) out = out.replace(re, redact);
  return out.replace(WORD_RUN, redactSeed);
}

export function scrubValue(value, name = "", extra = []) {
  if (value == null) return value;
  if (typeof value === "string") {
    if (SECRET_NAME.test(name) && value) return fp(value);
    return scrubText(value, extra, { hex: !HASH_NAME.test(name) });
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, name, extra));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubValue(v, k, extra)]));
}

// ---------------------------------------------------------------- record

const MAX_STRING = 4000;
const MAX_ITEMS = 60;
const MAX_JSON = 96_000;

// A copy of the evidence small enough to store and send. Long strings and
// long lists are cut, and say so.
export function capEvidence(value, depth = 0) {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… [cut ${value.length - MAX_STRING} chars]` : value;
  if (typeof value !== "object" || depth > 8) return String(value).slice(0, 200);
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ITEMS).map((v) => capEvidence(v, depth + 1));
    if (value.length > MAX_ITEMS) out.push(`… [cut ${value.length - MAX_ITEMS} items]`);
    return out;
  }
  const out = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, capEvidence(v, depth + 1)]));
  const json = JSON.stringify(out);
  return json.length > MAX_JSON ? { cut: true, text: json.slice(0, MAX_JSON) } : out;
}

// The one way to build a candidate. The fixed fields come last.
export function makeCandidate({ n, pack, title, severity, poc, evidence, explanation, cites = [], rootCause = null, evidenceHash = null }) {
  return {
    n: Number(n) || 1,
    pack: String(pack ?? ""),
    title: String(title ?? "").slice(0, 200),
    severity: SEVERITIES.includes(severity) ? severity : "medium",
    poc: String(poc ?? ""),
    evidence: capEvidence(evidence ?? null),
    explanation: String(explanation ?? ""),
    cites: Array.isArray(cites) ? cites.map(String) : [],
    rootCause: rootCause == null ? null : String(rootCause),
    evidenceHash: evidenceHash == null ? null : String(evidenceHash),
    kind: "candidate",
    assertedBy: "agent",
    proven: false,
    candidate: true,
    provedBy: null,
  };
}

// The candidate state a resumed run must get back. The list holds the cap, the
// numbering and every duplicate guard, so it is all that needs saving. `save`
// runs after each new candidate; `saved` is what it last wrote. Recorded
// attempts (state.attempts) stay in memory: after a restart, an attempt from
// before it cannot be cited, and the agent must run it again.
export function candidateState(saved = [], save = () => {}) {
  const list = (Array.isArray(saved) ? saved : []).map((c) => makeCandidate(c ?? {}));
  const push = list.push.bind(list);
  list.push = (...items) => {
    const n = push(...items);
    save(list);
    return n;
  };
  return list;
}

export const isCandidate = (r) => r?.candidate === true || r?.kind === "candidate";

// The short form carried to a follow-up worker, so its guards and numbering
// see the candidates the run already has.
export const priorCandidate = ({ n, title, severity, poc, rootCause, evidenceHash }) => ({ n, title, severity, poc, rootCause, evidenceHash });

// ---------------------------------------------------------------- tool

const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const text = (value, isError = false) => ({ output: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) });

// The checks, in order. Returns { refused } or { candidate }.
// `packText`: the pack writes the title and write-up from the attempt
// (attempt.packText), and the agent's prose is never stored.
export async function checkCandidate({ pack, state, lookup, args, scrub = scrubValue, scrubLine = scrubText, packText = false }) {
  state.candidates ??= [];
  const poc = String(args.poc ?? "").trim();
  const refuse = (reason, message) => {
    event("candidate-rejected", { poc, reason });
    return { refused: message, reason };
  };
  if (state.candidates.length >= CANDIDATE_CAP) {
    return refuse("cap", `Cannot record this candidate: this run already has ${CANDIDATE_CAP} candidates, the most a run may hold. A candidate costs a human's attention. Keep auditing for proven findings, or write the coverage summary.`);
  }
  if (!poc) return refuse("no-attempt", "Cannot record this candidate: name the recorded attempt it comes from.");
  const finding = state.found.find((f) => f.poc === poc);
  if (finding) return refuse("duplicate", `"${poc}" is already recorded as finding #${finding.n} ("${finding.title}"). A candidate cannot repeat a finding.`);
  const twin = state.candidates.find((c) => c.poc === poc);
  if (twin) return refuse("duplicate", `"${poc}" is already recorded as candidate #${twin.n} ("${twin.title}").`);
  let attempt;
  try { attempt = await lookup(poc); } catch (err) { attempt = { error: String(err?.message ?? err).slice(0, 200) }; }
  if (attempt?.error) return refuse("no-evidence", `Cannot record this candidate: the attempt "${poc}" could not be read back (${attempt.error}).`);
  if (!attempt) return refuse("no-attempt", `Cannot record this candidate: "${poc}" is not a recorded attempt in this session. A candidate needs real captured evidence, never a bare claim. Run the attempt first, then cite it.`);
  if (attempt.proved) return refuse("proved", `Not a candidate: the attempt "${poc}" met this pack's proof model. It is a real finding. Call submit_finding with "${poc}" instead.`);
  const rootCause = attempt.rootCause ?? null;
  if (rootCause) {
    const sameRoot = state.found.find((f) => f.rootCause === rootCause) ?? state.candidates.find((c) => c.rootCause === rootCause);
    if (sameRoot) return refuse("duplicate-root-cause", `This root cause is already recorded as ${sameRoot.candidate ? "candidate" : "finding"} #${sameRoot.n} ("${sameRoot.title}"). One record per root cause.`);
  }
  const evidenceHash = sha256(JSON.stringify(attempt.evidence ?? null));
  const sameEvidence = state.candidates.find((c) => c.evidenceHash === evidenceHash);
  if (sameEvidence) return refuse("duplicate-evidence", `This evidence is already recorded as candidate #${sameEvidence.n} ("${sameEvidence.title}").`);
  const severity = String(args.severity ?? "").trim().toLowerCase();
  if (!SEVERITIES.includes(severity)) return refuse("bad-input", `Severity must be one of: ${SEVERITIES.join(", ")}.`);
  const own = packText ? attempt.packText : null;
  if (packText && !own) return refuse("no-evidence", `Cannot record this candidate: the attempt "${poc}" has no text from the pack.`);
  const explanation = own ? String(own.explanation ?? "") : String(args.explanation ?? "");
  if (!own && !/\bFix:/.test(explanation)) return refuse("bad-input", "The write-up must end with a line starting \"Fix:\".");
  const cites = (Array.isArray(args.evidence_lines) ? args.evidence_lines : []).map((l) => String(l).trim()).filter(Boolean);
  if (cites.length === 0 || cites.length > 6) return refuse("bad-input", "Cite 1 to 6 exact lines from the attempt's output in evidence_lines.");
  const haystack = squash(attempt.text);
  const missing = cites.find((c) => squash(c).length < 8 || !haystack.includes(squash(c)));
  if (missing) return refuse("bad-cite", `Cannot record this candidate: the cited line "${missing.slice(0, 120)}" is not in the evidence of "${poc}" (or is shorter than 8 characters). Quote the exact lines that show the harm.`);
  const n = state.candidates.length + 1;
  // The pack's own scrub first (it knows its secret shapes), then the shared one.
  const line = (t) => scrubText(scrubLine(String(t ?? "")));
  const candidate = makeCandidate({
    n, pack, poc, severity, rootCause, evidenceHash,
    title: line(own ? own.title : args.title),
    explanation: line(explanation),
    cites: cites.map(line),
    evidence: scrubValue(scrub(attempt.evidence)),
  });
  state.candidates.push(candidate);
  event("candidate-submitted", { candidate });
  return { candidate };
}

// The submit_candidate tool. `poc` names the pack's attempt id (label, test
// contract or lead id) and how to describe it to the agent.
export function candidateTool({ pack, state, lookup, poc, scrub, scrubLine, packText = false }) {
  const prose = packText ? {} : {
    title: str({ description: "short title" }),
    explanation: str({ description: "plain-language write-up: what happened, why it is harmful, why the checks miss it, ending with a line starting \"Fix:\"" }),
  };
  return defineTool({
    name: "submit_candidate",
    description: `Record a CANDIDATE: a serious problem your own attempt showed, that this pack's proof checks do not cover. It is stored as unproven and agent-asserted, and queued for human review. It never counts as a finding. Use it only after an attempt that captured evidence but did not prove. If the attempt proved, use submit_finding. At most ${CANDIDATE_CAP} per run.`,
    parameters: obj({
      ...prose,
      severity: str({ description: "critical | high | medium | low | informational" }),
      poc: str({ description: poc }),
      evidence_lines: arr(str(), { description: "1 to 6 exact lines copied from that attempt's output that show the harm" }),
    }),
    replay: "safe",
    execute: async (args) => {
      const r = await checkCandidate({ pack, state, lookup, args, scrub, scrubLine, packText });
      if (r.refused) return text(r.refused, true);
      const c = r.candidate;
      return text(`Recorded candidate #${c.n}: ${c.title} (${c.severity}). It is UNPROVEN and queued for human review. It is not a finding. Keep auditing for proven findings.`);
    },
  });
}

// ---------------------------------------------------------------- oracle packs
// web and ai-mcp. Every run_request_script attempt is kept, matched or not.
// A matched attempt is a finding; an unmatched one may become a candidate.

export function recordScript(state, label, script, transcript, matched) {
  state.attempts ??= new Map();
  state.attempts.set(String(label), { script: String(script), transcript: transcript ?? [], matched: Boolean(matched) });
}

const bodyText = (b) => (typeof b === "string" ? b : JSON.stringify(b ?? ""));

export function scriptLookup(state) {
  return (label) => {
    const a = state.attempts?.get(label);
    if (!a) return null;
    if (a.matched || state.passed.has(label)) return { proved: true };
    const transcript = a.transcript.map(({ method, path, status, reqHeaders, reqBody, resHeaders, resBody }) => ({ method, path, status, reqHeaders, reqBody, resHeaders, resBody }));
    return {
      evidence: { kind: "transcript", script: a.script, transcript },
      text: a.transcript.map((e, i) => `${i + 1}. ${e.method} ${e.path} -> ${e.status} ${bodyText(e.resBody)}`).join("\n"),
      rootCause: `script:${sha256(a.script).slice(0, 16)}`,
    };
  };
}

export const SCRIPT_POC = "the label of a run_request_script attempt that matched no harm pattern";

// ---------------------------------------------------------------- harm packs
// contracts, keys, chain-watch. A candidate comes from a test that passed in
// this session. The lookup replays its exact source. If the harm check fires,
// it is a finding. If the test does not pass on replay, there is no evidence.

export function recordForge(state, contract, output) {
  state.attempts ??= new Map();
  state.attempts.set(String(contract), { output: String(output ?? "") });
}

// `judge` is the pack's harm check (null: the replay's own harm verdict).
export function forgeLookup({ ws, state, judge = null, stateTrace = false }) {
  return async (contract) => {
    const source = state.passed.get(contract);
    if (!source) return null;
    const delta = await proofDelta(ws, { source, contract, stateTrace });
    if (!delta) throw new Error("the replay produced no result");
    const proof = gate({ kind: "forge", ...delta }, judge);
    if (proof.pass) return { proved: true };
    if (!delta.pass) throw new Error(`the test did not pass on replay: ${delta.reason ?? delta.status ?? "no reason"}`);
    const output = state.attempts?.get(contract)?.output ?? "";
    const { test, status, gasUsed, logs, transfers, harm } = proof;
    return {
      evidence: { kind: "forge-trace", contract, test, status: delta.status, harmCheck: harm, gasUsed, logs, transfers, source, output },
      text: `${output}\n${JSON.stringify({ logs, transfers }, null, 1)}`,
      rootCause: `source:${sha256(source).slice(0, 16)}`,
    };
  };
}

export const FORGE_POC = "the name of a test contract that passed run_poc but whose replay the harm check did not count";

// ---------------------------------------------------------------- evidence packs
// supply-chain, infra-cloud, domains. A candidate comes from a lead whose
// replay against the pinned snapshot ran in this session and did not pass.

export function recordEvidence(state, id, { lead, evidence = lead?.evidence, proof }) {
  state.attempts ??= new Map();
  state.attempts.set(String(id), { lead, evidence, proof });
}

export function evidenceLookup(state) {
  return (id) => {
    const a = state.attempts?.get(id);
    if (!a) return null;
    if (a.proof?.status === "pass" || state.passed.has(id)) return { proved: true };
    const { lead, evidence, proof } = a;
    return {
      evidence: { kind: "snapshot-slice", leadId: lead.id, check: lead.check, file: lead.file, lines: lead.lines, where: lead.where, commit: lead.commit, evidence, replay: proof },
      // Compact JSON, as the lead board and the replay printed it, so a cited
      // line copied from either tool output matches.
      text: `${JSON.stringify(lead)}\n${JSON.stringify(proof)}`,
      rootCause: lead.rootCause ?? `lead:${lead.id}`,
      // For a pack that keeps no model prose (supply-chain), as submit_finding.
      packText: { title: lead.check, explanation: lead.description },
    };
  };
}

export const EVIDENCE_POC = "the id of a lead whose evidence replay ran in this session and did not pass";
