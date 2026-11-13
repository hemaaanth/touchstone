// The shared candidate record and submit_candidate checks (lib/candidate.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANDIDATE_CAP, CANDIDATE_HINT, candidateTool, checkCandidate, makeCandidate, scrubExtras, scrubText, scrubValue } from "../lib/candidate.mjs";
import { REVIEW_INPUTS } from "./helpers/scrub-review-inputs.mjs";
import { isProven } from "../lib/proof-view.mjs";

process.env.EVENTS_FILE = join(mkdtempSync(join(tmpdir(), "cand-")), "events.jsonl");
const events = () => readFileSync(process.env.EVENTS_FILE, "utf8").trim().split("\n").map((l) => JSON.parse(l));

const ATTEMPT_TEXT = "1. GET /admin/users -> 200 [{\"email\":\"a@x.io\"}]\n2. DELETE /admin/users/7 -> 204";
const attempts = {
  a1: { evidence: { kind: "transcript", lines: ATTEMPT_TEXT }, text: ATTEMPT_TEXT, rootCause: "script:a1" },
  a2: { evidence: { kind: "transcript", lines: ATTEMPT_TEXT + " two" }, text: ATTEMPT_TEXT, rootCause: "script:a2" },
  a3: { evidence: { kind: "transcript", lines: ATTEMPT_TEXT + " three" }, text: ATTEMPT_TEXT, rootCause: "script:a3" },
  a4: { evidence: { kind: "transcript", lines: ATTEMPT_TEXT + " four" }, text: ATTEMPT_TEXT, rootCause: "script:a4" },
  same: { evidence: { kind: "transcript", lines: ATTEMPT_TEXT + " two" }, text: ATTEMPT_TEXT, rootCause: "script:other" },
  sameRoot: { evidence: { kind: "transcript", lines: "x" }, text: ATTEMPT_TEXT, rootCause: "script:a1" },
  proved: { proved: true },
};
const lookup = (poc) => attempts[poc] ?? null;
const fresh = () => ({ poc: 0, passed: new Map(), found: [] });
const args = (poc, extra = {}) => ({
  title: "Admin API deletes users without auth",
  severity: "high",
  poc,
  evidence_lines: ["DELETE /admin/users/7 -> 204"],
  explanation: "An unauthenticated DELETE removed a user.\nFix: require an admin session on /admin.",
  ...extra,
});

test("makeCandidate forces the fixed fields, whatever the input says", () => {
  const c = makeCandidate({ n: 1, pack: "web", title: "t", severity: "high", poc: "p", proven: true, candidate: false, assertedBy: "human", provedBy: "oracle", kind: "finding" });
  assert.equal(c.proven, false);
  assert.equal(c.candidate, true);
  assert.equal(c.assertedBy, "agent");
  assert.equal(c.provedBy, null);
  assert.equal(c.kind, "candidate");
  assert.equal(isProven({ ...c, proof: { status: "pass" }, pocProved: true }), false);
});

test("a recorded attempt with captured evidence becomes an unproven candidate", async () => {
  const state = fresh();
  const r = await checkCandidate({ pack: "web", state, lookup, args: args("a1") });
  assert.ok(r.candidate);
  assert.equal(r.candidate.n, 1);
  assert.equal(r.candidate.proven, false);
  assert.equal(r.candidate.candidate, true);
  assert.equal(r.candidate.assertedBy, "agent");
  assert.equal(r.candidate.provedBy, null);
  assert.deepEqual(r.candidate.evidence, attempts.a1.evidence);
  assert.equal(state.candidates.length, 1);
  assert.equal(state.found.length, 0, "a candidate is never a finding");
  const ev = events().filter((e) => e.ev === "candidate-submitted").at(-1);
  assert.equal(ev.candidate.poc, "a1");
  assert.equal(ev.candidate.proven, false);
});

test("a bare claim with no recorded attempt is refused", async () => {
  const state = fresh();
  const r = await checkCandidate({ pack: "web", state, lookup, args: args("never-ran") });
  assert.equal(r.reason, "no-attempt");
  assert.match(r.refused, /never a bare claim/);
  assert.equal((await checkCandidate({ pack: "web", state, lookup, args: args("") })).reason, "no-attempt");
  assert.equal(state.candidates.length, 0);
});

