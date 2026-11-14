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
import { currentAgent, event } from "./event.mjs";
import { sha256 } from "./proof-evidence.mjs";
import { redactSecrets } from "../../app/server/redact.mjs";
import { proofDelta } from "./proof.mjs";
import { gate } from "./record.mjs";
import { isProven } from "./proof-view.mjs";
import { MEASURED_WORDS, proofClass, proofClassOf } from "./proof-class.mjs";
import { readableTitle } from "./check-titles.mjs";
import { LangEn } from "ethers";

export const CANDIDATE_CAP = 3;
export const WHY_UNPROVEN = "No check covers this class yet.";
export const SEVERITIES = ["critical", "high", "medium", "low", "informational"];

// The line each pack adds to its "no proof" message.
export const CANDIDATE_HINT = `If you are confident this is a real, serious vulnerability that this pack's checks do not cover, record it with submit_candidate. It is marked unproven and queued for human review, not dropped. Use it rarely: at most ${CANDIDATE_CAP} per run.`;

// The line each wired pack's system prompt ends with. A run's instructions
// name every tool it has (multi.mjs renames it per module in a joined run).
export const CANDIDATE_SYSTEM = `Rare case: if an attempt you ran showed serious harm that this pack's proof checks do not cover, record it with submit_candidate, citing that attempt. It stays unproven and goes to a human for review. At most ${CANDIDATE_CAP} per run.`;
export const withCandidateLine = (system) => (ws) => `${system(ws)}\n\n${CANDIDATE_SYSTEM}`;

// ---------------------------------------------------------------- scrub
// One redactor: app/server/redact.mjs (its TEXT_RULES and its 64 KB whole-text
// mask), the same one the report, the replay bundle and the findings ledger
// use. Every candidate text and value goes through it first. A text the
// redactor cannot check (too long) comes back whole as its marker.
//
// The rules below add only what a candidate needs and the redactor does not
// do. A candidate keeps free agent prose and raw forge traces, so it is
// stricter than a report:
//   HEX_KEY    a bare 64-hex value is a signing key. The redactor keeps hex on
//              purpose (a proof needs its hashes). Here only an engine pin
//              (PIN_NAME) keeps it; a key can sit under data, input or *Hash.
//   WORD_RUN   a seed phrase: 12 or more BIP-39 words in a row.
//   LABEL      any value after a secret label. The redactor masks only a value
//              that looks like a credential, so "password: hunter2" stays
//              there. Also a value on the next line: "DB_PASSWORD=\nvalue".
//   SPLIT      a vendor token broken by one line break. The two halves are
//              joined and given to the redactor again, so its shapes decide.
//   PEM_OPEN   a private key block cut before its END line.
//   BASIC      a bare "Basic <base64>" outside an Authorization header.
//   secret parent: every string under a secret-named object or list.
const MARK = "[REDACTED]";
const MARKER = /^\[REDACTED[^\]\r\n]{0,80}\]$/;
// A value under a secret name that is evidence, not a secret: a 0x address.
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SECRET_NAME = /secret|private|token|passw|api[-_]?key|credential|authorization|cookie|session|mnemonic|seed/i;
// The name in NAME=value or NAME: value that marks the value as a secret.
const SECRET_VAR = /secret|token|passw|passphrase|mnemonic|private|credential|api_?key|access_?key|(?:^|_)key(?:$|_)|^pwd$/i;
// Under these names a number or a 0x address is kept: "tokenId: 1000",
// "tokenAddress=0x…". Under a password or secret name nothing is kept.
const WORD_SECRET = /passw|passphrase|secret|^pwd$/i;
// The pins the engine computes. Their 64-hex values are not keys. Any other
// name is judged by its value. Of an event's topics only the first, the
// event signature, is a pin. An indexed argument can hold anything the PoC
// emitted; it is kept only when it is a padded address (12 zero bytes, then
// 20 bytes), which a key is not.
const PIN_NAME = /^(?:snapshotHash|evidenceHash|sha256|digest)$/i;
const TOPICS = /^topics$/i;
const HEX32 = /^(?:0x)?[0-9a-fA-F]{64}$/;
const PADDED_ADDRESS = /^(?:0x)?0{24}[0-9a-fA-F]{40}$/;
const BIP39 = new Set(Array.from({ length: 2048 }, (_, i) => LangEn.wordlist().getWord(i)));

