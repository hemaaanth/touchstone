// Strix's SARIF becomes our lead shape. No Docker and no model here.
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

test("an empty, torn or ruleless document yields no leads", () => {
  assert.deepEqual(parseSarif(""), []);
  assert.deepEqual(parseSarif("not json"), []);
  assert.deepEqual(parseSarif(doc([{ level: "note" }])), []);
  assert.deepEqual(parseSarif(JSON.stringify({ runs: [] })), []);
});
