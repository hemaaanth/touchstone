import './helpers/isolated-env.mjs';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const calls = [];
const actual = await import("../lib/reach-confine.mjs");
mock.module('../lib/reach-confine.mjs', { namedExports: { ...actual, confineReach: async options => {
  calls.push(options);
  return { gateUrl: 'http://scope-gate:8899', stop: async () => {} };
} } });
const { openReach } = await import('../lib/reach.mjs');
const { addLiveScope } = await import('../lib/scopes-store.mjs');
const { targetSummary } = await import('../lib/targets.mjs');

test('existing and new sandbox scopes default to strict; public requires a saved opt-in', async () => {
  const scope = addLiveScope({ hosts: ['example.com'], permission: true });
  const handle = await openReach(scope, { mode: 'confine' });
  assert.equal(calls.at(-1).networkPolicy, 'strict');
  assert.equal(handle.env.TOUCHSTONE_NETWORK_POLICY, 'strict');
  await handle.stop();
  const strict = addLiveScope({ hosts: ['example.org'], permission: true, networkPolicy: 'public' });
  assert.equal(targetSummary(strict).networkPolicy, 'public');
  await openReach(strict, { mode: 'confine' });
  assert.equal(calls.at(-1).networkPolicy, 'public');
});

test('private labs retain strict confinement; public policy requires a sandbox', async () => {
  const scope = addLiveScope({ hosts: ['127.0.0.1'], permission: true, allowPrivate: true });
  await openReach(scope, { mode: 'confine' });
  assert.equal(calls.at(-1).networkPolicy, 'strict');
  assert.equal(calls.at(-1).allowPrivate, true);
  const publicScope = addLiveScope({ hosts: ['example.net'], permission: true, networkPolicy: 'public' });
  await assert.rejects(openReach(publicScope), /requires sandbox/);
  assert.throws(() => addLiveScope({ hosts: ['example.net'], permission: true, networkPolicy: 'typo' }), /Unknown network policy/);
});