test("an attempt that met the proof model is refused and routed to submit_finding", async () => {
  const state = fresh();
  const r = await checkCandidate({ pack: "web", state, lookup, args: args("proved") });
  assert.equal(r.reason, "proved");
  assert.match(r.refused, /Call submit_finding with "proved"/);
  assert.equal(state.candidates.length, 0);
});

test("a lookup that throws is refused, not recorded", async () => {
  const state = fresh();
  const r = await checkCandidate({ pack: "web", state, lookup: () => { throw new Error("replay broke"); }, args: args("a1") });
  assert.equal(r.reason, "no-evidence");
  assert.equal(state.candidates.length, 0);
});

test("duplicate guards: same poc as a finding or candidate, same root cause, same evidence", async () => {
  const state = fresh();
  state.found.push({ n: 1, poc: "a3", title: "found already", rootCause: "script:a3" });
  assert.equal((await checkCandidate({ pack: "web", state, lookup, args: args("a3") })).reason, "duplicate");
  assert.ok((await checkCandidate({ pack: "web", state, lookup, args: args("a1") })).candidate);
  assert.equal((await checkCandidate({ pack: "web", state, lookup, args: args("a1") })).reason, "duplicate");
  assert.equal((await checkCandidate({ pack: "web", state, lookup, args: args("sameRoot") })).reason, "duplicate-root-cause");
  state.found.push({ n: 2, poc: "z", title: "root", rootCause: "script:a4" });
  assert.equal((await checkCandidate({ pack: "web", state, lookup, args: args("a4") })).reason, "duplicate-root-cause");
  assert.ok((await checkCandidate({ pack: "web", state, lookup, args: args("a2") })).candidate);
  assert.equal((await checkCandidate({ pack: "web", state, lookup, args: args("same") })).reason, "duplicate-evidence");
  assert.equal(state.candidates.length, 2);
});

test("cited lines must appear in the attempt's evidence", async () => {
  const state = fresh();
  const bad = await checkCandidate({ pack: "web", state, lookup, args: args("a1", { evidence_lines: ["DELETE /admin/users/8 -> 204"] }) });
  assert.equal(bad.reason, "bad-cite");
  const short = await checkCandidate({ pack: "web", state, lookup, args: args("a1", { evidence_lines: ["204"] }) });
  assert.equal(short.reason, "bad-cite");
  const none = await checkCandidate({ pack: "web", state, lookup, args: args("a1", { evidence_lines: [] }) });
  assert.equal(none.reason, "bad-input");
  const noFix = await checkCandidate({ pack: "web", state, lookup, args: args("a1", { explanation: "bad" }) });
  assert.equal(noFix.reason, "bad-input");
  const sev = await checkCandidate({ pack: "web", state, lookup, args: args("a1", { severity: "huge" }) });
  assert.equal(sev.reason, "bad-input");
  // Review Minor 6: a cite must sit inside one line of the output; joining
  // the end of one line to the start of the next is not a quote.
  const span = await checkCandidate({ pack: "web", state, lookup, args: args("a1", { evidence_lines: ['[{"email":"a@x.io"}] 2. DELETE /admin'] }) });
  assert.equal(span.reason, "bad-cite");
  // Whitespace differences do not matter.
  const loose = await checkCandidate({ pack: "web", state, lookup, args: args("a1", { evidence_lines: ["  DELETE  /admin/users/7\n-> 204 "] }) });
  assert.ok(loose.candidate);
});

test(`the cap is ${CANDIDATE_CAP} per run; the next is refused with a clear message`, async () => {
  const state = fresh();
  for (const poc of ["a1", "a2", "a3"]) assert.ok((await checkCandidate({ pack: "web", state, lookup, args: args(poc) })).candidate);
  const r = await checkCandidate({ pack: "web", state, lookup, args: args("a4") });
  assert.equal(r.reason, "cap");
  assert.match(r.refused, /already has 3 candidates/);
  assert.equal(state.candidates.length, 3);
});

