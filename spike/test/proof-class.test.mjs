// N3: "Proven" only when the replay shows harm (lib/proof-class.mjs). A replay
// that repeats a measurement is a candidate. Unknown is never harm.
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HARM_CHECKS, HARM_ORACLES, MEASURED_WORDS, proofClass, proofClassOf } from "../lib/proof-class.mjs";
import { isProven } from "../lib/proof-view.mjs";

const { ORACLES: WEB } = await import("../packs/web/pack.mjs");
const { ORACLES: MCP } = await import("../packs/ai-mcp/pack.mjs");
const { detectorsFor } = await import("../packs/domains/checks.mjs");
const { cryptoDetectors: infraCrypto } = await import("../packs/infra-cloud/checks.mjs");
const { scannerDetectors: infraScanners, SELECTED } = await import("../packs/infra-cloud/scanners.mjs");
const { CRYPTO_CHECKS } = await import("../packs/supply-chain/crypto.mjs");
const { SCANNERS } = await import("../packs/supply-chain/scanners.mjs");
const { oracle: liveOracle } = await import("../packs/infra-cloud/live-cloud.mjs");

const http = (name, status = "pass") => ({ proof: { kind: "http", status, oracle: { name, passed: status === "pass" } } });
const evidence = (check) => ({ evidence: { check }, proof: { kind: "evidence", status: "pass", check } });
const forge = (harm) => ({ pocProved: true, proof: { kind: "forge", status: "pass", pass: true, ...(harm ? { harm } : {}) } });

test("http: only the oracles that show an effect are harm", () => {
  const harm = ["siwe-nonce-replay", "bola-wallet-idor", "debug-route-signer-key-leak", "prompt-injection-forbidden-tool", "prompt-injection-data-exfil", "fetch-url-scope-escape", "mcp-tool-scope-bypass", "tool-description-poisoning", "assumed-role-reads-other-bucket", "assumed-role-reads-foreign-bucket"];
  assert.deepEqual([...HARM_ORACLES].sort(), [...harm].sort());
  for (const o of [...WEB, ...MCP, liveOracle("role")]) {
    const want = harm.includes(o.name) ? "harm" : "measured";
    assert.equal(proofClass(http(o.name)), want, o.name);
    assert.equal(isProven(http(o.name)), want === "harm", o.name);
  }
  // B5 and B6: candidates for now.
  assert.equal(proofClass(http("reflected-xss")), "measured");
  assert.equal(proofClass(http("mcp-tool-definition-rug-pull")), "measured");
  // An oracle the finding names itself (oracleName) counts the same.
  assert.equal(proofClass({ oracleName: "bola-wallet-idor", proof: { kind: "http", status: "pass" } }), "harm");
});

test("evidence: every check of every pack repeats a measurement; none is proven", () => {
  assert.equal(HARM_CHECKS.size, 0);
  const domains = detectorsFor("domains");
  const checks = [
    ...Object.keys(domains), "tls-cipherlist_3des_idea", "tls-breach", "tls-dns_caarecord", "tls-anything-new",
    ...Object.keys(detectorsFor("surface")),
    ...CRYPTO_CHECKS, ...Object.keys(SCANNERS).map((e) => `tool:${e}`), "artifact-signature-missing", "tool:cosign", "tool:scorecard", "tool:chain-bench",
    ...Object.keys(infraCrypto()), ...Object.keys(infraScanners(SELECTED)),
  ];
  assert.ok(checks.length > 50, `${checks.length} checks`);
  for (const check of checks) {
    const c = proofClassOf(evidence(check));
    assert.deepEqual([check, c.class, c.reason], [check, "measured", "repeated"]);
    assert.equal(isProven(evidence(check)), false, check);
  }
});

test("forge: harm only for a funds or control verdict; no verdict is harm not judged", () => {
  assert.equal(isProven(forge({ ok: true, kind: "funds" })), true);
  assert.equal(isProven(forge({ ok: true, kind: "control" })), true);
  assert.equal(isProven(forge({ ok: false, reason: "no ETH moved" })), false);
  assert.equal(isProven(forge({ ok: true })), false, "a verdict of no known kind");
  assert.equal(isProven(forge({ ok: true, kind: "freeze" })), false, "a harm kind not in the map");
  const old = proofClassOf(forge(null));
  assert.deepEqual([old.class, old.reason], ["measured", "harm-not-judged"]);
  assert.equal(MEASURED_WORDS["harm-not-judged"], "Harm not judged: recorded before the harm check.");
  assert.equal(isProven(forge(null)), false);
  // A proof with no kind is an old forge proof.
  assert.equal(isProven({ pocProved: true, proof: { pass: true, harm: { ok: true, kind: "funds" } } }), true);
});

test("fail closed: an unknown proof kind, oracle or check is never proven", () => {
  for (const f of [
    { pocProved: true, proof: { kind: "weird", status: "pass", pass: true, harm: { ok: true, kind: "funds" } } },
    http("an-oracle-nobody-wrote"),
    http(""),
    { proof: { kind: "http", status: "pass" } },
    evidence("a-check-nobody-wrote"),
    { proof: { kind: "evidence", status: "pass" } },
  ]) {
    assert.equal(proofClass(f), "measured", JSON.stringify(f));
    assert.equal(isProven(f), false, JSON.stringify(f));
  }
  assert.equal(proofClassOf({ proof: { kind: "weird" } }).reason, "unknown");
});

test("a harm class does not make a failed replay proven", () => {
  assert.equal(isProven(http("bola-wallet-idor", "fail")), false);
  assert.equal(isProven({ ...forge({ ok: true, kind: "funds" }), pocProved: false }), false);
  assert.equal(isProven({ ...http("bola-wallet-idor"), candidate: true }), false);
});

// The shapes of the 77 findings stored on 2026-11-13 (kind, status, harm
// verdict, check or oracle name only; no title, no evidence, no secret).
// All 77 read as proven before N3.
test("the 77 stored findings: 30 proven, 47 candidates", () => {
  const shapes = JSON.parse(readFileSync(new URL("./fixtures/stored-finding-shapes.json", import.meta.url), "utf8"));
  assert.equal(shapes.length, 77);
  const proven = shapes.filter(isProven);
  assert.equal(proven.length, 30);
  assert.equal(shapes.length - proven.length, 47);
  const by = (list) => list.reduce((m, f) => ({ ...m, [`${f.pack}/${f.proof.kind ?? "forge"}`]: (m[`${f.pack}/${f.proof.kind ?? "forge"}`] ?? 0) + 1 }), {});
  assert.deepEqual(by(proven), { "contracts/forge": 26, "web/http": 3, "null/http": 1 });
  // The owner's six, and every other evidence finding, are candidates.
  assert.equal(shapes.filter((f) => f.proof.kind === "evidence" && isProven(f)).length, 0);
});