// Each regex is linear: every start sits at the start of a token run, and no
// quantifier can backtrack over text another quantifier also takes. The test
// runs each one on a 1 MB line (scrubExtras: the redactor masks a text that
// long whole, so the rules are timed alone). A `keep` group stays readable.
//
// Exactly 64 hex, so a calldata word inside a longer run stays. A value
// labelled as a pin in the text ("snapshotHash": ...) stays.
const HEX_KEY = /(?<![0-9A-Za-z_])(?<!(?:snapshotHash|evidenceHash|sha256|[Dd]igest)["']?\s{0,3}[:=]\s{0,3}["']?)(?:0x)?[0-9a-fA-F]{64}(?![0-9A-Za-z_])/g;
const PEM_OPEN = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[A-Za-z0-9+/=\s\\]*(?:-----END [A-Z ]{0,40}PRIVATE KEY-----)?/g;
const BASIC = /(?<keep>\b[Bb]asic[ \t]+)(?=[A-Za-z0-9+/=]{0,200}(?:[0-9+/=]|[a-z][A-Z]|[A-Z][a-z]{0,3}[A-Z]))[A-Za-z0-9+/=]{8,}/g;
const SPLIT = /\b(?:gh[pousr]_|github_pat_|glpat-|xox[baprs]-|sk-|[sr]k_(?:live|test)_|npm_|AKIA|ASIA|eyJ)[A-Za-z0-9_.-]{0,120}(?:\r?\n|\\n)[A-Za-z0-9_.-]{1,120}/g;
// NAME=value, NAME: value, "NAME": "value", YAML and escaped JSON. The label
// alone is matched; replaceNamed takes the value after it. The value may sit
// on the next line.
const LABEL = /(?<![A-Za-z0-9_])(?=(?<name>[A-Za-z_][A-Za-z0-9_]*))\k<name>(?:\\?["'])?[ \t]{0,3}[:=][ \t]{0,3}(?<nl>(?:\r?\n|\\n)[ \t]{0,12})?(?:\\?["'])?(?!\[REDACTED)(?=[^\s"'&;,<>\\{}]{3})/g;
// A run of 12 or more words in any case. Words are split by spaces, line
// breaks or commas, and may carry a list number ("2." or "2)"). Only its
// BIP-39 stretches are redacted.
const WORD_SEP = String.raw`[\s,]+(?:\d{1,2}[.)][ \t]*)?`;
const WORD_RUN = new RegExp(String.raw`(?<![A-Za-z])[A-Za-z]{3,8}(?:${WORD_SEP}[A-Za-z]{3,8}){11,}(?![A-Za-z])`, "g");
const WORD_SPLIT = new RegExp(`(${WORD_SEP})`);

const globalOf = (re) => (re.global ? re : new RegExp(re.source, `${re.flags}g`));

function keepGroup(m, ...rest) {
  const groups = typeof rest.at(-1) === "object" ? rest.at(-1) : null;
  const keep = groups?.keep ?? "";
  return keep + MARK;
}

// A seed phrase: 12 or more words in a row, each from the BIP-39 list.
function redactSeed(run) {
  const parts = run.split(WORD_SPLIT);
  let out = "";
  for (let i = 0; i < parts.length; ) {
    let j = i;
    while (j < parts.length && BIP39.has(parts[j].toLowerCase())) j += 2;
    if ((j - i) / 2 >= 12) {
      out += MARK + (parts[j - 1] ?? "");
      i = j;
    } else {
      out += parts[i] + (parts[i + 1] ?? "");
      i += 2;
    }
  }
  return out;
}

const keptUnder = (name, value) => ADDRESS.test(value) || (!WORD_SECRET.test(name) && /^\d+(?:\.\d+)?$/.test(value));

// When the name passes SECRET_VAR, the value after the label is redacted.
// When it fails, the search goes on right after that name, so "Leak: TOKEN=v"
// still finds TOKEN. No value is scanned for a name that fails, so the pass
// stays linear. A value on the next line that is itself a label ("secrets:\n
// password: x") is not taken: that inner label is checked on its own.
const VALUE = /[^\s"'&;,<>\\{}]+/y;
const IS_LABEL = /(?:\\?["'])?[A-Za-z_][A-Za-z0-9_-]{0,63}(?:\\?["'])?[ \t]*[:=]/y;
function replaceNamed(text) {
  LABEL.lastIndex = 0;
  let out = "";
  let from = 0;
  for (let m; (m = LABEL.exec(text)); ) {
    const name = m.groups.name;
    const skip = () => { LABEL.lastIndex = m.index + name.length; };
    if (!SECRET_VAR.test(name)) { skip(); continue; }
    VALUE.lastIndex = IS_LABEL.lastIndex = LABEL.lastIndex;
    if (m.groups.nl && IS_LABEL.test(text)) { skip(); continue; }
    const value = VALUE.exec(text)[0];
    if (keptUnder(name, value)) { skip(); continue; }
    out += text.slice(from, LABEL.lastIndex) + MARK;
    from = LABEL.lastIndex = VALUE.lastIndex;
  }
  return out + text.slice(from);
}

// The two halves of a split token, joined: masked whole when the redactor
// masks the joined form.
function joinSplit(m) {
  const joined = m.replace(/\r?\n|\\n/, "");
  return redactSecrets(joined) === joined ? m : MARK;
}

// The candidate's own rules over one text, with no redactor and no length
// check. scrubText runs the redactor first; the timing test runs this alone.
export function scrubExtras(text, extra = [], { hex = true } = {}) {
  let out = String(text ?? "");
  if (MARKER.test(out)) return out;
  out = out.replace(SPLIT, joinSplit);
  out = out.replace(PEM_OPEN, MARK);
  out = out.replace(BASIC, keepGroup);
  out = replaceNamed(out);
  if (hex) out = out.replace(HEX_KEY, MARK);
  for (const re of extra) out = out.replace(globalOf(re), MARK);
  return out.replace(WORD_RUN, redactSeed);
}

export function scrubText(text, extra = [], { hex = true } = {}) {
  return scrubExtras(redactSecrets(String(text ?? "")), extra, { hex });
}

// The candidate's rules over a value the redactor already walked. Under a
// secret name every string goes, at any depth, except a 0x address.
function walkExtras(value, name, extra, under) {
  if (value == null) return value;
  const secret = under || SECRET_NAME.test(name);
  if (typeof value === "string") {
    if (!value || MARKER.test(value)) return value;
    if (secret && !ADDRESS.test(value)) return MARK;
    return scrubExtras(value, extra, { hex: !PIN_NAME.test(name) });
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value) && TOPICS.test(name) && !secret) {
    return value.map((v, i) => (typeof v === "string" && HEX32.test(v) && (i === 0 || PADDED_ADDRESS.test(v)) ? v : walkExtras(v, "", extra, false)));
  }
  if (Array.isArray(value)) return value.map((v) => walkExtras(v, name, extra, secret));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walkExtras(v, k, extra, secret)]));
}

export function scrubValue(value, name = "", extra = []) {
  return walkExtras(redactSecrets(value), name, extra, false);
}

// ---------------------------------------------------------------- record

const MAX_STRING = 4000;
const MAX_ITEMS = 60;
const MAX_JSON = 96_000;

// Evidence this function already cut: the note after the cut is kept as it is,
// so a second pass (the server's) changes nothing.
const CUT_CHARS = /^… \[cut \d{1,12} chars\]$/;
const CUT_ITEMS = /^… \[cut \d{1,12} items\]$/;
const wasCut = (v) => v?.cut === true && typeof v.text === "string" && v.text.length <= MAX_JSON && Object.keys(v).length === 2;

// A copy of the evidence small enough to store and send. Long strings and
// long lists are cut, and say so. Running it twice gives the same result.
export function capEvidence(value, depth = 0) {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "string") {
    if (value.length <= MAX_STRING || CUT_CHARS.test(value.slice(MAX_STRING))) return value;
    return `${value.slice(0, MAX_STRING)}… [cut ${value.length - MAX_STRING} chars]`;
  }
  if (typeof value !== "object" || depth > 8) return String(value).slice(0, 200);
  if (wasCut(value)) return { cut: true, text: value.text };
  if (Array.isArray(value)) {
    const noted = value.length === MAX_ITEMS + 1 && CUT_ITEMS.test(String(value[MAX_ITEMS]));
    const out = value.slice(0, MAX_ITEMS).map((v) => capEvidence(v, depth + 1));
    if (noted) out.push(value[MAX_ITEMS]);
    else if (value.length > MAX_ITEMS) out.push(`… [cut ${value.length - MAX_ITEMS} items]`);
    return out;
  }
  const out = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, capEvidence(v, depth + 1)]));
  const json = JSON.stringify(out);
  return json.length > MAX_JSON ? { cut: true, text: json.slice(0, MAX_JSON) } : out;
}