test("prior candidates from earlier turns count toward the cap and the guards", async () => {
  const state = { ...fresh(), candidates: [{ n: 1, poc: "a1", title: "old", rootCause: "script:a1" }, { n: 2, poc: "a2", title: "old2" }] };
  assert.equal((await checkCandidate({ pack: "web", state, lookup, args: args("sameRoot") })).reason, "duplicate-root-cause");
  const r = await checkCandidate({ pack: "web", state, lookup, args: args("a3") });
  assert.equal(r.candidate.n, 3);
  assert.equal((await checkCandidate({ pack: "web", state, lookup, args: args("a4") })).reason, "cap");
});

test("secrets in the evidence and write-up are scrubbed", async () => {
  const key = "ab".repeat(32);
  const text = `1. POST /login -> 200 {"token":"tok-123456"} key=${key}`;
  const state = fresh();
  const r = await checkCandidate({
    pack: "web", state,
    lookup: () => ({ evidence: { body: { token: "tok-123456", note: `key=${key}` } }, text }),
    args: args("x", { evidence_lines: [`key=${key}`], explanation: `Leaks ${key}.\nFix: stop.` }),
  });
  const json = JSON.stringify(r.candidate);
  assert.ok(!json.includes(key));
  assert.ok(!json.includes("tok-123456"));
  assert.match(json, /\[REDACTED\]/);
  assert.equal(scrubValue({ password: "pw" + "2".repeat(6) }).password.startsWith("[REDACTED"), true);
});

test("large evidence is cut and says so", async () => {
  const state = fresh();
  const big = "x".repeat(9000);
  const r = await checkCandidate({ pack: "web", state, lookup: () => ({ evidence: { body: big, rows: Array.from({ length: 100 }, (_, i) => i) }, text: "the harmful line here" }), args: args("big", { evidence_lines: ["the harmful line here"] }) });
  assert.ok(r.candidate.evidence.body.length < 4100);
  assert.match(r.candidate.evidence.body, /cut 5000 chars/);
  assert.equal(r.candidate.evidence.rows.length, 61);
});

test("the tool records through the same checks and says the record is unproven", async () => {
  const state = fresh();
  const tool = candidateTool({ pack: "web", state, lookup, poc: "label" });
  assert.equal(tool.name, "submit_candidate");
  const ok = await tool.execute(args("a1"));
  assert.ok(!ok.isError);
  assert.match(ok.output[0].text, /UNPROVEN and queued for human review/);
  const no = await tool.execute(args("never"));
  assert.equal(no.isError, true);
  assert.match(CANDIDATE_HINT, /submit_candidate/);
});

// Review Major 1: the common secret shapes inside free text. Each value is
// built at run time from plain pieces, so no file holds a secret-shaped literal.
const cat = (...parts) => parts.join("");
const run = (unit, n) => unit.repeat(n);
const SEED_WORDS = ["abandon", "ability", "able", "about", "above", "absent", "absorb", "abstract", "absurd", "abuse", "access", "accident"];
const SEED = SEED_WORDS.join(" ");
const V = {
  bearer: cat("abc", run("Q7", 10)),
  env: cat("pw", run("-k", 9)),
  aws: cat("wJ", run("aB3/", 9), "xy"),
  akia: cat("AK", "IA", run("Q", 16)),
  github: cat("gh", "p_", run("a1B2c", 8)),
  url: cat("s3", run("q", 8)),
  query: cat(run("ab12", 4)),
  colon: cat("pw", run("-c", 8)),
  apiKey: cat("sk", "_", "live", "_", run("m", 16)),
  json: cat("j", run("9", 5)),
  escaped: cat("e", run("7", 6)),
  k8sPass: cat("pw", run("-y", 7)),
  k8sKey: cat("sk", "_", "live", "_", run("n", 14)),
};
const K8S = cat("stringData:\n  config.yaml: |\n    password: ", V.k8sPass, "\n    apiKey: ", V.k8sKey);
const SHAPED = {
  bearer: [cat("Authorization: Bearer ", V.bearer), V.bearer, "Bearer "],
  env: [cat("DATABASE_PASSWORD=", V.env), V.env, "DATABASE_PASSWORD="],
  awsSecret: [cat("AWS_SECRET_ACCESS_KEY=", V.aws), V.aws, "AWS_SECRET_ACCESS_KEY="],
  akia: [cat("key id ", V.akia, " in the log"), V.akia, "key id "],
  github: [cat("token ", V.github, " leaked"), V.github, "token "],
  urlCreds: [cat("postgres://admin:", V.url, "@db.internal:5432/app"), V.url, "db.internal:5432/app"],
  query: [cat("GET /v1/data?api_key=", V.query, "&page=2"), V.query, "&page=2"],
  seed: [`wallet seed: ${SEED}`, SEED, "wallet seed: "],
  // Delta review Major A, part 1: the colon forms of NAME=value.
  colonText: [cat("password: ", V.colon), V.colon, "password: "],
  colonApiKey: [cat("api_key: ", V.apiKey), V.apiKey, "api_key: "],
  jsonInString: [cat('body {"user":"bob","password": "', V.json, '"} done'), V.json, '"user":"bob"'],
  escapedJson: [cat('body {\\"password\\":\\"', V.escaped, '\\"} done'), V.escaped, "body "],
  k8sStringData: [K8S, V.k8sPass, "stringData:"],
  k8sApiKey: [K8S, V.k8sKey, "stringData:"],
};

