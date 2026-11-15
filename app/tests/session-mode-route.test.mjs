// The session-mode write: one control line on the worker's stdin, and the two
// refusals (no run, no live worker). Pure, from the real source text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../server/runs.mjs", import.meta.url), "utf8");
const body = source
  .slice(source.indexOf("export function setSessionMode("), source.indexOf("// Stop a run's work"))
  .replace("export function", "function");

const wire = (run, viewOnly) => {
  const lines = [];
  const set = runInNewContext(`${body}; setSessionMode`, {
    runs: new Map(run ? [["r", run]] : []),
  });
  const result = set("r", viewOnly);
  return { result, lines };
};

test("a mode switch writes exactly one tagged line", () => {
  const lines = [];
  const run = { child: { stdin: { writable: true, write: (l) => lines.push(l) } } };
  const set = runInNewContext(`${body}; setSessionMode`, { runs: new Map([["r", run]]) });
  assert.equal(JSON.stringify(set("r", false)), JSON.stringify({ ok: true, viewOnly: false }));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].trim(), JSON.stringify({ sessionMode: { viewOnly: false } }));
});

test("a touch renew carries the flag", () => {
  const lines = [];
  const run = { child: { stdin: { writable: true, write: (l) => lines.push(l) } } };
  const set = runInNewContext(`${body}; setSessionMode`, { runs: new Map([["r", run]]) });
  set("r", false, { touch: true });
  assert.equal(lines[0].trim(), JSON.stringify({ sessionMode: { viewOnly: false, touch: true } }));
});

test("a pause-only line drops the mode fields", () => {
  const lines = [];
  const run = { child: { stdin: { writable: true, write: (l) => lines.push(l) } } };
  const set = runInNewContext(`${body}; setSessionMode`, { runs: new Map([["r", run]]) });
  set("r", false, { agentPause: false, pauseOnly: true });
  assert.equal(lines[0].trim(), JSON.stringify({ agentPause: false }));
});

test("a missing run, a non-boolean and an idle run are refused", () => {
  const set = runInNewContext(`${body}; setSessionMode`, { runs: new Map([["r", { child: null }]]) });
  assert.throws(() => set("nope", true), /not found/);
  assert.throws(() => set("r", "yes"), /true or false/);
  assert.throws(() => set("r", true), /no live browser session/);
});
