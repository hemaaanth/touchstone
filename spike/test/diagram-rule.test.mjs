// The diagram rule (lib/diagram-rule.mjs) reaches every agent of a run, and the
// scope's notes and brief still close the instructions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DIAGRAM_RULE } from "../lib/diagram-rule.mjs";

test("the rule is short and says what the console draws, and that a picture is not evidence", () => {
  assert.match(DIAGRAM_RULE, /^\n\n## Diagrams\n\n/);
  assert.ok(DIAGRAM_RULE.length < 600, `short: ${DIAGRAM_RULE.length} characters`);
  assert.match(DIAGRAM_RULE, /one fenced `mermaid` block/);
  assert.match(DIAGRAM_RULE, /flowchart or a sequenceDiagram/);
  assert.match(DIAGRAM_RULE, /no style or colour lines/);
  assert.match(DIAGRAM_RULE, /Write the normal text as well\./);
  assert.match(DIAGRAM_RULE, /never replaces evidence/);
});

test("agent-run puts it in the one instruction string, before the scope notes and brief", () => {
  // agent-run.mjs runs on import, so its wiring is read from the source (as
  // source-nav.test.mjs does).
  const src = readFileSync(new URL("../agent-run.mjs", import.meta.url), "utf8");
  assert.match(src, /^import \{ DIAGRAM_RULE \} from "\.\/lib\/diagram-rule\.mjs";$/m);
  assert.match(src, /const system = pack\.system\(ws\) \+ navText \+ DIAGRAM_RULE \+ scopeInstructions\(process\.env\);/);
  // The root agent (and the fleet coordinator) get `system`; each fleet child
  // is built from the same `system` (lib/fleet.mjs createFleet).
  assert.match(src, /instructions: system \+ \(fleet \? `\\n\\n\$\{fleet\.instructions\}` : ""\)/);
  assert.match(src, /createFleet\(\{ system,/);
  const fleet = readFileSync(new URL("../lib/fleet.mjs", import.meta.url), "utf8");
  assert.match(fleet, /instructions: `\$\{system\}\\n\\nYou are trusted child/);
});