// Delta review Major A, part 2: a seed phrase that is not all lowercase on
// spaces. The secret is every word in its written form; the fourth item is
// the cite list when the default (each line of the input) does not fit.
const cap = (w) => w[0].toUpperCase() + w.slice(1);
const seedShape = (words, sep, label = "phrase: ") => [label + words.join(sep), words, label.trim()];
Object.assign(SHAPED, {
  seedTitle: seedShape(SEED_WORDS.map(cap), " "),
  seedUpper: seedShape(SEED_WORDS.map((w) => w.toUpperCase()), " "),
  seedMixed: seedShape(SEED_WORDS.map((w, i) => (i % 2 ? w.toUpperCase() : w)), " "),
  seedCapFirst: seedShape([cap(SEED_WORDS[0]), ...SEED_WORDS.slice(1)], " ", ""),
  seedComma: seedShape(SEED_WORDS, ", "),
  seedPerLine: [...seedShape(SEED_WORDS, "\n", "the words are:\n"), ["the words are:"]],
  seedNumbered: ["the words are:\n" + SEED_WORDS.map((w, i) => `${i + 1}. ${w}`).join("\n"), SEED_WORDS, "the words are:", ["the words are:"]],
  // Two words a line, all six lines cited: the cites together hold the seed.
  seedAcrossCites: [SEED_WORDS.map((w, i) => w + (i % 2 ? "\n" : " ")).join("").trim(), SEED_WORDS, "It printed"],
});

for (const [shape, [line, secret, kept, cited]] of Object.entries(SHAPED)) {
  test(`a secret shape is scrubbed from the write-up, cites and evidence: ${shape}`, async () => {
    const state = fresh();
    const r = await checkCandidate({
      pack: "web", state,
      lookup: () => ({ evidence: { body: `response: ${line}`, list: [line] }, text: `1. GET / -> 200 ${line}` }),
      args: args(shape, { title: `Leak: ${line}`, evidence_lines: cited ?? line.split("\n"), explanation: `It printed ${line}.\nFix: stop.` }),
    });
    assert.ok(r.candidate, `${shape}: recorded`);
    const json = JSON.stringify(r.candidate);
    for (const part of [secret].flat()) assert.ok(!json.includes(part), `${shape}: the secret is gone`);
    assert.match(json, /\[REDACTED\]/, `${shape}: a marker is left`);
    assert.ok(r.candidate.explanation.includes(kept), `${shape}: the text around the secret stays`);
    assert.equal(scrubText(r.candidate.explanation), r.candidate.explanation, `${shape}: a second scrub changes nothing`);
    const secrets = shape.startsWith("k8s") ? 2 : 1;
    assert.equal(r.candidate.explanation.match(/REDACTED/g).length, secrets, `${shape}: one marker per secret`);
    const ev = events().filter((e) => e.ev === "candidate-submitted").at(-1);
    for (const part of [secret].flat()) assert.ok(!JSON.stringify(ev).includes(part), `${shape}: the event has no secret`);
  });
}

// Delta review Major A (parts 1, 2, 3) and Minors 2 and 3: each input the
// review listed, as one line. The scrub is main's redactor plus the
// candidate's own rules, so this is the proof that the two together cover them.
for (const [id, kind, input, parts] of REVIEW_INPUTS) {
  test(`review input is scrubbed: ${id}`, () => {
    const out = kind === "text" ? scrubText(input) : JSON.stringify(scrubValue(input));
    for (const part of parts) assert.ok(!out.includes(part), `${id}: ${JSON.stringify(out).slice(0, 200)}`);
    assert.match(out, /\[REDACTED\]/);
  });
}

