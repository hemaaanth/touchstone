// The shared candidate record and submit_candidate checks (lib/candidate.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANDIDATE_CAP, CANDIDATE_HINT, candidateTool, checkCandidate, makeCandidate, scrubText, scrubValue } from "../lib/candidate.mjs";
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
  assert.match(json, /REDACTED sha256:/);
  assert.equal(scrubValue({ password: "hunter22" }).password.startsWith("[REDACTED"), true);
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

// Review Major 1: the common secret shapes inside free text.
const SEED = "abandon ability able about above absent absorb abstract absurd abuse access accident";
const SHAPED = {
  bearer: ["Authorization: Bearer abcDEF1234567890ghiJKL", "abcDEF1234567890ghiJKL", "Bearer "],
  env: ["DATABASE_PASSWORD=hunter2-correct-horse", "hunter2-correct-horse", "DATABASE_PASSWORD="],
  awsSecret: ["AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "AWS_SECRET_ACCESS_KEY="],
  akia: ["key id AKIAIOSFODNN7EXAMPLE in the log", "AKIAIOSFODNN7EXAMPLE", "key id "],
  github: [`token ghp_${"a1B2c3D4e5".repeat(4)} leaked`, `ghp_${"a1B2c3D4e5".repeat(4)}`, "token "],
  urlCreds: ["postgres://admin:s3cretpass@db.internal:5432/app", "s3cretpass", "db.internal:5432/app"],
  query: ["GET /v1/data?api_key=abcd1234efgh5678&page=2", "abcd1234efgh5678", "&page=2"],
  seed: [`wallet seed: ${SEED}`, SEED, "wallet seed: "],
};

test("each common secret shape is scrubbed from the write-up, cites and evidence", async () => {
  for (const [shape, [line, secret, kept]] of Object.entries(SHAPED)) {
    const state = fresh();
    const r = await checkCandidate({
      pack: "web", state,
      lookup: () => ({ evidence: { body: `response: ${line}`, list: [line] }, text: `1. GET / -> 200 ${line}` }),
      args: args(shape, { title: `Leak: ${line}`, evidence_lines: [line], explanation: `It printed ${line}.\nFix: stop.` }),
    });
    assert.ok(r.candidate, `${shape}: recorded`);
    const json = JSON.stringify(r.candidate);
    assert.ok(!json.includes(secret), `${shape}: the secret is gone`);
    assert.match(json, /REDACTED sha256:/, `${shape}: a fingerprint is left`);
    assert.ok(r.candidate.explanation.includes(kept), `${shape}: the text around the secret stays`);
    assert.equal(scrubText(r.candidate.explanation), r.candidate.explanation, `${shape}: a second scrub changes nothing`);
    assert.equal(r.candidate.explanation.match(/REDACTED/g).length, 1, `${shape}: one fingerprint per secret`);
    const ev = events().filter((e) => e.ev === "candidate-submitted").at(-1);
    assert.ok(!JSON.stringify(ev).includes(secret), `${shape}: the event has no secret`);
  }
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
    fill("a=b&"), fill("PASSWORD="),
  ];
  for (const line of lines) {
    const t0 = performance.now();
    scrubText(line);
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

// Review Minor 1: hashes, topics and calldata words are not keys.
test("64-hex values under hash names and inside calldata stay; a key under a secret name goes", () => {
  const H = "3f".repeat(32);
  const v = scrubValue({
    snapshotHash: H, txHash: `0x${H}`, sha256: H, blockHash: `0x${H}`, topics: [`0x${H}`],
    calldata: `0xa9059cbb${H}${H}`, input: `0x095ea7b3${H}`,
    privateKey: `0x${H}`, signer: { secret: H }, note: `the key is 0x${H}`,
  });
  assert.equal(v.snapshotHash, H);
  assert.equal(v.txHash, `0x${H}`);
  assert.equal(v.sha256, H);
  assert.equal(v.blockHash, `0x${H}`);
  assert.deepEqual(v.topics, [`0x${H}`]);
  assert.equal(v.calldata, `0xa9059cbb${H}${H}`);
  assert.equal(v.input, `0x095ea7b3${H}`);
  assert.match(v.privateKey, /^\[REDACTED/);
  assert.match(v.signer.secret, /^\[REDACTED/);
  assert.ok(!v.note.includes(H), "a bare 64-hex in prose may be a key");
  assert.equal(scrubText(`"snapshotHash":"${H}"`), `"snapshotHash":"${H}"`);
  assert.equal(scrubText(`txHash: 0x${H}`), `txHash: 0x${H}`);
  assert.equal(scrubText(`call 0xa9059cbb${H}${H}`), `call 0xa9059cbb${H}${H}`);
  assert.ok(!scrubText(`PRIVATE_KEY=0x${H}`).includes(H));
  assert.ok(!scrubText(`privateKey: "0x${H}"`).includes(H));
});
