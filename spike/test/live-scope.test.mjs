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
const { readGrants, normalizeHost, hostCovers, ipKind } = await import("../lib/grant-store.mjs");
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
  // The exact origins survive: scheme, host and port are what the run aims at.
  assert.deepEqual(scope.origins, ["https://app.example.com", "https://api.example.com"]);
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

test("the origin keeps an explicit scheme and port", () => {
  const scope = addLiveScope({ hosts: ["http://example.com:8080/login", "example.org"], permission: true });
  assert.deepEqual(scope.hosts, ["example.com", "example.org"]);
  assert.deepEqual(scope.origins, ["http://example.com:8080", "https://example.org"]);
});

test("bad hosts are refused before anything is saved", () => {
  assert.throws(() => addLiveScope({ hosts: ["127.0.0.1"], permission: true }), /Refused/);
  assert.throws(() => addLiveScope({ hosts: ["*.com"], permission: true }), /Refused/);
  assert.throws(() => addLiveScope({ hosts: [], permission: true }), /at least one/);
  assert.equal(readScopes().length, 0);
  assert.equal(readGrants().length, 0);
});

test("a loopback or private host is refused by default", () => {
  for (const h of ["127.0.0.1", "localhost", "http://localhost:3000", "10.0.0.5", "192.168.1.20", "[::1]"]) {
    assert.throws(() => addLiveScope({ hosts: [h], permission: true }), /Refused/, h);
  }
  // Only the exact value true opts in. A string or 1 does not.
  for (const v of ["yes", "true", 1, {}]) {
    assert.throws(() => addLiveScope({ hosts: ["127.0.0.1"], permission: true, allowPrivate: v }), /Refused/, String(v));
  }
  assert.equal(readScopes().length, 0);
  assert.equal(readGrants().length, 0);
});

test("the explicit opt-in allows a loopback or private lab", () => {
  const scope = addLiveScope({
    title: "Local lab",
    hosts: ["http://127.0.0.1:8080", "localhost", "10.0.0.5", "192.168.1.20"],
    permission: true,
    allowPrivate: true,
  });
  assert.deepEqual(scope.hosts, ["127.0.0.1", "localhost", "10.0.0.5", "192.168.1.20"]);
  assert.deepEqual(scope.origins.slice(0, 2), ["http://127.0.0.1:8080", "https://localhost"]);
  assert.equal(scope.permission.allowPrivate, true);
  const [grant] = readGrants();
  assert.equal(grant.scopeId, scope.id);
  assert.equal(grant.allowPrivate, true);
  // The reach gate passes, and the covering grant carries the opt-in.
  const gate = enforceReach(scope);
  assert.deepEqual(gate.hosts, scope.hosts);
  assert.equal(gate.grants.every((g) => g.allowPrivate === true), true);
});

test("the opt-in never covers a public host, a DNS name, a wildcard or metadata", () => {
  const refused = [
    "app.example.com", // a public name could be rebound to a private address
    "8.8.8.8", // a public address
    "lab.internal", // a DNS name, even one that looks private
    "*.example.com",
    "169.254.169.254", // cloud metadata
    "100.100.100.200", // cloud metadata outside 169.254/16
    "0.0.0.0",
    "[fe80::1]",
  ];
  for (const h of refused) {
    assert.throws(() => addLiveScope({ hosts: ["127.0.0.1", h], permission: true, allowPrivate: true }), /Refused/, h);
  }
  assert.equal(readScopes().length, 0);
  assert.equal(readGrants().length, 0);
});

// Regression tests for the opt-in review. The rule: turn the host into a
// parsed IP address (or the exact name "localhost") first, then decide on that
// parsed address. Never decide on the string the operator typed.

test("the opt-in refuses every DNS name except the exact name localhost", () => {
  for (const h of ["localhost.localdomain", "lab.localdomain", "foo.localhost", "localhost.", "http://localhost.:3000/", "fd00", "http://fd00:8080/"]) {
    assert.throws(() => addLiveScope({ hosts: [h], permission: true, allowPrivate: true }), /Refused/, h);
  }
  assert.equal(readScopes().length, 0);
  assert.equal(readGrants().length, 0);
});

test("an IPv6 lab keeps its IPv6 identity and never turns into a DNS name", () => {
  const scope = addLiveScope({ hosts: ["[fd00::1]", "http://[fd00:0:0:0:0:0:0:2]:8080/"], permission: true, allowPrivate: true });
  assert.deepEqual(scope.hosts, ["fd00::1", "fd00::2"]);
  assert.deepEqual(readGrants()[0].hosts, ["fd00::1", "fd00::2"]);
  // The stored host parses back to itself, so a second pass is the same.
  for (const h of scope.hosts) {
    assert.equal(normalizeHost(h), h);
    assert.equal(normalizeHost(`[${h}]`), h);
    assert.equal(ipKind(h), "private");
  }
  // The grant covers the IPv6 address, not the DNS name "fd00".
  assert.equal(hostCovers("fd00::1", "fd00"), false);
  assert.equal(hostCovers("fd00::1", "fd00::1"), true);
  assert.doesNotThrow(() => enforceReach({ kind: "live", hosts: ["[fd00::1]"] }));
  assert.throws(() => enforceReach({ kind: "live", hosts: ["fd00"] }), /fd00/);
  assert.throws(() => enforceReach({ kind: "live", hosts: ["http://fd00/"] }), /fd00/);
});