// What the redactor keeps on purpose stays kept here too: a 0x address and a
// count under a token name, a fuzz seed, a label whose value is the next label.
test("a token address, a token count and a nested label are not taken for secrets", () => {
  const addr = `0x${"ab".repeat(20)}`;
  assert.equal(scrubText(`tokenAddress=${addr} tokenId: 1000`), `tokenAddress=${addr} tokenId: 1000`);
  assert.deepEqual(scrubValue({ token: addr, transfers: [{ token: addr, amount: "5" }] }), { token: addr, transfers: [{ token: addr, amount: "5" }] });
  for (const value of ["pw-not-kept-1", "shortpw"]) {
    const out = scrubText(`secrets:\n  password: ${value}`);
    assert.equal(out, "secrets:\n  password: [REDACTED]", "the inner label stays and its value goes");
  }
  assert.equal(scrubText("Basic authentication is off"), "Basic authentication is off");
});

// The two shapes the redactor does not reach that a candidate keeps: a key
// block cut before its END line (a tool output tail), and a bare Basic value.
test("an unended private key block and a bare Basic value are scrubbed", () => {
  const body = ["MHcCAQEEIBkg4LVWM9nuwNSk3yBp", "kx2kMHcCAQEEIBkg4LVWM9nuwNSk"].join("");
  const pem = scrubText(["-----BEGIN ", "EC PRIVATE KEY-----\n", body, "\n", body.slice(0, 20)].join(""));
  assert.ok(!pem.includes(body.slice(0, 20)), pem);
  const basic = ["dXNlcj", "pwYXNzd29yZDEyMw=="].join("");
  assert.equal(scrubText(`sent Basic ${basic} to it`), "sent Basic [REDACTED] to it");
});

test("plain prose and ordinary values are not redacted", () => {
  const prose = "the admin export route returns every customer row without a session check, so any visitor can read them";
  assert.equal(scrubText(prose), prose);
  assert.equal(scrubText("GET /items?page=2&sort=asc -> 200"), "GET /items?page=2&sort=asc -> 200");
  assert.equal(scrubText("https://example.com/a/b"), "https://example.com/a/b");
});

test("no scrub regex is slow on a 1 MB line", () => {
  const MB = 1 << 20;
  const fill = (unit) => unit.repeat(Math.ceil(MB / unit.length)).slice(0, MB);
  const lines = [
    fill("a"), fill("A"), fill("KEY"), fill("KEY_"), fill("a KEY"), fill("x=KEY"),
    fill("Bearer "), fill("bearer"), fill("://a:"), fill("://aaaa:bbbb"), fill("ghp_"), fill("AKIA"),
    fill("-eyJ"), fill("eyJabcdefghij."), fill("-----BEGIN RSA PRIVATE KEY-----"), fill("sk-"),
    fill("abandon "), fill("abandon "), fill("abc ").slice(0, MB - 1) + "Z", fill("0123456789abcdef"), fill("0x"),
    fill("a=b&"), fill("PASSWORD="), fill("password: "), fill('"password":"'), fill('\\"token\\": '), fill("apiKey:"),
    fill("Abandon "), fill("ABANDON, "), fill("abandon\n"), fill("1. abandon\n"), fill("1) "), fill("Abcdefghi "),
    fill("Basic "), fill("Basic aB"), fill("ghp_a\n"), fill("sk-\n"), fill("password:\n"), fill("PASSWORD=\n  "), fill("snapshotHash: "),
  ];
  for (const line of lines) {
    const t0 = performance.now();
    scrubText(line);
    // The redactor masks a text this long whole, so the candidate's own rules
    // are timed alone too.
    scrubExtras(line);
    const ms = performance.now() - t0;
    assert.ok(ms < 2000, `scrub took ${Math.round(ms)} ms on a 1 MB line of ${JSON.stringify(line.slice(0, 16))}`);
  }
});

