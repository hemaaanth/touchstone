import { test } from "node:test";
import assert from "node:assert/strict";
import { prepassView, prepassFailed, prepassFromResult } from "../lib/prepass-view.mjs";
import { halmosRecord } from "../packs/contracts/halmos.mjs";
import { chimeraRecord } from "../packs/contracts/chimera.mjs";

test("a Contracts record shows static and fuzz as tools, worst lead first", () => {
  const v = prepassView({
    static: { engines: ["Slither", "Aderyn"], suspects: 2, top: [
      { check: "reentrancy", impact: "Medium", where: "Vault.withdraw", line: 41, engines: ["Slither"], corroborated: false },
      { check: "unchecked-call", impact: "High", where: "Vault.sweep", line: 9, engines: ["Slither", "Aderyn"], corroborated: true },
    ] },
    fuzz: { engines: ["Echidna"], applicable: false, suspects: 0, top: [], reason: "No invariant template fits." },
  });
  assert.equal(v.tools.length, 2);
  assert.deepEqual(v.tools.map((t) => t.status), ["ran", "unavailable"]);
  assert.equal(v.tools[1].reason, "No invariant template fits.");
  assert.equal(v.leads[0].check, "unchecked-call");
  assert.equal(v.leads[0].where, "Vault.sweep:9");
  assert.equal(v.leads[0].corroborated, true);
  assert.equal(v.total, 2);
});

test("a supply-chain record keeps a tool error's reason and never copies a secret", () => {
  const v = prepassView({
    coverage: [
      { engine: "gitleaks", status: "ok", leads: 1 },
      { engine: "osv-scanner", status: "error", code: 2, leads: 0 },
      { engine: "trivy", status: "error", timedOut: true, leads: 0 },
    ],
    leads: [
      { engine: "gitleaks", check: "aws-key", impact: "High", where: { file: "src/.env", line: 3, rule: "aws" }, description: "Secret in a tracked file", secret: { redacted: "AKIA…", sha256: "ab12" }, secretValue: "AKIAREALKEY" },
      { engine: "osv-scanner", check: "CVE-1", impact: "Low", where: { file: "package.json", package: "left-pad" }, package: "left-pad", version: "1.0.0" },
    ],
  });
  assert.deepEqual(v.tools.map((t) => t.status), ["ran", "unavailable", "unavailable"]);
  assert.equal(v.tools[1].reason, "Exited with code 2.");
  assert.equal(v.tools[2].reason, "Timed out.");
  assert.equal(v.leads[0].where, "src/.env:3");
  assert.equal(v.leads[1].where, "package.json");
  assert.ok(!JSON.stringify(v).includes("AKIAREALKEY"));
});

test("a record with only leads names its tools from the leads; empty and junk give null", () => {
  const v = prepassView({ leads: [{ engine: "a", check: "x", impact: "Low" }, { engine: "a", check: "y", impact: "Info" }] });
  assert.deepEqual(v.tools, [{ name: "a", status: "ran", reason: null, leads: 2 }]);
  assert.equal(prepassView(null), null);
  assert.equal(prepassView({}), null);
  assert.equal(prepassView("junk"), null);
  assert.equal(prepassView({ leads: "no" }), null);
});

test("leads are capped and the real count is kept", () => {
  const leads = Array.from({ length: 80 }, (_, i) => ({ engine: "t", check: `c${i}`, impact: "Low" }));
  const v = prepassView({ leads });
  assert.equal(v.leads.length, 50);
  assert.equal(v.total, 80);
});

test("a failed prepass has no detail", () => {
  assert.deepEqual(prepassFailed(), { total: 0, tools: [], leads: [], failed: true });
});

test("a chain pack record with a top list becomes one tool named by its mode", () => {
  const v = prepassView({ mode: "keys", block: 12, suspects: 9, corroborated: 2, top: [
    { check: "threshold-1", impact: "Medium", where: "Safe 0xab" },
    { check: "module-enabled", impact: "High", where: { name: "Safe 0xcd" } },
  ] });
  assert.deepEqual(v.tools, [{ name: "keys", status: "ran", reason: null, leads: 9 }]);
  assert.equal(v.leads[0].check, "module-enabled");
  assert.equal(v.leads[0].where, "Safe 0xcd");
  assert.deepEqual(v.leads[0].tools, ["keys"]);
  assert.equal(v.total, 9);
});

