// Live scopes: real websites the operator adds with one permission checkbox.
// The tick becomes a grant linked to the scope, so the reach gate lets a run
// reach exactly those hosts. Removing the scope removes the grant.
//
// Throwaway stores via TOUCHSTONE_SCOPES_FILE and TOUCHSTONE_GRANTS_FILE.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "live-scope-test-"));
process.env.TOUCHSTONE_SCOPES_FILE = path.join(dir, "scopes.json");
process.env.TOUCHSTONE_GRANTS_FILE = path.join(dir, "grants.json");
beforeEach(() => {
  rmSync(process.env.TOUCHSTONE_SCOPES_FILE, { force: true });
  rmSync(process.env.TOUCHSTONE_GRANTS_FILE, { force: true });
});
after(() => rmSync(dir, { recursive: true, force: true }));

const { addLiveScope, removeScope, readScopes } = await import("../lib/scopes-store.mjs");
const { readGrants } = await import("../lib/grant-store.mjs");
const { enforceReach } = await import("../lib/reach.mjs");
const { listTargets, pickTarget } = await import("../lib/targets.mjs");

test("no tick, no scope and no grant", () => {
  assert.throws(() => addLiveScope({ hosts: ["app.example.com"] }), /permission/);
  assert.throws(() => addLiveScope({ hosts: ["app.example.com"], permission: "yes" }), /permission/);
  assert.equal(readScopes().length, 0);
  assert.equal(readGrants().length, 0);
});

test("the tick records a grant that covers exactly the scope's hosts", () => {
  const scope = addLiveScope({ hosts: ["https://App.Example.com/login", "api.example.com"], permission: true });
  assert.equal(scope.kind, "live");
  assert.equal(scope.pack, "web");
  assert.deepEqual(scope.hosts, ["app.example.com", "api.example.com"]);
  const [grant] = readGrants();
  assert.equal(grant.scopeId, scope.id);
  assert.deepEqual(grant.hosts, scope.hosts);
  // The reach gate now passes for this scope.
  assert.deepEqual(enforceReach(scope).hosts, scope.hosts);
  // And refuses a host the tick did not cover.
  assert.throws(() => enforceReach({ kind: "live", hosts: ["other.example.org"] }), /other\.example\.org/);
});

test("a live scope is offered and can be picked for a run", () => {
  const scope = addLiveScope({ title: "My app", hosts: ["app.example.com"], permission: true });
  const row = listTargets().find((t) => t.id === scope.id);
  assert.equal(row.runnable, true);
  assert.deepEqual(row.hosts, ["app.example.com"]);
  assert.equal(pickTarget({ id: scope.id }).id, scope.id);
});

test("bad hosts are refused before anything is saved", () => {
  assert.throws(() => addLiveScope({ hosts: ["127.0.0.1"], permission: true }), /Refused/);
  assert.throws(() => addLiveScope({ hosts: ["*.com"], permission: true }), /Refused/);
  assert.throws(() => addLiveScope({ hosts: [], permission: true }), /at least one/);
  assert.equal(readScopes().length, 0);
  assert.equal(readGrants().length, 0);
});

test("removing the scope removes its grant, and only its grant", () => {
  const a = addLiveScope({ hosts: ["a.example.com"], permission: true });
  const b = addLiveScope({ hosts: ["b.example.com"], permission: true });
  assert.equal(removeScope(a.id), true);
  assert.deepEqual(readGrants().map((g) => g.scopeId), [b.id]);
  assert.throws(() => enforceReach(a), /a\.example\.com/);
});

test("a bad name or module is refused before the grant is written", () => {
  assert.throws(() => addLiveScope({ title: "x".repeat(121), hosts: ["a.example.com"], permission: true }), /1 to 120/);
  assert.throws(() => addLiveScope({ hosts: ["a.example.com"], pack: "../evil", permission: true }), /unknown module/);
  assert.equal(readScopes().length, 0);
  assert.equal(readGrants().length, 0);
});

test("if the scope cannot be saved, its grant is rolled back", () => {
  // A directory where the scopes file should be makes the write fail.
  const real = process.env.TOUCHSTONE_SCOPES_FILE;
  const blocked = mkdtempSync(path.join(dir, "blocked-"));
  process.env.TOUCHSTONE_SCOPES_FILE = blocked;
  try {
    assert.throws(() => addLiveScope({ hosts: ["a.example.com"], permission: true }));
    assert.equal(readGrants().length, 0);
  } finally {
    process.env.TOUCHSTONE_SCOPES_FILE = real;
  }
});
