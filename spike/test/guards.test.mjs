// Guard tests for the brief-scope increment.
//
// The brief kind added three security-sensitive pure functions: the link
// extractor that decides what a run will fetch, the SSRF address guard that
// decides what it may reach, and the module planner that decides which halves
// of the pipeline a scope can honestly run. These have no side effects, so we
// test them directly with node --test — no docker, no network, no inference.
//
//   node --test spike/test/guards.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import { extractLinks, slugify } from "../lib/scopes-store.mjs";
import { _internal } from "../lib/fetch.mjs";
import { planModules, moduleOn, modulesEvent } from "../lib/modules.mjs";

const { isBlockedAddress, parseGithub } = _internal;

// --- extractLinks: what a run will fetch -------------------------------------

test("extractLinks pulls markdown link targets and bare https, in order, deduped", () => {
  const md = [
    "See the [vault](https://github.com/acme/vault) contract",
    "and https://github.com/acme/vault/blob/main/src/Vault.sol directly.",
    "Dup: https://github.com/acme/vault should not repeat.",
  ].join("\n");
  assert.deepEqual(extractLinks(md), [
    "https://github.com/acme/vault",
    "https://github.com/acme/vault/blob/main/src/Vault.sol",
  ]);
});

test("extractLinks drops non-TLS http — fetch refuses it anyway", () => {
  assert.deepEqual(extractLinks("insecure http://evil.example/x and https://ok.example/y"), [
    "https://ok.example/y",
  ]);
});

test("extractLinks trims trailing punctuation off a bare URL", () => {
  assert.deepEqual(extractLinks("ref (https://ok.example/a), and https://ok.example/b."), [
    "https://ok.example/a",
    "https://ok.example/b",
  ]);
});

test("extractLinks on empty or missing input is an empty list", () => {
  assert.deepEqual(extractLinks(""), []);
  assert.deepEqual(extractLinks(null), []);
  assert.deepEqual(extractLinks(undefined), []);
});

// --- slugify: the id-safe title ----------------------------------------------

test("slugify lowercases, dashes runs of non-alnum, and trims edge dashes", () => {
  assert.equal(slugify("  Acme Vault: Re-entrancy!  "), "acme-vault-re-entrancy");
});

test("slugify caps at 32 chars and never returns empty", () => {
  assert.ok(slugify("x".repeat(80)).length <= 32);
  assert.equal(slugify("!!!"), "brief");
  assert.equal(slugify(""), "brief");
});

// --- isBlockedAddress: the SSRF guard ----------------------------------------

test("isBlockedAddress blocks the private, loopback, link-local and reserved v4 ranges", () => {
  for (const addr of [
    "0.0.0.0", "10.0.0.1", "127.0.0.1", "169.254.1.1",
    "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "100.64.0.1", "100.127.0.1", "224.0.0.1", "255.255.255.255",
  ]) {
    assert.equal(isBlockedAddress(addr), true, `${addr} must be blocked`);
  }
});

test("isBlockedAddress allows ordinary public v4", () => {
  for (const addr of ["8.8.8.8", "1.1.1.1", "140.82.112.3", "172.15.0.1", "172.32.0.1"]) {
    assert.equal(isBlockedAddress(addr), false, `${addr} must be allowed`);
  }
});

test("isBlockedAddress blocks loopback, link-local and unique-local v6", () => {
  for (const addr of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1"]) {
    assert.equal(isBlockedAddress(addr), true, `${addr} must be blocked`);
  }
});

test("isBlockedAddress re-checks the embedded v4 of an IPv4-mapped v6", () => {
  assert.equal(isBlockedAddress("::ffff:127.0.0.1"), true);
  assert.equal(isBlockedAddress("::ffff:8.8.8.8"), false);
});

test("isBlockedAddress treats a non-IP literal as blocked (hostnames go through DNS instead)", () => {
  // A hostname is not an IP literal; the guard refuses to vouch for it here, so
  // the caller must resolve it and check every answer. Conservative by design.
  assert.equal(isBlockedAddress("github.com"), true);
  assert.equal(isBlockedAddress("not-an-ip"), true);
});

// --- parseGithub: the URL shapes we support ----------------------------------