// Review Major 2: a resumed run gets its candidates back, so the cap, the
// numbering and the duplicate guards hold across a restart.
test("candidateState saves each new candidate and restores the guards on resume", async () => {
  const { candidateState } = await import("../lib/candidate.mjs");
  let disk = null;
  const save = (list) => { disk = JSON.stringify(list); };
  const before = { ...fresh(), candidates: candidateState([], save) };
  for (const poc of ["a1", "a2"]) assert.ok((await checkCandidate({ pack: "web", state: before, lookup, args: args(poc) })).candidate);
  assert.equal(JSON.parse(disk).length, 2, "each new candidate is saved at once");

  const after = { ...fresh(), candidates: candidateState(JSON.parse(disk), save) };
  assert.deepEqual(after.candidates.map((c) => [c.n, c.poc, c.proven]), [[1, "a1", false], [2, "a2", false]]);
  assert.equal((await checkCandidate({ pack: "web", state: after, lookup, args: args("a1") })).reason, "duplicate");
  assert.equal((await checkCandidate({ pack: "web", state: after, lookup, args: args("sameRoot") })).reason, "duplicate-root-cause");
  assert.equal((await checkCandidate({ pack: "web", state: after, lookup, args: args("same") })).reason, "duplicate-evidence");
  assert.equal((await checkCandidate({ pack: "web", state: after, lookup, args: args("a3") })).candidate.n, 3);
  assert.equal((await checkCandidate({ pack: "web", state: after, lookup, args: args("a4") })).reason, "cap");
  assert.equal(JSON.parse(disk).length, 3);

  const forged = candidateState([{ n: 1, poc: "f", proven: true, provedBy: "oracle", kind: "finding" }]);
  assert.equal(forged[0].proven, false, "a saved file cannot make a candidate proven");
  assert.equal(forged[0].provedBy, null);
});

// Review Minor 2: a finding proven for a candidate's poc or root cause takes
// its place. The run never shows both.
test("a finding for a candidate's poc or root cause removes the candidate, saves and says so", async () => {
  const { candidateState, watchFindings } = await import("../lib/candidate.mjs");
  let disk = null;
  const state = watchFindings({ ...fresh(), candidates: candidateState([], (list) => { disk = JSON.stringify(list); }) });
  for (const poc of ["a1", "a2", "a3"]) assert.ok((await checkCandidate({ pack: "web", state, lookup, args: args(poc) })).candidate);
  state.found.push({ n: 1, poc: "a1", title: "proven a1" });
  assert.deepEqual(state.candidates.map((c) => c.poc), ["a2", "a3"], "same poc");
  state.found.push({ n: 2, poc: "other", rootCause: "script:a2", title: "proven root" });
  assert.deepEqual(state.candidates.map((c) => c.poc), ["a3"], "same root cause");
  state.found.push({ n: 3, poc: "unrelated", rootCause: "script:zzz" });
  assert.deepEqual(state.candidates.map((c) => c.poc), ["a3"], "an unrelated finding leaves the candidate");
  assert.deepEqual(JSON.parse(disk).map((c) => c.poc), ["a3"], "the removal is saved");
  const gone = events().filter((e) => e.ev === "candidate-superseded").slice(-2);
  assert.deepEqual(gone.map((e) => [e.poc, e.by]), [["a1", "a1"], ["a2", "other"]]);
  assert.equal(state.found.length, 3, "every finding is still recorded");
  assert.equal((await checkCandidate({ pack: "web", state, lookup, args: args("a4") })).candidate.n, 4, "numbers stay unique after a removal");
});

