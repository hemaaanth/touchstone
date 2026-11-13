// A run uses only its own scope's grant (review finding 5).
//
// A live scope the operator saved is bound to the grant its permission tick
// wrote. A second grant that covers the same host does not let the scope run,
// does not widen the allow-list, and does not hand over its private-address
// opt-in.
//
// Throwaway stores and a throwaway console token: no real store is read. The
// "proxy" mode starts a proxy on 127.0.0.1 and sends nothing. No docker.
//
//   node --test spike/test/reach-binding.test.mjs
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "reach-binding-test-"));
process.env.TOUCHSTONE_SCOPES_FILE = path.join(dir, "scopes.json");
process.env.TOUCHSTONE_GRANTS_FILE = path.join(dir, "grants.json");
process.env.TOUCHSTONE_GRANT_TOKEN = "test-token-not-real";
beforeEach(() => {
  rmSync(process.env.TOUCHSTONE_SCOPES_FILE, { force: true });
  rmSync(process.env.TOUCHSTONE_GRANTS_FILE, { force: true });
});
after(() => rmSync(dir, { recursive: true, force: true }));

const { addLiveScope, removeScope } = await import("../lib/scopes-store.mjs");
const { addGrant, removeGrant, getGrant } = await import("../lib/grant-store.mjs");
const { enforceReach, openReach } = await import("../lib/reach.mjs");
const { pickTarget } = await import("../lib/targets.mjs");

const owned = { kind: "operator-owned", ownership: true };

test("overlap: a wider grant for the same host does not widen the run", async () => {
  const scope = addLiveScope({ hosts: ["app.example.com"], permission: true });
  // Added later, so it is first in the store: the old gate picked this one.
  const wide = addGrant({ hosts: ["app.example.com", "outside.example.net", "*.example.com", "127.0.0.1"], ...owned, allowPrivate: true });
  const gate = enforceReach(scope);
  assert.deepEqual(gate.grants.map((g) => g.id), [scope.permission.grantId]);
  assert.ok(!gate.grants.some((g) => g.id === wide.id));
  const handle = await openReach(scope);
  try {
    assert.deepEqual(handle.allowedHosts, ["app.example.com"]);
    assert.equal(handle.env.TOUCHSTONE_SCOPE_ALLOW, "app.example.com");
    // The proxy holds no host of the other grant, and no private opt-in.
    for (const bad of ["http://outside.example.net/x", "http://api.example.com/x", "http://127.0.0.1:9/x"]) {
      const r = await fetch(handle.proxy.url, { headers: { "x-touchstone-url": bad } });
      assert.equal(r.status, 403, bad);
    }
  } finally {
    await handle.stop();
  }
});

test("overlap: the allow-list is the scope's hosts even when its own grant names more", async () => {
  // A direct target with a host list uses any covering grant. The allow-list is
  // still the target's hosts, not every host of that grant.
  addGrant({ hosts: ["127.0.0.1", "also.example.com"], ...owned, allowPrivate: true });
  const handle = await openReach({ kind: "live", hosts: ["127.0.0.1"] });
  try {
    assert.deepEqual(handle.allowedHosts, ["127.0.0.1"]);
    const r = await fetch(handle.proxy.url, { headers: { "x-touchstone-url": "http://also.example.com/x" } });
    assert.equal(r.status, 403);
  } finally {
    await handle.stop();
  }
});

test("overlap: a private lab's opt-in is not lent to a public scope", () => {
  const scope = addLiveScope({ hosts: ["app.example.com"], permission: true });
  addGrant({ hosts: ["app.example.com"], ...owned, allowPrivate: true });
  assert.equal(enforceReach(scope).grants.some((g) => g.allowPrivate === true), false);
});