// The one way to build a candidate. The fixed fields come last.
// `origin` is "agent" (submit_candidate) or "measured" (the engine: a replay
// that only repeated a measurement, splitMeasured). Who asserted it follows
// from the origin; no input sets it.
// `derived`: a measured candidate an older record's finding reads as, made at
// read time. It is shown, never written into a record.
export function makeCandidate({ n, pack, title, severity, poc, evidence, explanation, cites = [], rootCause = null, evidenceHash = null, origin = "agent", measured = null, derived = false }) {
  const engine = origin === "measured";
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
    origin: engine ? "measured" : "agent",
    measured: engine ? measuredBlock(measured) : null,
    ...(engine && derived === true ? { derived: true } : {}),
    kind: "candidate",
    assertedBy: engine ? "engine" : "agent",
    proven: false,
    candidate: true,
    provedBy: null,
  };
}

// The "measurement repeated" fact a measured candidate carries: why it is not
// proven, the words for it, and the pins a reviewer can check.
function measuredBlock(m) {
  const reason = Object.hasOwn(MEASURED_WORDS, m?.reason) ? m.reason : "unknown";
  const str = (v) => (v == null ? null : String(v).slice(0, 200));
  return {
    reason,
    words: MEASURED_WORDS[reason],
    repeated: m?.repeated === true,
    check: str(m?.check),
    rule: str(m?.rule),
    proofKind: str(m?.proofKind),
    snapshotHash: str(m?.snapshotHash),
    oracle: str(m?.oracle),
    count: Math.max(1, Number(m?.count) || 1),
  };
}

