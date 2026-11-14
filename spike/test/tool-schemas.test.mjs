// Every offered tool must carry a parameters schema. Without one, prompt
// planning dies inside the framework with `"undefined" is not valid JSON` and
// the run settles before a single model call — an edit once swallowed the block
// and only a real run caught it.
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PACKS } from "../packs/index.mjs";
import { askHumanTool } from "../lib/ask.mjs";
import { ideaTool } from "../lib/candidate.mjs";

const state = () => ({ poc: 0, found: [], passed: new Map(), candidates: [] });
const workspaces = [
  { kind: "live", live: {} },
  { kind: "lab" },
];

for (const [id, pack] of Object.entries(PACKS)) {
  test(`${id}: every pack tool declares parameters`, () => {
    for (const ws of workspaces) {
      let tools;
      try { tools = pack.tools(ws, state()); } catch { continue; }
      for (const t of tools) {
        assert.equal(typeof t.name, "string");
        assert.notEqual(t.parameters, undefined, `${id}/${t.name} has no parameters schema`);
        assert.notEqual(JSON.stringify(t.parameters), undefined, `${id}/${t.name} has an unserialisable schema`);
      }
    }
  });
}

test("the shared tools declare parameters too", () => {
  for (const t of [askHumanTool, ideaTool(state())]) {
    assert.notEqual(t.parameters, undefined, `${t.name} has no parameters schema`);
  }
});
