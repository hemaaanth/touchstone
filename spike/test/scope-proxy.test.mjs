// Tests for the scope proxy: one gate all target-bound traffic passes through.
//
// The pure decision (decide) is tested with no I/O. The running gate is tested
// against a local http "target" server: an allowed host is forwarded and logged;
// a non-allowed host is blocked with 403, logged, and never reaches a target.
//
//   node --test spike/test/scope-proxy.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { decide, ScopeLog, startScopeProxy } from "../lib/scope-proxy.mjs";

test("decide allows a listed host, blocks the rest, and an empty list blocks all", () => {
  assert.equal(decide(["example.com"], "example.com").allowed, true);
  assert.equal(decide(["example.com"], "example.com:443").allowed, true); // port ignored
  assert.equal(decide(["*.example.com"], "api.example.com").allowed, true);
  assert.equal(decide(["example.com"], "evil.com").allowed, false);
  assert.equal(decide([], "example.com").allowed, false);
  assert.match(decide([], "example.com").reason, /empty allow-list/);
  assert.equal(decide(["example.com"], "").allowed, false);
});

test("ScopeLog records one line per request and summarizes reached and blocked hosts", () => {
  const lines = [];
  const log = new ScopeLog({ sink: (l) => lines.push(l) });
  log.record({ host: "a.com", method: "GET", url: "http://a.com/", allowed: true, status: 200 });
  log.record({ host: "evil.com", method: "GET", url: "http://evil.com/", allowed: false, status: 403 });
  log.record({ host: "a.com", method: "POST", url: "http://a.com/x", allowed: true, status: 201 });
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith("__TOUCHSTONE_SCOPE__ "));
  assert.deepEqual(log.reached(), ["a.com"]);
  assert.deepEqual(log.blocked(), ["evil.com"]);
  const s = log.summary();
  assert.equal(s.total, 3);
  assert.equal(s.allowed, 2);
  assert.equal(s.blocked, 1);
});

// A local http server stands in for the real target. The gate forwards an
// allowed request to it. We point requests at the gate with the x-touchstone-url
// header, which plain fetch can set (no proxy-agent dependency).
let target, targetUrl;
before(async () => {
  target = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ saw: req.method + " " + req.url, host: req.headers.host }));
  });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  targetUrl = `http://127.0.0.1:${target.address().port}`;
});
after(() => target && target.close());

test("the gate forwards an allowed host and logs the exchange", async () => {
  const gate = await startScopeProxy({ allowedHosts: ["127.0.0.1"] });
  try {
    const r = await fetch(gate.url, { headers: { "x-touchstone-url": targetUrl + "/hello" } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.match(body.saw, /GET \/hello/);
    const recs = gate.log.records;
    assert.equal(recs.length, 1);
    assert.equal(recs[0].decision, "allow");
    assert.equal(recs[0].host, "127.0.0.1");
    assert.equal(recs[0].status, 200);
    assert.deepEqual(gate.log.reached(), ["127.0.0.1"]);
  } finally {
    await gate.stop();
  }
});

test("the gate blocks a host with no grant: 403, logged, and the target is never reached", async () => {
  let targetHits = 0;
  target.on("request", () => { targetHits++; });
  const hitsBefore = targetHits;
  // Allow-list does NOT include the target's host (127.0.0.1): point the gate at
  // an empty list, so any request is blocked.
  const gate = await startScopeProxy({ allowedHosts: ["only-this.example.com"] });
  try {
    const r = await fetch(gate.url, { headers: { "x-touchstone-url": targetUrl + "/secret" } });
    assert.equal(r.status, 403);
    const text = await r.text();
    assert.match(text, /blocked/i);
    assert.equal(targetHits, hitsBefore); // the gate never forwarded to the target
    const recs = gate.log.records;
    assert.equal(recs.length, 1);
    assert.equal(recs[0].decision, "block");
    assert.equal(recs[0].status, 403);
    assert.deepEqual(gate.log.blocked(), ["127.0.0.1"]);
  } finally {
    await gate.stop();
  }
});

test("the gate rejects a request with no target url", async () => {
  const gate = await startScopeProxy({ allowedHosts: ["127.0.0.1"] });
  try {
    const r = await fetch(gate.url, { headers: {} });
    assert.equal(r.status, 400);
    assert.equal(gate.log.records[0].decision, "block");
    assert.equal(gate.log.records[0].status, 400);
  } finally {
    await gate.stop();
  }
});

test("a POST body is forwarded to an allowed target", async () => {
  const gate = await startScopeProxy({ allowedHosts: ["127.0.0.1"] });
  try {
    const r = await fetch(gate.url, {
      method: "POST",
      headers: { "x-touchstone-url": targetUrl + "/submit", "content-type": "text/plain" },
      body: "payload",
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.match(body.saw, /POST \/submit/);
    assert.equal(gate.log.records[0].decision, "allow");
  } finally {
    await gate.stop();
  }
});