const gh = (p) => parseGithub(new URL(`https://github.com${p}`));

test("parseGithub recognizes a bare repo, a tree ref, and a blob file", () => {
  assert.deepEqual(gh("/acme/vault"), { kind: "repo", owner: "acme", repo: "vault", ref: null });
  assert.deepEqual(gh("/acme/vault/tree/v1.2.0"), { kind: "repo", owner: "acme", repo: "vault", ref: "v1.2.0" });
  assert.deepEqual(gh("/acme/vault/blob/main/src/Vault.sol"), {
    kind: "blob", owner: "acme", repo: "vault", ref: "main", filePath: "src/Vault.sol",
  });
});

test("parseGithub strips a trailing .git from the repo", () => {
  assert.deepEqual(gh("/acme/vault.git"), { kind: "repo", owner: "acme", repo: "vault", ref: null });
});

test("parseGithub returns null for a non-github host or an unrecognized path", () => {
  assert.equal(parseGithub(new URL("https://gitlab.com/acme/vault")), null);
  assert.equal(gh("/acme"), null); // too short
  assert.equal(gh("/acme/vault/pulls"), null); // not tree/blob
});

// --- planModules: what a scope can honestly run ------------------------------

test("a lab scope can run static and fuzz, with agent and replay fixed on", () => {
  const plan = planModules({ kind: "lab" });
  const byId = Object.fromEntries(plan.map((m) => [m.id, m]));
  assert.equal(byId.agent.on, true);
  assert.equal(byId.agent.fixed, true);
  assert.equal(byId.replay.on, true);
  assert.equal(byId.replay.fixed, true);
  assert.equal(byId.static.on, true);
  assert.equal(byId.static.available, true);
  assert.equal(byId.fuzz.on, true);
  assert.ok(!byId.fetch, "a lab has no fetch module");
});

test("a brief turns static and fuzz off with a reason and adds a fetch module", () => {
  const plan = planModules({ kind: "brief" });
  const byId = Object.fromEntries(plan.map((m) => [m.id, m]));
  assert.equal(byId.static.on, false);
  assert.equal(byId.static.available, false);
  assert.ok(byId.static.reason, "an off module must say why");
  assert.equal(byId.fuzz.on, false);
  assert.equal(byId.fuzz.available, false);
  assert.equal(byId.fetch.on, true);
  assert.equal(byId.fetch.available, true);
  // The gate is never dropped, even when the scanners are off.
  assert.equal(byId.replay.on, true);
});

test("planModules honors the requested set for toggleable modules only", () => {
  const plan = planModules({ kind: "lab" }, ["static"]);
  assert.equal(moduleOn(plan, "static"), true);
  assert.equal(moduleOn(plan, "fuzz"), false); // not requested
  assert.equal(moduleOn(plan, "agent"), true); // fixed, ignores the request
  assert.equal(moduleOn(plan, "replay"), true); // fixed, ignores the request
});

test("a brief cannot be forced to run static even if requested", () => {
  const plan = planModules({ kind: "brief" }, ["static", "fuzz"]);
  assert.equal(moduleOn(plan, "static"), false);
  assert.equal(moduleOn(plan, "fuzz"), false);
});

test("moduleOn is false for an absent id or a non-array", () => {
  assert.equal(moduleOn(planModules({ kind: "lab" }), "nope"), false);
  assert.equal(moduleOn(null, "static"), false);
});

// --- modulesEvent: the stream shape ------------------------------------------

test("modulesEvent emits a normalized id/on/available/fixed/reason per module", () => {
  const ev = modulesEvent(planModules({ kind: "brief" }));
  assert.equal(ev.ev, "modules");
  assert.equal(typeof ev.t, "number");
  for (const m of ev.modules) {
    assert.deepEqual(Object.keys(m).sort(), ["available", "fixed", "id", "on", "reason"]);
    assert.equal(typeof m.on, "boolean");
    assert.equal(typeof m.available, "boolean");
    assert.equal(typeof m.fixed, "boolean");
  }
  const fetchMod = ev.modules.find((m) => m.id === "fetch");
  assert.equal(fetchMod.on, true);
});
