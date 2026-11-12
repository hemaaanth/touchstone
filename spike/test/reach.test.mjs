// Tests for the reach gate: the one place a run is allowed (or refused) to touch
// a live host, and the one place its egress is confined to the granted hosts.
//
// Two invariants are proven end to end here:
//   - NO GRANT ⇒ NO DISPATCH. A live-reach target with no grant for its host is
//     REFUSED before anything starts; no scope proxy is opened. An offline lab is
//     untouched — it opens an inert handle and starts no proxy.
//   - GRANT ⇒ ONLY THE GRANTED HOST. With a grant, the proxy that openReach
//     starts forwards to the granted host and blocks a sibling, a subdomain, and
//     a look-alike — not "contains", an exact (or explicit "*.") host match.
//
// A throwaway store via TOUCHSTONE_GRANTS_FILE, so spike/data/grants.json is
// never touched. A local http server stands in for the granted host. No docker.
//
//   node --test spike/test/reach.test.mjs
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "reach-test-"));
process.env.TOUCHSTONE_GRANTS_FILE = path.join(dir, "grants.json");
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => rmSync(process.env.TOUCHSTONE_GRANTS_FILE, { force: true }));

// Loaded after the env var is set, so the store reads the throwaway file.
const { addGrant } = await import("../lib/grant-store.mjs");
const { reachHosts, enforceReach, isNetworkKind, openReach, NON_NETWORK_KINDS } = await import("../lib/reach.mjs");
const { targetSummary, resolveTargetDir, prepareWorkspace, prepareRunWorkspace } = await import("../lib/targets.mjs");

// A local http server stands in for the granted host. Pointed at via the
// x-touchstone-url header, which plain fetch can set (no proxy-agent dependency).
let target, targetUrl;
before(async () => {
  target = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  targetUrl = `http://127.0.0.1:${target.address().port}`;
});
after(() => target && target.close());

test("reachHosts reads a host from any field name a target may use", () => {
  assert.deepEqual(reachHosts({ hosts: ["Example.com"] }), ["example.com"]);
  assert.deepEqual(reachHosts({ host: "https://api.example.com/v1" }), ["api.example.com"]);
  assert.deepEqual(reachHosts({ url: "http://a.example.com:8443/x" }), ["a.example.com"]);
  assert.deepEqual(reachHosts({ domain: "b.example.com" }), ["b.example.com"]);
  assert.deepEqual(reachHosts({ baseUrl: "https://c.example.com" }), ["c.example.com"]);
  assert.deepEqual(reachHosts({ origin: "https://d.example.com" }), ["d.example.com"]);
  assert.deepEqual(reachHosts({ reach: { hosts: ["e.example.com"] } }), ["e.example.com"]);
  // Deduplicated, first-seen order, across fields.
  assert.deepEqual(reachHosts({ hosts: ["x.com"], host: "x.com", url: "https://y.com" }), ["x.com", "y.com"]);
  // Nothing usable ⇒ no host.
  assert.deepEqual(reachHosts({ title: "no host here" }), []);
});

test("default-deny by kind: only the offline kinds may run with no host", () => {
  for (const k of NON_NETWORK_KINDS) assert.equal(isNetworkKind(k), false);
  // A kind we do not recognize is treated as a live network kind, not waved through.
  assert.equal(isNetworkKind("live"), true);
  assert.equal(isNetworkKind("mystery-kind"), true);
  assert.equal(isNetworkKind(undefined), true);
});

test("an offline kind with no host passes the gate and opens no proxy", async () => {
  const r = enforceReach({ kind: "lab" });
  assert.deepEqual(r.hosts, []);
  assert.equal(r.networkKind, false);
  const handle = await openReach({ kind: "lab" });
  assert.equal(handle.live, false);
  assert.equal(handle.proxy, null);
  assert.deepEqual(handle.env, {});
  await handle.stop();
});

test("a live kind that names no host is refused (default-deny)", async () => {
  assert.throws(() => enforceReach({ kind: "live" }), /reaches the network but names no host/);
  await assert.rejects(() => openReach({ kind: "live" }), /names no host/);
});