const RANK = { critical: 0, high: 1, medium: 2, low: 3, informational: 4 };
// The replay passed. A forge proof whose harm gate failed did not, as gate()
// reads it (lib/record.mjs): such a finding stays an unproven finding.
const replayPassed = (f) => {
  const p = f?.proof;
  if (!p || typeof p !== "object") return false; // no replay record: nothing was measured again
  if (p.harm && p.harm.ok !== true) return false;
  return p?.status === "pass" || p?.pass === true || (f?.pocProved === true && p?.status !== "fail" && p?.pass !== false);
};

// A finding whose replay passed but only repeated a measurement: it is read
// and recorded as a measured candidate, never as a finding. An old record's
// row reads the same way at load (nothing rewrites the record).
export const isMeasured = (f) => Boolean(f) && typeof f === "object" && !isCandidate(f) && !isProven(f) && replayPassed(f) && proofClass(f) !== "harm";

// The rule a scanner's evidence names: a scanner rule (zizmor/unpinned-uses),
// an advisory id, or the identity of one secret or package. Rows of one check
// with different rules are different issues and never fold.
// Each identity field a pack puts in `where`: a scanner rule, a Scorecard
// check (`check`), one secret (`fingerprint`, infra-cloud `secretHash`), a
// package, an advisory. All that are present make the rule.
const RULE_FIELDS = ["rule", "check", "fingerprint", "secretHash", "package", "advisory"];
export const measuredRule = (f) => {
  const w = f?.evidence?.where;
  if (!w || typeof w !== "object") return "";
  return RULE_FIELDS.filter((k) => w[k] != null && w[k] !== "").map((k) => (typeof w[k] === "string" ? w[k] : JSON.stringify(w[k]))).join(" ");
};

// Checks whose identity is not in `where` (known-vulnerable-js names its
// library only in its prose): never folded, so two libraries stay two items.
const NEVER_FOLD = new Set(["known-vulnerable-js"]);

// The fold key. Only evidence rows fold, and only with the same pack, the
// exact check and the exact rule: the same issue at several places (one
// weak-csp on three hosts). A forge or http row is its own root cause (each
// is its own exploit or script), so it never folds: its key is its poc.
function foldKey(f, c) {
  if (f.proof?.kind !== "evidence" || NEVER_FOLD.has(c.check)) return `poc\u0000${f.poc ?? ""}\u0000${f.n ?? ""}`;
  return `ev\u0000${f.pack ?? ""}\u0000${c.check}\u0000${measuredRule(f)}`;
}

