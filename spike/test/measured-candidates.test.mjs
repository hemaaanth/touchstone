// N3: after the final proof, a finding whose replay only repeated a
// measurement becomes a measured candidate (lib/candidate.mjs splitMeasured).
// It is made by the engine, never by the agent, so it does not count toward
// the agent's cap of 3. It is never proven.
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EVENTS_FILE = join(mkdtempSync(join(tmpdir(), "measured-")), "events.jsonl");
const { CANDIDATE_CAP, checkCandidate, makeCandidate, splitMeasured } = await import("../lib/candidate.mjs");
const { isProven } = await import("../lib/proof-view.mjs");
const { MEASURED_WORDS } = await import("../lib/proof-class.mjs");

const HASH = "ab".repeat(32);
const evidence = (check, poc, where = { host: "example.test" }) => ({
  n: 1, pack: "domains", title: check, severity: "low", poc, explanation: `The snapshot shows ${check}.`,
  evidence: { check, where, snapshotHash: HASH }, proof: { kind: "evidence", status: "pass", check, snapshotHash: HASH, detail: "Allowlisted detector confirmed the pinned evidence." },
  pocProved: true,
});
const owners = [
  evidence("tls-cipherlist_3des_idea", "l1"), evidence("tls-breach", "l2"), evidence("weak-csp", "l3"),
  evidence("email-dmarc-no-reporting", "l4"), evidence("tls-dns_caarecord", "l5"), evidence("dnssec-no-ds", "l6"),
];
const provenHttp = { n: 7, pack: "web", title: "IDOR", severity: "high", poc: "s1", proof: { kind: "http", status: "pass", oracle: { name: "bola-wallet-idor" } }, pocProved: true };
const failedHttp = { n: 8, pack: "web", title: "Maybe IDOR", severity: "high", poc: "s2", proof: { kind: "http", status: "fail", oracle: { name: "bola-wallet-idor" } }, pocProved: false };
const xss = { n: 9, pack: "web", title: "XSS", severity: "medium", poc: "s3", proof: { kind: "http", status: "pass", oracle: { name: "reflected-xss" } }, pocProved: true };
const oldForge = { n: 10, pack: "contracts", title: "Reentrancy", severity: "critical", poc: "T", pocProved: true, proof: { tool: "Foundry", pass: true, transfers: [], logs: [] } };

const itemsOf = (cands) => cands.flatMap((c) => c.evidence.items.map((i) => i.poc));

test("the owner's six become measured candidates; nothing is proven", () => {
  const { findings, candidates } = splitMeasured(owners);
  assert.deepEqual(findings, []);
  assert.equal(candidates.length, 6);
  for (const c of candidates) {
    assert.equal(c.origin, "measured");
    assert.equal(c.assertedBy, "engine");
    assert.equal(c.proven, false);
    assert.equal(c.candidate, true);
    assert.equal(c.provedBy, null);
    assert.equal(isProven(c), false);
    assert.equal(c.measured.reason, "repeated");
    assert.equal(c.measured.repeated, true);
    assert.equal(c.measured.words, MEASURED_WORDS.repeated);
    assert.equal(c.measured.snapshotHash, HASH);
    assert.ok(!/^[^\s]+$/.test(c.title), `a readable title, not an id: ${c.title}`);
  }
  assert.deepEqual(candidates.map((c) => c.n), [1, 2, 3, 4, 5, 6]);
});

test("splitMeasured never drops a finding: each input is in exactly one place", () => {
  const input = [...owners, provenHttp, failedHttp, xss, oldForge, evidence("weak-csp", "l7", { host: "b.test" }), evidence("weak-csp", "l8", { host: "c.test" })];
  const { findings, candidates } = splitMeasured(input, { from: 3 });
  const places = [...findings.map((f) => f.poc), ...itemsOf(candidates)];
  assert.deepEqual([...places].sort(), input.map((f) => f.poc).sort());
  assert.equal(new Set(places).size, places.length);
  // A proven finding and a failed replay stay findings.
  assert.deepEqual(findings.map((f) => f.poc), ["s1", "s2"]);
  // Three weak-csp findings fold into one candidate that lists all three.
  const csp = candidates.find((c) => c.measured.check === "weak-csp");
  assert.deepEqual(csp.evidence.items.map((i) => i.poc), ["l3", "l7", "l8"]);
  assert.equal(csp.measured.count, 3);
  assert.equal(csp.poc, "l3", "a fold carries its first finding's own poc");
  // B5 and B7.
  assert.equal(candidates.find((c) => c.measured.check === "reflected-xss").measured.reason, "no-effect");
  const forge = candidates.find((c) => c.pack === "contracts");
  assert.equal(forge.measured.reason, "harm-not-judged");
  assert.equal(forge.measured.words, "Harm not judged: recorded before the harm check.");
  assert.equal(forge.title, "Reentrancy");
  // Numbering goes on after the run's own candidates.
  assert.equal(Math.min(...candidates.map((c) => c.n)), 4);
  // Bad input is skipped, never thrown.
  assert.deepEqual(splitMeasured([null, 3]), { findings: [], candidates: [] });
  assert.deepEqual(splitMeasured(undefined), { findings: [], candidates: [] });
});