test("a CLI record keeps its prepass at the top level; the fold is built from it", () => {
  const cli = {
    alias: "qwen-abl", status: "recorded", findings: [{ title: "x" }],
    coverage: [{ engine: "gitleaks", status: "ok", leads: 1 }],
    leads: [{ check: "leaked-key", impact: "high", where: "config.env", engine: "gitleaks" }],
  };
  const view = prepassView(prepassFromResult(cli));
  assert.equal(view.total, 1);
  assert.equal(view.tools[0].name, "gitleaks");
  assert.equal(view.leads[0].check, "leaked-key");
  // the chain packs' top list, an app record's own `prepass`, and a bare result
  assert.equal(prepassView(prepassFromResult({ mode: "keys", top: [{ check: "a", impact: "low" }] })).tools[0].name, "keys");
  const own = { leads: [{ check: "z" }] };
  assert.equal(prepassFromResult({ prepass: own, leads: [{ check: "other" }] }), own);
  assert.equal(prepassFromResult({ alias: "a", findings: [], pack: "domains" }), null);
  assert.equal(prepassFromResult(null), null);
});

test("a CLI Contracts record keeps its Halmos and Chimera rows next to static", () => {
  // The shape agent-run.mjs writes: the pack record spread into the result.
  const symbolic = halmosRecord({
    tool: "halmos", available: true, applicable: true, reason: null, gaps: [], trust: {},
    results: [{ name: "check_withdraw", status: "counterexample" }],
    leads: [{ check: "symbolic-counterexample", impact: "High", where: "test/Vault.t.sol", property: "check_withdraw" }],
  });
  const chimera = chimeraRecord({
    tool: "chimera", engines: ["echidna", "medusa"], available: false, applicable: true,
    reason: "the suite did not compile", gaps: [], trust: {}, results: [], leads: [],
  });
  const cli = {
    alias: "qwen-abl", status: "recorded", findings: [],
    static: { tool: "slither", engines: ["slither"], suspects: 0, top: [] },
    symbolic, chimera,
  };
  const view = prepassView(prepassFromResult(cli));
  assert.deepEqual(view.tools.map((t) => t.name), ["slither", "halmos", "chimera"]);
  assert.equal(view.tools[2].status, "unavailable");
  assert.equal(view.tools[2].reason, "the suite did not compile");
  assert.equal(view.leads.length, 1);
  assert.equal(view.leads[0].check, "symbolic-counterexample");
  // A record with only the new phases is still a Contracts record.
  assert.equal(prepassView(prepassFromResult({ alias: "a", symbolic })).leads.length, 1);
  assert.equal(prepassView({ chimera }).tools[0].name, "chimera");
});

test("a ZAP lead shows its rule id and CWE, also from an older record", () => {
  const v = prepassView({ leads: [
    { engine: "zap", check: "CSP header not set", impact: "Medium", where: "/", rule: "10038", cwe: "693", description: "ZAP rule 10038, CWE-693. Parameter: q." },
    { engine: "zap", check: "Cookie without flag", impact: "Low", where: "/login", description: "ZAP rule 10010, CWE-1004. Parameter: sid." },
    { engine: "zap", check: "Info leak", impact: "Info", where: "/x", description: "ZAP rule 10027. " },
    { engine: "semgrep", check: "sqli", impact: "High", where: "a.js", description: "Raw query." },
  ] });
  const by = Object.fromEntries(v.leads.map((l) => [l.check, l]));
  assert.equal(by["CSP header not set"].rule, "10038 · CWE-693");
  assert.equal(by["CSP header not set"].detail, "Parameter: q.");
  assert.equal(by["Cookie without flag"].rule, "10010 · CWE-1004");
  assert.equal(by["Cookie without flag"].detail, "Parameter: sid.");
  assert.equal(by["Info leak"].rule, "10027");
  assert.equal(by.sqli.rule, "");
  assert.equal(by.sqli.detail, "Raw query.");
});
