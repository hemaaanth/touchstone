import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestWithRedirects } from '../lib/redirect-request.mjs';

const run = (responses, options = {}, method = 'GET', headers = {}, body) => {
  const calls = [], records = [];
  const promise = requestWithRedirects(async (url, method, headers, body) => {
    calls.push({ url: url.href, method, headers: { ...headers }, body });
    return responses.shift();
  }, e => records.push(e), method, new URL('https://example.com/start'), headers, body, options);
  return { promise, calls, records };
};
const response = (status, location) => ({ status, headers: location ? { location } : {}, body: '{}' });

test('follows relative, subdomain, and public IP redirects and records each hop', async () => {
  const r = run([response(301, '/next'), response(302, 'https://app.example.com/'), response(307, 'https://8.8.8.8/end'), response(200)]);
  assert.equal((await r.promise).url, 'https://8.8.8.8/end');
  assert.deepEqual(r.records.map(e => e.status), [301, 302, 307, 200]);
});

test('cross-origin redirect strips credentials regardless of header casing', async () => {
  const r = run([response(307, 'https://app.example.com/'), response(200)], {}, 'POST', { Authorization: 'secret', Cookie: 'session', Host: 'example.com', Accept: 'application/json' }, 'payload');
  await r.promise;
  assert.deepEqual(r.calls[1].headers, { Accept: 'application/json' });
  assert.equal(r.calls[1].body, 'payload');
  assert.equal(r.calls[1].method, 'POST');
});

test('302 POST becomes GET; 303 preserves HEAD', async () => {
  const r = run([response(302, '/next'), response(200)], {}, 'POST', { 'Content-Type': 'text/plain' }, 'payload');
  await r.promise;
  assert.equal(r.calls[1].method, 'GET');
  assert.equal(r.calls[1].body, undefined);
  assert.deepEqual(r.calls[1].headers, {});
  const h = run([response(303, '/next'), response(200)], {}, 'HEAD');
  await h.promise;
  assert.equal(h.calls[1].method, 'HEAD');
});

test('redirect opt-out exposes the original response', async () => {
  const r = run([response(301, '/next')], { followRedirects: false });
  assert.equal((await r.promise).status, 301);
  assert.equal(r.calls.length, 1);
});

test('loops, excessive hops, URL credentials and non-HTTP redirects stop before sending', async () => {
  for (const [responses, options, message] of [
    [[response(301, '/start')], {}, /loop/],
    [[response(301, '/next')], { maxRedirects: 0 }, /limit/],
    [[response(301, 'file:///etc/passwd')], {}, /HTTP/],
    [[response(301, 'https://user:password@example.com/')], {}, /credentials/],
  ]) {
    const r = run(responses, options);
    await assert.rejects(r.promise, message);
    assert.equal(r.calls.length, 1);
  }
});