test("an unknown kind that names no host is refused", async () => {
  assert.throws(() => enforceReach({ kind: "mystery-kind" }), /reaches the network but names no host/);
});

test("NO GRANT ⇒ NO DISPATCH: a live target with no grant is refused and starts no proxy", async () => {
  // A host present always needs a grant; with none, requireGrant throws naming it.
  assert.throws(() => enforceReach({ kind: "live", hosts: ["app.example.com"] }), /app\.example\.com/);
  await assert.rejects(() => openReach({ kind: "live", hosts: ["app.example.com"] }), /app\.example\.com/);
});

test("GRANT ⇒ ONLY THE GRANTED HOST: the proxy forwards the granted host and blocks the rest", async () => {
  // allowPrivate: 127.0.0.1 is a loopback address, which addGrant refuses by
  // default (SSRF guard); this operator-owned local target opts in explicitly.
  addGrant({ hosts: ["127.0.0.1"], kind: "operator-owned", ownership: true, note: "test host", allowPrivate: true });
  const handle = await openReach({ kind: "live", hosts: ["127.0.0.1"] });
  try {
    assert.equal(handle.live, true);
    assert.deepEqual(handle.allowedHosts, ["127.0.0.1"]);
    // The env carries the proxy to the module seam, not the process-wide HTTP_PROXY.
    assert.equal(handle.env.TOUCHSTONE_SCOPE_PROXY, handle.proxy.url);
    assert.equal(handle.env.TOUCHSTONE_SCOPE_ALLOW, "127.0.0.1");

    // The granted host is forwarded: 200 from the local target.
    const ok = await fetch(handle.proxy.url, { headers: { "x-touchstone-url": targetUrl + "/x" } });
    assert.equal(ok.status, 200);

    // A sibling, a look-alike whose host merely STARTS with the granted string,
    // and an unrelated host are all blocked (403), never reached — the match is
    // anchored on the whole host, not a substring.
    for (const bad of ["http://127.0.0.2/x", "http://127.0.0.1.evil.com/x", "http://evil.com/x"]) {
      const r = await fetch(handle.proxy.url, { headers: { "x-touchstone-url": bad } });
      assert.equal(r.status, 403, `expected ${bad} to be blocked`);
    }
  } finally {
    await handle.stop();
  }
});

test("a live target is runnable: it gets a workspace that names its hosts", async () => {
  // The operator adds a live scope with a permission checkbox (scopes-store
  // addLiveScope), so "live" is offered like any other scope. The grant check
  // runs at run start (openReach), not when the workspace is built.
  const live = { id: "live-probe", title: "A live host", kind: "live", hosts: ["app.example.com"], pack: "web" };

  // The summary shows the host(s) a run would touch.
  const s = targetSummary(live);
  assert.equal(s.kind, "live");
  assert.deepEqual(s.hosts, ["app.example.com"]);

  // A live target has no directory; it is never a lab.
  assert.throws(() => resolveTargetDir(live), /not yet runnable: live/);

  // The workspace is a brief that lists the hosts, and its config says "live".
  const ws = prepareWorkspace(live, { modules: [] });
  try {
    assert.match(readFileSync(path.join(ws, "BRIEF.md"), "utf8"), /- app\.example\.com/);
    const cfg = JSON.parse(readFileSync(path.join(ws, ".touchstone.json"), "utf8"));
    assert.equal(cfg.kind, "live");
    assert.deepEqual(cfg.hosts, ["app.example.com"]);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("the allow-list is the covering grant's hosts, not every grant in the store", async () => {
  addGrant({ hosts: ["127.0.0.1"], kind: "operator-owned", ownership: true, allowPrivate: true });
  addGrant({ hosts: ["unrelated.example.com"], kind: "operator-owned", ownership: true });
  const handle = await openReach({ kind: "live", hosts: ["127.0.0.1"] });
  try {
    // Only the host this target's grant covers — the unrelated grant does not widen it.
    assert.deepEqual(handle.allowedHosts, ["127.0.0.1"]);
    const r = await fetch(handle.proxy.url, { headers: { "x-touchstone-url": "http://unrelated.example.com/x" } });
    assert.equal(r.status, 403);
  } finally {
    await handle.stop();
  }
});