// After the final proof: a finding whose replay passed but only repeated a
// measurement (lib/proof-class.mjs) is not a finding. It becomes a measured
// candidate. Evidence findings of one pack, one check and one rule fold into
// one candidate that lists each of them (evidence.items); nothing else folds.
// A proven finding, and a finding whose replay failed, stay findings. Every
// input finding ends in exactly one place: `findings`, or one candidate's
// evidence.items. A candidate's poc is its first item's own poc, which is
// unique per finding, so a later fold (a follow-up) never takes its place.
// `from` numbers the candidates after the ones the run already has.
export function splitMeasured(list, { from = 0 } = {}) {
  const findings = [];
  const groups = new Map();
  for (const f of list ?? []) {
    if (!f || typeof f !== "object") continue;
    if (!isMeasured(f)) {
      findings.push(f);
      continue;
    }
    const c = proofClassOf(f);
    const key = foldKey(f, c);
    if (!groups.has(key)) groups.set(key, { c, items: [] });
    groups.get(key).items.push(f);
  }
  const candidates = [...groups.values()].map(({ c, items }, k) => {
    const first = items[0];
    const rule = first.proof?.kind === "evidence" ? measuredRule(first) : "";
    const worst = items.reduce((w, f) => ((RANK[f.severity] ?? 9) < (RANK[w.severity] ?? 9) ? f : w), first);
    const poc = String(first.poc ?? `measured:${c.check}:${from + k + 1}`);
    // One item: its own write-up. A fold: the check's own words, never the
    // first row's (its prose names its own place only).
    const ownWords = (readableTitle("", c.check, rule) || c.check).replace(/[.\s]+$/, "");
    const text = items.length > 1 ? `${ownWords}. The same check and rule fired at ${items.length} places; each is listed in the evidence.` : String(first.explanation ?? "");
    return makeCandidate({
      n: from + k + 1,
      pack: first.pack ?? "",
      title: scrubText(readableTitle(first.title, first.proof?.kind === "evidence" ? c.check : "", rule)),
      severity: worst.severity,
      poc,
      rootCause: first.rootCause ?? null,
      explanation: scrubText(text),
      evidence: scrubValue({
        kind: "measured",
        check: c.check,
        items: items.map((f) => ({
          poc: f.poc ?? null, title: f.title ?? null, severity: f.severity ?? null,
          file: f.file ?? null, lines: f.lines ?? null, where: f.evidence?.where ?? null,
          proof: { kind: f.proof?.kind ?? "forge", status: f.proof?.status ?? null, check: f.proof?.check ?? null, snapshotHash: f.proof?.snapshotHash ?? null, commit: f.proof?.commit ?? null, oracle: f.proof?.oracle?.name ?? f.oracleName ?? null, detail: f.proof?.detail ?? null, harm: f.proof?.harm ?? null },
        })),
      }),
      origin: "measured",
      measured: { reason: c.reason, check: c.check, rule: rule || null, proofKind: first.proof?.kind ?? "forge", snapshotHash: first.proof?.snapshotHash ?? null, oracle: first.proof?.oracle?.name ?? first.oracleName ?? null, repeated: true, count: items.length },
    });
  });
  return { findings, candidates };
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
  Object.defineProperty(list, "save", { value: () => save(list) });
  return list;
}

// A finding for a candidate's poc or root cause takes its place once it is
// proven: the candidate is removed (and saved), and `candidate-superseded`
// tells the server and the UI. Wraps state.found.push, so every pack's
// submit_finding is covered. Web, ai-mcp and the evidence packs push a
// finding only after their own proof passed (oracle match, snapshot replay),
// so it supersedes at once. Keys and chain-watch push on a passing test, and
// contracts on a passing test plus one harm replay; for all three, pocProved
// comes from the final proof. Such a finding is marked with provedLater, and
// the server supersedes the candidate only after that proof says
// pocProved: true (supersededBy).
const LATER = new WeakSet();
export const provedLater = (f) => {
  LATER.add(f);
  return f;
};

export function watchFindings(state) {
  const push = state.found.push.bind(state.found);
  state.found.push = (...items) => {
    const n = push(...items);
    for (const f of items) if (!LATER.has(f)) supersede(state, f);
    return n;
  };
  return state;
}

// Same poc or same root cause, in the same module. A joined run lets two
// modules use one label (multi.mjs), so a finding of one module never ends
// another module's candidate. A record with no module matches any.
const samePack = (f, c) => c.pack == null || c.pack === "" || f?.pack == null || c.pack === f.pack;
const takesPlace = (f, c) => samePack(f, c) && (c.poc === f?.poc || (c.rootCause != null && c.rootCause === f?.rootCause));

