// Tests for the grant store: who may be reached live, and on whose say-so.
//
// Each test writes to a throwaway store via TOUCHSTONE_GRANTS_FILE, so the real
// spike/data/grants.json is never touched. No network, no docker.
//
//   node --test spike/test/grant-store.test.mjs
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "grant-store-test-"));
process.env.TOUCHSTONE_GRANTS_FILE = path.join(dir, "grants.json");
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => rmSync(process.env.TOUCHSTONE_GRANTS_FILE, { force: true }));

const store = await import("../lib/grant-store.mjs");
const {
  addGrant, getGrant, removeGrant, readGrants, normalizeHost, hostCovers,
  grantForHost, allowedHosts, requireGrant, activeGrants, GRANT_KINDS,
} = store;

test("an operator-owned grant round-trips and fills the allow-list", () => {
  const g = addGrant({ hosts: ["Example.com", "https://api.example.com/v1"], kind: "operator-owned", ownership: true, note: "my infra" });
  assert.match(g.id, /^grant-example-com-[0-9a-f]{8}$/);
  assert.equal(g.kind, "operator-owned");
  assert.equal(g.ownership, true);
  assert.equal(g.approvedBy, "operator");
  assert.deepEqual(g.hosts, ["example.com", "api.example.com"]); // normalized, scheme and path dropped
  assert.equal(typeof g.approvedAt, "number");
  assert.deepEqual(getGrant(g.id), g);
  assert.deepEqual(allowedHosts().sort(), ["api.example.com", "example.com"]);
});

test("an authorized grant needs who approved it; operator-owned needs ownership confirmed", () => {
  assert.throws(() => addGrant({ hosts: ["a.com"], kind: "authorized" }), /who authorized/i);
  assert.throws(() => addGrant({ hosts: ["a.com"], kind: "operator-owned" }), /confirm ownership/i);
  const g = addGrant({ hosts: ["a.com"], kind: "authorized", approvedBy: "Acme pentest 2026" });
  assert.equal(g.approvedBy, "Acme pentest 2026");
  assert.equal(g.ownership, false);
});

test("a grant needs at least one valid host and a known kind", () => {
  assert.throws(() => addGrant({ hosts: [], kind: "operator-owned", ownership: true }), /at least one valid host/i);
  assert.throws(() => addGrant({ hosts: ["not a host!!"], kind: "operator-owned", ownership: true }), /at least one valid host/i);
  assert.throws(() => addGrant({ hosts: ["a.com"], kind: "nonsense", ownership: true }), /kind is one of/i);
  assert.deepEqual(GRANT_KINDS, ["operator-owned", "authorized"]);
});

test("normalizeHost keeps only a usable hostname", () => {
  assert.equal(normalizeHost("HTTPS://User@Example.com:8443/path?q=1"), "example.com");
  assert.equal(normalizeHost("example.com."), "example.com");
  assert.equal(normalizeHost("10.0.0.5:22"), "10.0.0.5");
  assert.equal(normalizeHost("*.example.com"), "*.example.com");
  assert.equal(normalizeHost(""), null);
  assert.equal(normalizeHost("has space.com"), null);
  assert.equal(normalizeHost(undefined), null);
});

test("hostCovers does exact match, and a wildcard covers subdomains but not the base", () => {
  assert.equal(hostCovers("example.com", "example.com"), true);
  assert.equal(hostCovers("example.com", "api.example.com"), false);
  assert.equal(hostCovers("*.example.com", "api.example.com"), true);
  assert.equal(hostCovers("*.example.com", "a.b.example.com"), true);
  assert.equal(hostCovers("*.example.com", "example.com"), false);
  assert.equal(hostCovers("*.example.com", "notexample.com"), false);
});

test("grantForHost and allowedHosts read across active grants", () => {
  addGrant({ hosts: ["one.com"], kind: "operator-owned", ownership: true });
  addGrant({ hosts: ["*.two.com"], kind: "authorized", approvedBy: "me" });
  assert.equal(grantForHost("one.com")?.hosts[0], "one.com");
  assert.equal(grantForHost("api.two.com")?.hosts[0], "*.two.com");
  assert.equal(grantForHost("three.com"), null);
  assert.deepEqual(allowedHosts().sort(), ["*.two.com", "one.com"]);
});

test("an expired grant is inert: not active, not in the allow-list, not covering a host", () => {
  const past = Date.now() + 50; // expires very soon
  addGrant({ hosts: ["soon.com"], kind: "operator-owned", ownership: true, expiresAt: past });
  // Active now.
  assert.equal(grantForHost("soon.com", Date.now())?.hosts[0], "soon.com");
  // Inert after expiry (query with a later clock).
  const later = past + 10;
  assert.equal(grantForHost("soon.com", later), null);
  assert.deepEqual(allowedHosts(later), []);
  assert.deepEqual(activeGrants(later), []);
  // The record still exists; it is just not active.
  assert.equal(readGrants().length, 1);
});

test("expiresAt must be in the future", () => {
  assert.throws(() => addGrant({ hosts: ["a.com"], kind: "operator-owned", ownership: true, expiresAt: Date.now() - 1000 }), /future timestamp/i);
});

test("requireGrant returns the covering grants or throws naming the uncovered host", () => {
  addGrant({ hosts: ["ok.com", "*.ok.com"], kind: "operator-owned", ownership: true });
  const grants = requireGrant(["ok.com", "api.ok.com"]);
  assert.equal(grants.length, 1); // both hosts covered by the one grant
  assert.throws(() => requireGrant(["ok.com", "evil.com"]), /no active grant covers evil\.com/i);
  assert.throws(() => requireGrant([]), /no target host/i);
});

test("a grant refuses loopback, private, and unspecified hosts unless allowPrivate", () => {
  // SSRF guard (Finding 2): an operator can grant a public host freely, but a
  // host that points back into the run's own network needs an explicit opt-in.
  for (const h of ["127.0.0.1", "localhost", "10.0.0.5", "192.168.1.1", "169.254.169.254", "0.0.0.0", "[::1]"]) {
    assert.throws(() => addGrant({ hosts: [h], kind: "operator-owned", ownership: true }), /Refused/,
      `expected ${h} to be refused without allowPrivate`);
  }
  // With the opt-in, the same host is accepted and the flag is recorded.
  const g = addGrant({ hosts: ["127.0.0.1"], kind: "operator-owned", ownership: true, allowPrivate: true });
  assert.deepEqual(g.hosts, ["127.0.0.1"]);
  assert.equal(g.allowPrivate, true);
});

test("a wildcard grant needs at least two labels and rejects a public suffix", () => {
  // Over-broad wildcard guard (Finding 3): "*.com" or "*.co.uk" would cover an
  // entire registry, so a wildcard base must be a real registrable domain.
  for (const h of ["*.com", "*.co.uk", "*.github.io", "*.vercel.app"]) {
    assert.throws(() => addGrant({ hosts: [h], kind: "operator-owned", ownership: true }), /Refused/,
      `expected ${h} to be refused as too broad`);
  }
  // A proper registrable wildcard is fine.
  const g = addGrant({ hosts: ["*.example.com"], kind: "operator-owned", ownership: true });
  assert.deepEqual(g.hosts, ["*.example.com"]);
});

test("removeGrant removes one and reports whether it existed", () => {
  const g = addGrant({ hosts: ["x.com"], kind: "operator-owned", ownership: true });
  assert.equal(removeGrant(g.id), true);
  assert.equal(getGrant(g.id), null);
  assert.equal(removeGrant(g.id), false);
});
