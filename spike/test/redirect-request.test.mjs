import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestWithRedirects, retrySend } from '../lib/redirect-request.mjs';

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

// The live lane's retry: a rate-limited real target answers 429 to a burst.
// The wrapper hides it from the caller and from the transcript.

const sendBack = (responses) => {
  const calls = [];
  const fn = async (url, method) => { calls.push(method); return responses.shift(); };
  return { fn, calls };
};

test('retrySend retries a 429 and a 503, and returns the success', async () => {
  const s = sendBack([response(429), response(503), response(200)]);
  const res = await retrySend(s.fn, { maxWaitMs: 20_000 })(new URL('https://example.com/'), 'GET', {}, undefined);
  assert.equal(res.status, 200);
  assert.equal(s.calls.length, 3);
});

test('retrySend honours Retry-After but caps one wait, and gives up when the budget is gone', async () => {
  const capped = sendBack([{ status: 429, headers: { 'retry-after': '900' }, body: 'x' }, response(200)]);
  const started = Date.now();
  const res = await retrySend(capped.fn, { maxWaitMs: 20_000, maxSingleMs: 50 })(new URL('https://example.com/'), 'GET', {}, undefined);
  assert.equal(res.status, 200);
  assert.ok(Date.now() - started >= 45, 'waited roughly the capped Retry-After');

  // A Retry-After longer than the remaining budget is not waited for: the 429
  // is handed straight back so the agent can pace itself.
  const stuck = sendBack([{ status: 429, headers: { 'retry-after': '30' }, body: 'x' }, response(200)]);
  const out = await retrySend(stuck.fn, { attempts: 3, maxWaitMs: 2_000 })(new URL('https://example.com/'), 'POST', {}, '{}');
  assert.equal(out.status, 429);
  assert.equal(stuck.calls.length, 1, 'no wait budget left, so the 429 is handed back');

  const thrice = sendBack([response(429), response(429), response(429), response(200)]);
  const spent = await retrySend(thrice.fn, { attempts: 3 })(new URL('https://example.com/'), 'GET', {}, undefined);
  assert.equal(spent.status, 429);
  assert.equal(thrice.calls.length, 3, 'stops at the attempt cap');
});

test('retrySend retries a POST after a 429 with its body intact', async () => {
  const seen = [];
  const res = await retrySend(async (url, method, headers, body) => { seen.push(body); return seen.length === 1 ? response(429) : response(201); }, { maxWaitMs: 5_000 })(new URL('https://example.com/'), 'POST', {}, '{"a":1}');
  assert.equal(res.status, 201);
  assert.deepEqual(seen, ['{"a":1}', '{"a":1}']);
});