test("every spelling of an IPv6 metadata address is refused, with or without the opt-in", () => {
  const spellings = [
    "[fd00:ec2::254]",
    "[fd00:ec2::0254]",
    "[fd00:0ec2:0:0:0:0:0:254]",
    "[FD00:EC2:0000:0000:0000:0000:0000:0254]",
    "[::ffff:169.254.169.254]", // IPv4-mapped
    "[::ffff:a9fe:a9fe]",
    "[64:ff9b::a9fe:a9fe]", // NAT64
    "[::ffff:100.100.100.200]",
  ];
  for (const h of spellings) {
    assert.equal(ipKind(h), "metadata", h);
    assert.throws(() => addLiveScope({ hosts: [h], permission: true, allowPrivate: true }), /Refused/, h);
    assert.throws(() => addLiveScope({ hosts: [h], permission: true }), /Refused/, h);
  }
  assert.equal(readGrants().length, 0);
});

test("encoded IPv4 forms are read as the address they name", () => {
  const loopback = ["2130706433", "0177.0.0.1", "0x7f000001", "0x7f.1", "127.1", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]"];
  for (const h of loopback) {
    assert.equal(ipKind(h), "loopback", h);
    // The default refuses each one: none of them passes as a public name.
    assert.throws(() => addLiveScope({ hosts: [h], permission: true }), /Refused/, h);
  }
  // A decimal or hex form of the metadata address is metadata.
  for (const h of ["2852039166", "0xa9fea9fe", "0251.0376.0251.0376"]) {
    assert.equal(ipKind(h), "metadata", h);
    assert.throws(() => addLiveScope({ hosts: [h], permission: true, allowPrivate: true }), /Refused/, h);
  }
  assert.equal(readGrants().length, 0);
  // Under the opt-in, the IPv4 forms are stored as the dotted address.
  const scope = addLiveScope({ hosts: ["2130706433", "0177.0.0.1", "0x7f000001"], permission: true, allowPrivate: true });
  assert.deepEqual(scope.hosts, ["127.0.0.1"]);
  assert.deepEqual(readGrants()[0].hosts, ["127.0.0.1"]);
});

test("[::1] is refused by default and works as a lab under the opt-in", () => {
  for (const h of ["[::1]", "[0:0:0:0:0:0:0:1]", "http://[::1]:8080", "[::1]:8080"]) {
    assert.throws(() => addLiveScope({ hosts: [h], permission: true }), /Refused/, h);
  }
  assert.equal(readGrants().length, 0);
  const scope = addLiveScope({ hosts: ["http://[::1]:8080", "[0:0:0:0:0:0:0:1]"], permission: true, allowPrivate: true });
  assert.deepEqual(scope.hosts, ["::1"]);
  assert.deepEqual(scope.origins, ["http://[::1]:8080", "https://[::1]"]);
  const [grant] = readGrants();
  assert.deepEqual(grant.hosts, ["::1"]);
  assert.equal(grant.allowPrivate, true);
  for (const h of ["[::1]", "::1", "http://[::1]:8080/"]) {
    const gate = enforceReach({ kind: "live", hosts: [h] });
    assert.equal(gate.grants.every((g) => g.allowPrivate === true), true, h);
  }
});

test("a public scope and a private lab scope keep separate grants", () => {
  const pub = addLiveScope({ title: "Public app", hosts: ["app.example.com"], permission: true });
  const lab = addLiveScope({ title: "Lab", hosts: ["127.0.0.1", "[fd00::1]"], permission: true, allowPrivate: true });
  const grants = readGrants();
  assert.equal(grants.length, 2);
  const pubGrant = grants.find((g) => g.scopeId === pub.id);
  const labGrant = grants.find((g) => g.scopeId === lab.id);
  assert.equal(pubGrant.allowPrivate, false);
  assert.deepEqual(pubGrant.hosts, ["app.example.com"]);
  assert.equal(labGrant.allowPrivate, true);
  assert.deepEqual(labGrant.hosts, ["127.0.0.1", "fd00::1"]);
  // The public scope is never covered by the lab's opt-in.
  const pubGate = enforceReach(pub);
  assert.equal(pubGate.grants.some((g) => g.allowPrivate), false);
  assert.equal(enforceReach(lab).grants.every((g) => g.allowPrivate === true), true);
  // Removing the lab leaves the public grant as it was.
  removeScope(lab.id);
  assert.deepEqual(readGrants().map((g) => [g.scopeId, g.allowPrivate]), [[pub.id, false]]);
});

test("a public scope's grant never opts in, and the opt-in still needs the tick", () => {
  addLiveScope({ hosts: ["app.example.com"], permission: true });
  assert.equal(readGrants()[0].allowPrivate, false);
  assert.equal(enforceReach({ kind: "live", hosts: ["app.example.com"] }).grants.some((g) => g.allowPrivate), false);
  assert.throws(() => addLiveScope({ hosts: ["127.0.0.1"], allowPrivate: true }), /permission/);
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

test("a live scope is never picked at random, only by id", () => {
  addLiveScope({ hosts: ["a.example.com"], pack: "review", permission: true });
  assert.throws(() => pickTarget({ pack: "review" }), /no runnable targets/);
});