// The candidates that proven findings take the place of, after the final
// proof: [{ poc, by }]. A finding that is not proven takes no place.
export function supersededBy(candidates, findings) {
  const proven = (findings ?? []).filter(isProven);
  return (candidates ?? []).flatMap((c) => {
    const f = proven.find((x) => takesPlace(x, c));
    return f ? [{ poc: c.poc, by: f.poc ?? null }] : [];
  });
}

function supersede(state, f) {
  const list = state.candidates ?? [];
  const gone = list.filter((c) => takesPlace(f, c));
  for (const c of gone) {
    list.splice(list.indexOf(c), 1);
    event("candidate-superseded", { poc: c.poc, by: f.poc ?? null });
  }
  if (gone.length) list.save?.();
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
  // The cap is the agent's: a measured candidate (made by the engine) never counts.
  if (state.candidates.filter((c) => c.origin !== "measured").length >= CANDIDATE_CAP) {
    return refuse("cap", `Cannot record this candidate: this run already has ${CANDIDATE_CAP} candidates, the most a run may hold. A candidate costs a human's attention. Keep auditing for proven findings, or write the coverage summary.`);
  }
  if (!poc) return refuse("no-attempt", "Cannot record this candidate: name the recorded attempt it comes from.");
  const samePoc = (p) => {
    const finding = state.found.find((f) => f.poc === p);
    if (finding) return refuse("duplicate", `"${p}" is already recorded as finding #${finding.n} ("${finding.title}"). A candidate cannot repeat a finding.`);
    const twin = state.candidates.find((c) => c.poc === p);
    if (twin) return refuse("duplicate", `"${p}" is already recorded as candidate #${twin.n} ("${twin.title}").`);
    return null;
  };
  const dup = samePoc(poc);
  if (dup) return dup;
  let attempt;
  try { attempt = await lookup(poc); } catch (err) { attempt = { error: String(err?.message ?? err).slice(0, 200) }; }
  if (attempt?.error) return refuse("no-evidence", `Cannot record this candidate: the attempt "${poc}" could not be read back (${attempt.error}).`);
  if (!attempt) return refuse("no-attempt", `Cannot record this candidate: "${poc}" is not a recorded attempt in this session. A candidate needs real captured evidence, never a bare claim. Run the attempt first, then cite it.`);
  if (attempt.proved) return refuse("proved", `Not a candidate: the attempt "${poc}" met this pack's proof model. It is a real finding. Call submit_finding with "${poc}" instead.`);
  // The poc a finding for this attempt would carry (evidence packs prefix the
  // lead id). The candidate is stored under it, so the guards see the pair.
  const recordPoc = String(attempt.poc ?? poc);
  const dupRecord = recordPoc === poc ? null : samePoc(recordPoc);
  if (dupRecord) return dupRecord;
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
  // Each cite must sit inside one line of the output, whitespace aside.
  const lines = String(attempt.text ?? "").split("\n").map(squash);
  const missing = cites.find((c) => squash(c).length < 8 || !lines.some((l) => l.includes(squash(c))));
  if (missing) return refuse("bad-cite", `Cannot record this candidate: the cited line "${missing.slice(0, 120)}" is not in the evidence of "${poc}" (or is shorter than 8 characters). Quote the exact lines that show the harm.`);
  // Max + 1, so a number is never reused after a candidate is superseded.
  const n = Math.max(0, ...state.candidates.map((c) => c.n)) + 1;
  // The pack's own scrub first (it knows its secret shapes), then the shared one.
  const line = (t) => scrubText(scrubLine(String(t ?? "")));
  const candidate = makeCandidate({
    n, pack, poc: recordPoc, severity, rootCause, evidenceHash,
    title: line(own ? own.title : args.title),
    explanation: line(explanation),
    // Scrubbed as one text, so a seed split over several cites is caught too.
    cites: line(cites.join("\n")).split("\n"),
    evidence: scrubValue(scrub(attempt.evidence)),
  });
  state.candidates.push(candidate);
  event("candidate-submitted", { candidate });
  return { candidate };
}

