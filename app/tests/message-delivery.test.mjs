import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';

const source = readFileSync(new URL('../server/runs.mjs', import.meta.url), 'utf8');
// The slice can hold more than steerRun now; strip every export keyword.
const body = source.slice(source.indexOf('export function steerRun('), source.indexOf('// Stop a run', source.indexOf('export function steerRun('))).replaceAll('export function', 'function');
for (const idle of [true, false]) test(`retry after a lost response sends once (${idle ? 'follow-up' : 'live'})`, () => {
  let writes = 0;
  const run = { events: [], child: { stdin: { writable: true, write() { writes++; } } } };
  const steer = runInNewContext(`${body}; steerRun`, {
    runs: new Map([['r', run]]), createHash, idle: () => idle,
    followUp() { writes++; return { ok: true, followUp: true }; },
    broadcast(run, event) { run.events.push(event); },
  });
  assert.equal(steer('r', 'hello', 'm1').ok, true);
  assert.equal(steer('r', 'hello', 'm1').ok, true);
  assert.equal(writes, 1);
  assert.throws(() => steer('r', 'different', 'm1'), /different text/);
  assert.equal(writes, 1);
});