// Review Minor 1: pins, topics and calldata words are not keys.
test("64-hex values under pin names and inside calldata stay; a key under a secret name goes", () => {
  const H = "3f".repeat(32);
  const v = scrubValue({
    snapshotHash: H, evidenceHash: H, sha256: H, topics: [`0x${H}`],
    calldata: `0xa9059cbb${H}${H}`, input: `0x095ea7b3${H}`,
    privateKey: `0x${H}`, signer: { secret: H }, note: `the key is 0x${H}`,
  });
  assert.equal(v.snapshotHash, H);
  assert.equal(v.evidenceHash, H);
  assert.equal(v.sha256, H);
  assert.deepEqual(v.topics, [`0x${H}`]);
  assert.equal(v.calldata, `0xa9059cbb${H}${H}`);
  assert.equal(v.input, `0x095ea7b3${H}`);
  assert.match(v.privateKey, /^\[REDACTED/);
  assert.match(v.signer.secret, /^\[REDACTED/);
  assert.ok(!v.note.includes(H), "a bare 64-hex in prose may be a key");
  assert.equal(scrubText(`"snapshotHash":"${H}"`), `"snapshotHash":"${H}"`);
  assert.equal(scrubText(`call 0xa9059cbb${H}${H}`), `call 0xa9059cbb${H}${H}`);
  assert.ok(!scrubText(`PRIVATE_KEY=0x${H}`).includes(H));
  assert.ok(!scrubText(`privateKey: "0x${H}"`).includes(H));
});

// Review round 1, m3: of an event's topics only the first (the event
// signature) is a pin. An indexed argument the PoC emitted is judged by its
// value: a key-shaped word goes, a padded address stays.
test("only the event signature topic is a pin; an indexed key goes, a padded address stays", () => {
  const SIG = "dd".repeat(32);
  const KEY = "4c".repeat(32);
  const ADDR = `0x${"0".repeat(24)}${"ab".repeat(20)}`;
  const v = scrubValue({ logs: [{ topics: [`0x${SIG}`, ADDR, `0x${KEY}`], data: "0x" }] });
  assert.deepEqual(v.logs[0].topics, [`0x${SIG}`, ADDR, "[REDACTED]"]);
  assert.ok(!JSON.stringify(scrubValue({ topics: [`0x${KEY}`, `0x${KEY}`] })).includes(`${KEY}"]`), "a second key-shaped topic goes");
  assert.ok(!scrubText(`topics: 0x${KEY}`).includes(KEY), "in text a topic label keeps nothing");
});

// Delta review Major A, part 3: only a pin the engine computes keeps its
// 64-hex value by name. Any other field is checked by its value, so a key a
// trace log carries under one of these names is scrubbed.
const WORD = "3f".repeat(32);
for (const [form, value] of [
  ["a log data field", { data: `0x${WORD}` }],
  ["a call input field", { input: `0x${WORD}` }],
  ["a txHash field", { txHash: `0x${WORD}` }],
  ["a blockHash field", { blockHash: WORD }],
]) {
  test(`a 64-hex value is scrubbed under ${form}`, () => {
    const out = JSON.stringify(scrubValue(value));
    assert.ok(!out.includes(WORD), out);
    assert.match(out, /\[REDACTED\]/);
  });
}

test("a 64-hex value after a txHash label in text is scrubbed", () => {
  const out = scrubText(`"txHash":"0x${WORD}"`);
  assert.ok(!out.includes(WORD), out);
  assert.equal(scrubText(`"snapshotHash":"${WORD}"`), `"snapshotHash":"${WORD}"`, "the snapshot pin stays");
});

// Review round 1, m1: a worker the server restarts reopens its audit file
// (lib/audit-state.mjs). The candidates in it must come back, with the cap,
// the numbering and the guards, and still unproven.
test("auditState saves the candidates and a restarted worker gets them back", async (t) => {
  const { auditState } = await import("../lib/audit-state.mjs");
  const dir = mkdtempSync(join(tmpdir(), "cand-audit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "run.audit.json");
  const first = auditState(file);
  for (const poc of ["a1", "a2", "a3"]) assert.ok((await checkCandidate({ pack: "web", state: first, lookup, args: args(poc) })).candidate);
  const second = auditState(file);
  assert.deepEqual(second.candidates.map((c) => [c.n, c.poc, c.proven, c.candidate]), [[1, "a1", false, true], [2, "a2", false, true], [3, "a3", false, true]]);
  assert.equal((await checkCandidate({ pack: "web", state: second, lookup, args: args("a4") })).reason, "cap");
  assert.equal((await checkCandidate({ pack: "web", state: second, lookup, args: args("sameRoot") })).reason, "cap");
  // A finding proven at submit takes a1's place; the removal is saved too.
  second.found.push({ n: 1, title: "proven a1", poc: "a1" });
  const third = auditState(file);
  assert.deepEqual(third.candidates.map((c) => c.poc), ["a2", "a3"]);
  assert.equal((await checkCandidate({ pack: "web", state: third, lookup, args: args("a4") })).candidate.n, 4, "numbers are not reused");
});