// The submit_candidate tool. `poc` names the pack's attempt id (label, test
// contract or lead id) and how to describe it to the agent. `name` and
// `description` are for a second candidate tool beside a pack's own (the
// free-roam session tool); the packs pass neither.
const DESCRIPTION = `Record a CANDIDATE: a serious problem your own attempt showed, that this pack's proof checks do not cover. It is stored as unproven and agent-asserted, and queued for human review. It never counts as a finding. Use it only after an attempt that captured evidence but did not prove. If the attempt proved, use submit_finding. At most ${CANDIDATE_CAP} per run.`;
export function candidateTool({ pack, state, lookup, poc, scrub, scrubLine, packText = false, name = "submit_candidate", description = DESCRIPTION }) {
  const prose = packText ? {} : {
    title: str({ description: "short title" }),
    explanation: str({ description: "plain-language write-up: what happened, why it is harmful, why the checks miss it, ending with a line starting \"Fix:\"" }),
  };
  return defineTool({
    name,
    description,
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

// `findingPoc` maps a lead id to the poc the pack's submit_finding records.
export function evidenceLookup(state, findingPoc = (id) => id) {
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
      poc: findingPoc(id),
      // For a pack that keeps no model prose (supply-chain), as submit_finding.
      packText: { title: readableTitle(lead.check, evidence?.check ?? lead.check, evidence?.where?.rule), explanation: lead.description },
    };
  };
}

export const EVIDENCE_POC = "the id of a lead whose evidence replay ran in this session and did not pass";

// ---------------------------------------------------------------- session
// A free-roam child (Wave 4). It has no pack tool and no proof model. Its
// attempt is its session: each shell command it ran on its own machine, and
// each request the machine's proxy log reported. The entries are kept per
// agent, in memory only (state.session: agent -> entries; audit-state.mjs
// does not save them, so a follow-up worker starts with an empty session).
//
// Nothing a free-roam child ran is a proof. sessionLookup has no `proved`
// path, and makeCandidate sets `proven: false`.

// The description text of the `poc` argument. `shell` prints the id.
export const SESSION_POC = "the session id from the line that starts with \"session\" in your last shell result, like session:a-12:3";

// The description of submit_session_candidate. A free-roam child has no
// submit_finding, so the text does not name it.
export const SESSION_DESCRIPTION = `Record a CANDIDATE from your shell session: a serious problem your own commands showed. It is stored as unproven and agent-asserted, and queued for human review. It never counts as a finding: nothing in a free-roam session is a proof. Cite exact lines from your shell results. A second candidate needs a new shell command first. At most ${CANDIDATE_CAP} per run.`;

const SESSION_OUTPUT = 16_000;
const SESSION_HOSTS = 60;
const EGRESS_NOTE = "proxy log; a request that does not use the proxy is not listed";

const shellsOf = (list) => list.filter((e) => e.kind === "shell");
const sessionId = (agent, list) => `session:${agent}:${shellsOf(list).length}`;

// The last 16 000 characters. A cut can split a secret, and half a secret has
// no shape a rule knows. So the first line after the cut, a partial one, is
// dropped too. With no line break in the cut (one long line, like a minified
// JSON body), the leading partial token is dropped.
function lastOutput(output) {
  const all = String(output ?? "");
  if (all.length <= SESSION_OUTPUT) return all;
  const cut = all.slice(-SESSION_OUTPUT);
  const lineEnd = cut.indexOf("\n");
  return lineEnd < 0 ? cut.replace(/^[^\s"'&;,<>\\{}]+/, "") : cut.slice(lineEnd + 1);
}

// The host of one logged request. A tunnel's url is "<host>:<port>". A host is
// a host shape of at most 253 characters, or it is "": the hosts go into the
// stored evidence, and a long list would push it over capEvidence's size.
const hostShape = (h) => (/^[A-Za-z0-9.\-_\[\]:]{1,253}$/.test(h) ? h : "");
function hostOf(method, url) {
  if (method === "CONNECT") return hostShape(url.replace(/:\d+$/, ""));
  try { return hostShape(new URL(url).hostname); } catch { return ""; }
}

// One logged value on one line: a control character becomes a space, so a
// url cannot add a line to the session text. (The proxy log drops such lines
// too; this is the second guard.)
const oneLine = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ");

// Store one entry of a free-roam child's session, scrubbed. Returns the
// session id after this entry and, for a shell entry, the scrubbed output.
//   entry: { agent, kind: "shell",  t, sandbox, command, exit_code, output }
//        | { agent, kind: "egress", t, method, url, status }
//
// THE SCRUB IS A SAFETY RULE, AND IT IS NOT COMPLETE. The server does not
// scrub a candidate's evidence again (app/server/candidates.mjs), and `shell`
// shows the model only the text returned here. So nothing unscrubbed may
// leave this function, in the return value or in state.
//
// The four-step scrub masks known secret shapes. It is not complete. The
// engine's own secrets cannot be in a session: nothing from the host goes to
// the machine (I1). A secret the child finds on the open web can stay if it
// has no known shape. The record is shown only in the owner's console.
//
// Known to pass unmasked today (test/candidate-session.test.mjs lists each):
// a value in a header with no secret name, a token in a URL path, a reset
// link, `sshpass -p <value>`, a bare value on an output line, a base64 form.
//
// Before the steps: the output is cut to its last 16 000 characters. An
// egress url loses its userinfo ("user:password@", also in a tunnel's
// "<host>:<port>"), because a user-only or password-only form has no shape a
// rule knows. The steps:
//   1. Known secret values (state.sessionSecrets; empty until I5 fills it).
//      shortcut: exact copies only. capture.mjs's holdsSecret (parts and
//      encoded forms) is not used: capture.mjs loads the grant store. Upgrade
//      when I5 puts a first value in the list.
//   2. redactSecrets over the entry as an object, so it masks by name too.
//   3. Its 64 KB rule: a longer string is masked whole.
//   4. The candidate's own rules (scrubValue does 2 to 4).
export function recordSession(state, entry) {
  const agent = String(entry?.agent ?? "");
  if (!agent) throw new Error("a session entry needs an agent");
  const known = (state.sessionSecrets ?? []).filter(Boolean).map(String);
  const clean = (v) => known.reduce((s, secret) => s.split(secret).join(MARK), String(v ?? ""));
  const t = Number(entry.t) || 0;
  let e;
  if (entry.kind === "shell") {
    const code = Number(entry.exit_code);
    e = { kind: "shell", t, sandbox: clean(entry.sandbox), command: clean(entry.command), exit_code: Number.isFinite(code) ? code : null, output: clean(lastOutput(entry.output)) };
  } else if (entry.kind === "egress") {
    const method = oneLine(entry.method).toUpperCase();
    const url = oneLine(entry.url).replace(/^((?:[a-z][a-z0-9+.-]*:)?\/\/)?[^\/?#@]*@/i, "$1");
    e = { kind: "egress", t, method: clean(method), url: clean(url), host: clean(hostOf(method, url)), status: Number.isInteger(entry.status) ? entry.status : null };
  } else {
    throw new Error(`unknown session entry kind: ${String(entry.kind).slice(0, 40)}`);
  }
  e = scrubValue(e);
  state.session ??= new Map();
  if (!state.session.has(agent)) state.session.set(agent, []);
  const list = state.session.get(agent);
  list.push(e);
  return { poc: sessionId(agent, list), output: e.kind === "shell" ? e.output : "" };
}

// The lines a candidate may cite. They are built from the stored entries, so
// they are the same scrubbed text `shell` showed the model.
const sessionLines = (e) => (e.kind === "shell"
  ? `$ ${e.command}\nexit ${e.exit_code}\n${e.output}`
  : `> ${e.method} ${e.url} ${e.status ?? (e.method === "CONNECT" ? "tunnel" : "no status")}`);

// The lookup of submit_session_candidate. The caller is the fleet's agent tag
// (currentAgent), never an argument, so an agent reads only its own entries.
// Only the current id is taken: "session:<agent>:<its shell entries now>".
// It returns null or { evidence, text }. It never returns { proved: true }.
export function sessionLookup(state) {
  return (poc) => {
    const agent = currentAgent();
    const list = agent ? state.session?.get(String(agent)) : null;
    const shells = shellsOf(list ?? []);
    if (!shells.length || poc !== sessionId(agent, list)) return null;
    const requests = list.filter((e) => e.kind === "egress");
    const hosts = [...new Set(requests.map((e) => e.host).filter(Boolean))].slice(0, SESSION_HOSTS);
    return {
      evidence: {
        kind: "session",
        agent: String(agent),
        sandbox: shells.at(-1).sandbox,
        shell: { commands: shells.length, sha256: sha256(shells.map(sessionLines).join("\n")) },
        // "requests" are the requests seen by the log, not all requests.
        egress: { requests: requests.length, hosts, note: EGRESS_NOTE },
        har: null,
        screenshots: [],
      },
      text: list.map(sessionLines).join("\n"),
    };
  };
}
