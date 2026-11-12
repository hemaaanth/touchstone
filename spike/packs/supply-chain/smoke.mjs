import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { makeLabWorkspace } from "./lab.mjs";
import pack from "./pack.mjs";
import { loadSnapshot } from "../../lib/proof-evidence.mjs";

const ws = await makeLabWorkspace();
try {
  const prep = await pack.prepass(ws, { emit: () => {} });
  // A missing grype database is a reported gap, never a clean result. Any other non-ok status fails.
  const gaps = prep.record.coverage.filter((r) => r.status !== "ok");
  assert.ok(gaps.every((r) => r.engine === "grype" && r.status === "gap"), JSON.stringify(prep.record.coverage));
  if (gaps.length) console.error("note: grype database missing. Run packs/supply-chain/refresh-db.mjs for full coverage.");
  assert.ok(prep.record.coverage.length >= 7, "Every named tool must report coverage");
  const leads = prep.record.leads;
  for (const check of ["evm-private-key", "rpc-provider-key", "evm-keystore", "crypto-package-lookalike", "dependency-reaches-signer", "GHSA-35jh-r3h4-6jhm", "zizmor/unpinned-uses"]) assert.ok(leads.some((l) => l.check === check), `Missing ${check}`);
  // The planted dependency: only our own check and semgrep see it. A lockfile or advisory scan does not.
  const plant = leads.find((l) => l.rootCause === "malicious-dependency:ethres");
  assert.ok(plant && plant.check === "dependency-reaches-signer", "The planted dependency must lead as a signer reach");
  assert.ok(plant.engines.includes("semgrep"), "Semgrep must corroborate the planted dependency");
  assert.ok(!leads.some((l) => ["osv", "grype"].includes(l.engines[0]) && /ethres/.test(l.rootCause)), "No advisory scanner knows the planted dependency");
  if (!gaps.length) assert.ok(leads.some((l) => l.engines.includes("grype") && l.engines.includes("osv")), "Grype and OSV must agree on lodash");
  assert.ok(leads.some((l) => l.support.some((s) => s.check === "bip39-mnemonic")), "Mnemonic must corroborate the same signer");
  assert.ok(leads.some((l) => l.evidence.check === "tool:poutine" && l.evidence.where.rule === "untrusted_checkout_exec"), "Workflow replay must confirm the execution chain");
  const state = { poc: 0, passed: new Map(), found: [] };
  const tools = Object.fromEntries(pack.tools(ws, state).map((t) => [t.name, t]));
  const first = leads[0];
  assert.equal((await tools.submit_finding.execute({ lead_id: first.id, severity: "high" })).isError, true);
  for (const lead of leads) {
    const proof = await tools.check_evidence.execute({ lead_id: lead.id });
    assert.notEqual(proof.isError, true, `Replay failed: ${lead.check}`);
    const finding = await tools.submit_finding.execute({ lead_id: lead.id, severity: lead.impact === "High" ? "high" : lead.impact === "Low" ? "low" : "medium" });
    assert.notEqual(finding.isError, true, `Submit failed: ${lead.check}`);
  }
  assert.equal((await tools.submit_finding.execute({ lead_id: first.id, severity: "high" })).isError, true);
  const proven = await pack.prove(ws, state.found, [], () => {});
  assert.equal(proven.length, leads.length);
  const { snapshot } = loadSnapshot(ws);
  const publicText = JSON.stringify({ prep, proven });
  const secretValues = [snapshot.files["wallet.env"].match(/PRIVATE_KEY=(\S+)/)[1], snapshot.files["wallet.env"].match(/MNEMONIC="([^"]+)"/)[1], snapshot.files["hardhat.config.js"].match(/accounts: \["([^"]+)"/)[1], "LabOnly_f63N8bcQ4mwJzP2hR7sV9xKa", JSON.parse(snapshot.files["keystore.json"]).Crypto.ciphertext];
  for (const value of secretValues) assert.ok(!publicText.includes(value), "Secret reached public output");
  console.log(JSON.stringify({ smoke: "pass", coverage: prep.record.coverage, findings: proven.length, commit: prep.record.commit, checks: [...new Set(proven.map((f) => f.evidence.check))], spendUsd: 0 }, null, 2));
} finally { rmSync(ws, { recursive: true, force: true }); }
