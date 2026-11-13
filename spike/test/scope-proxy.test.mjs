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
  // allowPrivate: the stand-in target is a loopback server, which the proxy's
  // SSRF pin refuses by default; a real run would reach a public host.
  const gate = await startScopeProxy({ allowedHosts: ["127.0.0.1"], allowPrivate: true });
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
  const gate = await startScopeProxy({ allowedHosts: ["127.0.0.1"], allowPrivate: true });
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

// Regression tests for the private-lab opt-in. The gate decides on the parsed
// address, never on the spelling, and the opt-in never reaches metadata.

test("decide keeps an IPv6 literal whole and never matches it to a DNS name", () => {
  assert.equal(decide(["fd00::1"], "fd00::1").allowed, true);
  assert.equal(decide(["fd00::1"], "[fd00::1]").allowed, true);
  assert.equal(decide(["fd00::1"], "[fd00:0:0:0:0:0:0:1]:8080").allowed, true);
  assert.equal(decide(["fd00::1"], "fd00").allowed, false);
  assert.equal(decide(["::1"], "[::1]:8080").allowed, true);
  // An encoded IPv4 form is the same address as its dotted form.
  assert.equal(decide(["127.0.0.1"], "2130706433").allowed, true);
  // A wildcard never covers an IP address.
  assert.equal(decide(["*.example.com"], "127.0.0.1").allowed, false);
});

test("with the opt-in, a metadata address on the allow-list is still blocked before any connection", async () => {
  for (const url of [
    "http://169.254.169.254/latest/meta-data/",
    "http://[fd00:ec2::254]/latest/meta-data/",
    "http://[::ffff:169.254.169.254]/latest/meta-data/",
    "http://0.0.0.0/",
  ]) {
    const host = new URL(url).hostname.replace(/^\[(.*)\]$/, "$1");
    const gate = await startScopeProxy({ allowedHosts: [host], allowPrivate: true, log: new ScopeLog({ sink: () => {} }) });
    try {
      const r = await fetch(gate.url, { headers: { "x-touchstone-url": url } });
      assert.equal(r.status, 403, url);
      assert.match(await r.text(), /never-reachable/, url);
      const [rec] = gate.log.records;
      assert.equal(rec.decision, "block", url);
      // Blocked by the address pin, which runs before any socket is opened.
      assert.match(rec.reason, /never-reachable/, url);
    } finally {
      await gate.stop();
    }
  }
});

test("without the opt-in, a loopback target on the allow-list is blocked by the address pin", async () => {
  const gate = await startScopeProxy({ allowedHosts: ["127.0.0.1"], log: new ScopeLog({ sink: () => {} }) });
  try {
    const r = await fetch(gate.url, { headers: { "x-touchstone-url": targetUrl + "/x" } });
    assert.equal(r.status, 403);
    assert.match(gate.log.records[0].reason, /non-public/);
  } finally {
    await gate.stop();
  }
});

test("with the opt-in, an IPv6 loopback lab is reached through the gate", async (t) => {
  const v6 = http.createServer((req, res) => res.end("v6 lab"));
  try {
    await new Promise((resolve, reject) => {
      v6.once("error", reject);
      v6.listen(0, "::1", resolve);
    });
  } catch {
    t.skip("this host has no IPv6 loopback");
    return;
  }
  const gate = await startScopeProxy({ allowedHosts: ["::1"], allowPrivate: true, log: new ScopeLog({ sink: () => {} }) });
  try {
    const r = await fetch(gate.url, { headers: { "x-touchstone-url": `http://[::1]:${v6.address().port}/` } });
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "v6 lab");
    assert.equal(gate.log.records[0].decision, "allow");
  } finally {
    await gate.stop();
    v6.close();
  }
});