test("a measured candidate does not count toward the agent's cap of 3", async () => {
  const measured = splitMeasured(owners).candidates.slice(0, CANDIDATE_CAP);
  const text = "1. GET /x -> 200 the harmful line here";
  const state = { poc: 0, passed: new Map(), found: [], candidates: [...measured] };
  const r = await checkCandidate({ pack: "web", state, lookup: () => ({ evidence: { kind: "transcript" }, text, rootCause: "r1" }), args: { title: "t", severity: "high", poc: "a1", evidence_lines: ["the harmful line here"], explanation: "x\nFix: y" } });
  assert.ok(r.candidate, r.refused);
  assert.equal(r.candidate.origin, "agent");
  assert.equal(r.candidate.assertedBy, "agent");
});

test("no input makes a measured candidate proven, or an agent one an engine one", () => {
  const forged = makeCandidate({ title: "x", origin: "measured", measured: { reason: "made-up", repeated: "yes" }, proven: true, provedBy: "oracle", assertedBy: "oracle" });
  assert.equal(forged.proven, false);
  assert.equal(forged.provedBy, null);
  assert.equal(forged.assertedBy, "engine");
  assert.equal(forged.measured.reason, "unknown");
  assert.equal(forged.measured.repeated, false);
  const agent = makeCandidate({ title: "x", origin: "something", assertedBy: "engine" });
  assert.deepEqual([agent.origin, agent.assertedBy, agent.measured], ["agent", "agent", null]);
});

// Repair 1 (E4, UI M1): fold only evidence rows, by pack, exact check and
// exact rule. A forge or http row is its own root cause and never folds.
const scanner = (poc, rule, line, severity = "medium") => ({
  ...evidence("tool:zizmor", poc, { file: ".github/workflows/deploy.yml", line, rule, fingerprint: `fp-${poc}` }),
  pack: "supply-chain", title: rule, severity, file: ".github/workflows/deploy.yml", lines: [line],
});
test("different scanner rules never fold; the same rule at two places does, under its rule's title", () => {
  const { candidates } = splitMeasured([
    scanner("z1", "zizmor/excessive-permissions", 3),
    scanner("z2", "zizmor/unpinned-uses", 8),
    scanner("z3", "zizmor/artipacked", 8),
    scanner("z4", "zizmor/unpinned-uses", 12, "high"),
  ]);
  assert.deepEqual(candidates.map((c) => [c.poc, c.measured.rule, c.measured.count]), [
    ["z1", "zizmor/excessive-permissions", 1],
    ["z2", "zizmor/unpinned-uses", 2],
    ["z3", "zizmor/artipacked", 1],
  ]);
  assert.equal(candidates[1].title, "A CI workflow uses an action that is not pinned to a commit (zizmor)");
  assert.equal(candidates[1].severity, "high", "a fold takes its worst severity");
  assert.ok(candidates.every((c) => !/^[^\s]+$/.test(c.title)), "no rule id as a title");
});

test("old forge rows (harm not judged) and http rows never fold, even in one run", () => {
  const forge = (poc, title) => ({ ...oldForge, poc, title });
  const { candidates } = splitMeasured([forge("RescueTest", "Anyone can rescue"), forge("ReentrancyTest", "Reentrancy"), xss, { ...xss, poc: "s4", title: "XSS 2" }]);
  assert.deepEqual(candidates.map((c) => [c.poc, c.title, c.measured.count]), [
    ["RescueTest", "Anyone can rescue", 1], ["ReentrancyTest", "Reentrancy", 1], ["s3", "XSS", 1], ["s4", "XSS 2", 1],
  ]);
});

test("the same check in two modules of a joined run does not fold", () => {
  const { candidates } = splitMeasured([evidence("weak-csp", "d1"), { ...evidence("weak-csp", "w1"), pack: "web" }]);
  assert.deepEqual(candidates.map((c) => [c.pack, c.measured.count]), [["domains", 1], ["web", 1]]);
});

// Repair 1: a measured candidate's evidence and write-up pass the candidate
// scrub, as an agent candidate's do. Fake values built from pieces.
test("a measured candidate's evidence and write-up are scrubbed", () => {
  const gh = ["gh", "p_", "a1B2c3D4e5F6g7H8i9J0", "k1L2m3N4o5P6q7R8"].join("");
  const f = evidence("tool:gitleaks", "s1", { file: ".env", line: 2, rule: "github-pat", token: gh });
  f.explanation = `The file holds ${gh}.`;
  f.proof.detail = `matched ${gh}`;
  const [c] = splitMeasured([f]).candidates;
  assert.ok(!JSON.stringify(c).includes(gh), "no token survives");
  assert.match(c.explanation, /\[REDACTED\]/);
});
