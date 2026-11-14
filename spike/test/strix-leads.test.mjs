// Strix's SARIF becomes our lead shape. No Docker and no model here.
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSarif } from "../lib/strix.mjs";

const doc = (results) => JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "Strix" } }, results }] });

test("a SARIF result becomes one lead, worst impact from the stored severity", () => {
  const leads = parseSarif(doc([
    { ruleId: "CWE-89", level: "error", message: { text: "SQL injection\n\nunion in the id param" }, properties: { strix: { severity: "critical" } }, locations: [{ physicalLocation: { artifactLocation: { uri: "https://app.example.com/users?id=1" } } }] },
  ]));
  assert.equal(leads.length, 1);
  assert.equal(leads[0].check, "CWE-89");
  assert.equal(leads[0].impact, "High");
  assert.equal(leads[0].where, "/users");
  assert.match(leads[0].description, /SQL injection/);
  assert.equal(leads[0].engine, "strix");
});

test("a missing stored severity falls back to the SARIF level", () => {
  const [l] = parseSarif(doc([{ ruleId: "CWE-79", level: "warning", message: { text: "XSS" } }]));
  assert.equal(l.impact, "Medium");
  assert.equal(l.where, "/");
});

test("a SECURITY.md anchor yields the path named in the write-up", () => {
  const [l] = parseSarif(doc([{
    ruleId: "CWE-89",
    level: "error",
    message: { text: "SQL injection in /doLogin lets an admin bypass" },
    locations: [{ physicalLocation: { artifactLocation: { uri: "SECURITY.md" } } }],
  }]));
  assert.equal(l.where, "/doLogin");
});

test("a Strix lead can never be proven: the fields say so structurally", () => {
  // The oracle name shape does not matter. Strix keeps the CWE as its check, so
  // even a check that happens to match an oracle name stays a lead, and only the
  // gated replay may mint it into a finding.
  const [lead] = parseSarif(doc([{
    ruleId: "reflected-xss",
    level: "error",
    message: { text: "XSS in /search" },
    locations: [{ physicalLocation: { artifactLocation: { uri: "SECURITY.md" } } }],
  }]));
  assert.equal(lead.proven, false);
  assert.equal(lead.corroborated, false);
  assert.equal(lead.engine, "strix");
  assert.equal(lead.source, "strix");
});

test("merging a Strix lead keeps it unproven and uncorroborated", async () => {
  const { mergeLeads } = await import("../packs/web/scan.mjs");
  const [lead] = parseSarif(doc([{ ruleId: "CWE-79", level: "warning", message: { text: "XSS" } }]));
  const merged = mergeLeads([lead]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].proven, false);
  assert.equal(merged[0].corroborated, false);
});

test("coverage rows are not leads", () => {
  assert.deepEqual(parseSarif(doc([
    { ruleId: "strix-coverage/injection-input-handling", level: "note", message: { text: "Injection — Not applicable: /" } },
    { ruleId: "CWE-89", level: "error", message: { text: "SQLi in /login" } },
  ])).map((l) => l.check), ["CWE-89"]);
});

test("an empty, torn or ruleless document yields no leads", () => {
  assert.deepEqual(parseSarif(""), []);
  assert.deepEqual(parseSarif("not json"), []);
  assert.deepEqual(parseSarif(doc([{ level: "note" }])), []);
  assert.deepEqual(parseSarif(JSON.stringify({ runs: [] })), []);
});
