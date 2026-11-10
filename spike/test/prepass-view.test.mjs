import { test } from "node:test";
import assert from "node:assert/strict";
import { prepassView, prepassFailed } from "../lib/prepass-view.mjs";

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