test("revocation: a removed own grant refuses a new run, though another grant covers the host", async () => {
  const scope = addLiveScope({ hosts: ["app.example.com"], permission: true });
  addGrant({ hosts: ["app.example.com"], ...owned });
  assert.equal(removeGrant(scope.permission.grantId), true);
  assert.throws(() => enforceReach(scope), /Refused: this scope's own grant does not cover app\.example\.com/);
  await assert.rejects(() => openReach(scope), /A grant of another scope does not count/);
  // The same host with no saved scope still passes: the other grant is real.
  assert.doesNotThrow(() => enforceReach({ kind: "live", hosts: ["app.example.com"] }));
});

test("revocation: an expired own grant refuses a new run, though another grant covers the host", () => {
  const scope = addLiveScope({ hosts: ["app.example.com"], permission: true });
  const other = addGrant({ hosts: ["app.example.com"], ...owned });
  assert.doesNotThrow(() => enforceReach(scope));
  // Expiry is read from the grant record. Expire the scope's own grant by clock.
  const own = getGrant(scope.permission.grantId);
  assert.equal(own.expiresAt ?? null, null, "the tick writes a grant with no expiry");
  removeGrant(own.id);
  const soon = Date.now() + 60_000;
  const short = addGrant({ hosts: ["app.example.com"], ...owned, expiresAt: soon });
  const rebound = { ...scope, permission: { ...scope.permission, grantId: short.id } };
  assert.doesNotThrow(() => enforceReach(rebound, { now: soon - 1 }));
  assert.throws(() => enforceReach(rebound, { now: soon + 1 }), /this scope's own grant does not cover app\.example\.com/);
  assert.equal(getGrant(other.id).id, other.id, "the other grant is still active and still does not count");
});

test("revocation: a removed scope's snapshot cannot run on another scope's grant", () => {
  const a = addLiveScope({ hosts: ["app.example.com"], permission: true });
  addLiveScope({ hosts: ["app.example.com", "api.example.com"], permission: true });
  removeScope(a.id);
  assert.throws(() => enforceReach(a), /app\.example\.com/);
});

test("a scope whose permission names no grant is refused, not matched to any grant", () => {
  addGrant({ hosts: ["app.example.com"], ...owned });
  const scope = { kind: "live", hosts: ["app.example.com"], permission: { confirmedAt: 1 } };
  assert.throws(() => enforceReach(scope), /this scope's own grant does not cover app\.example\.com/);
});

test("a host the scope's own grant does not name is refused, though another grant covers it", () => {
  const scope = addLiveScope({ hosts: ["app.example.com"], permission: true });
  addGrant({ hosts: ["extra.example.com"], ...owned });
  const widened = { ...scope, hosts: ["app.example.com", "extra.example.com"] };
  assert.throws(() => enforceReach(widened), /does not cover extra\.example\.com/);
});

test("the binding holds for the module a run picks", () => {
  const scope = addLiveScope({ hosts: ["app.example.com"], pack: ["web"], permission: true });
  addGrant({ hosts: ["app.example.com", "outside.example.net"], ...owned });
  for (const pack of ["web", "domains", "surface", "phishing"]) {
    const view = pickTarget({ id: scope.id, pack });
    assert.deepEqual(enforceReach(view).grants.map((g) => g.id), [scope.permission.grantId], pack);
  }
});

test("follow-up: the saved grant list keeps the binding", async () => {
  const scope = addLiveScope({ hosts: ["app.example.com"], permission: true });
  const grantIds = enforceReach(scope).grants.map((g) => g.id);
  assert.deepEqual(grantIds, [scope.permission.grantId]);
  const other = addGrant({ hosts: ["app.example.com", "outside.example.net"], ...owned });
  const handle = await openReach(scope, { grantIds });
  try {
    assert.deepEqual(handle.allowedHosts, ["app.example.com"]);
  } finally {
    await handle.stop();
  }
  // A saved list that names another scope's grant does not move the binding.
  assert.throws(() => enforceReach(scope, { grantIds: [other.id] }), /saved grant.*missing or expired/);
  assert.throws(() => enforceReach(scope, { grantIds: [] }), /saved grant.*missing or expired/);
  // After the own grant is gone, the follow-up is refused.
  removeGrant(scope.permission.grantId);
  assert.throws(() => enforceReach(scope, { grantIds }), /saved grant.*missing or expired/);
  await assert.rejects(() => openReach(scope, { grantIds: [...grantIds, other.id] }), /saved grant.*missing or expired/);
});
