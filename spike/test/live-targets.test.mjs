// What a live workspace looks like per pack, and which packs may take one.
//
// The website-facing packs each need a different shape of the same truth: the
// exact origin. Web and AI/MCP read `baseUrl`; AI/MCP also takes the caller's
// token; Domains and Surface capture a root domain over UDP DNS, so they get
// `domain` plus a reach block instead. No network, no Docker here.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "live-targets-test-"));
process.env.TOUCHSTONE_SCOPES_FILE = join(dir, "scopes.json");
process.env.TOUCHSTONE_GRANTS_FILE = join(dir, "grants.json");
// A test token, set before grant-store loads, so no real console token is read.
process.env.TOUCHSTONE_GRANT_TOKEN = "test-token-not-real";
const savedResolver = process.env.TOUCHSTONE_DNS_RESOLVER;
after(() => { rmSync(dir, { recursive: true, force: true }); if (savedResolver === undefined) delete process.env.TOUCHSTONE_DNS_RESOLVER; else process.env.TOUCHSTONE_DNS_RESOLVER = savedResolver; });

const { prepareWorkspace, listTargets, scopeEnv } = await import("../lib/targets.mjs");
const { addLiveScope } = await import("../lib/scopes-store.mjs");
const { allowsPrivate } = await import("../lib/reach.mjs");
const { PACKS } = await import("../packs/index.mjs");

const live = (host, pack) => ({
  id: `live-${pack}`, title: "t", kind: "live", pack,
  hosts: [host], origins: [`https://${host}`],
});
const workspaces = [];
before(() => {});
after(() => { for (const ws of workspaces) rmSync(ws, { recursive: true, force: true }); });
const build = (target) => { const ws = prepareWorkspace(target, { modules: [] }); workspaces.push(ws); return ws; };
const cfgOf = (ws) => JSON.parse(readFileSync(join(ws, ".touchstone.json"), "utf8"));

test("the web lane stores the base URL and nothing lab-shaped", () => {
  const ws = build(live("app.example.com", "web"));
  const cfg = cfgOf(ws);
  assert.equal(cfg.kind, "live");
  assert.equal(cfg.baseUrl, "https://app.example.com");
  // The agent learns the site from its instructions, not from a file.
  assert.ok(!existsSync(join(ws, "BRIEF.md")));
  assert.match(scopeEnv(live("app.example.com", "web")).SCOPE_NOTES, /Base URL for every request: https:\/\/app\.example\.com/);
  // bindLive fills these at prepass time; prepare alone must not invent them.
  assert.equal(cfg.live, undefined);
});

test("an AI/MCP target carries its token into the root's first message and the config, never the shared notes", () => {
  const target = { ...live("mcp.example.com", "ai-mcp"), mcp: { token: "tok_live_1" } };
  const ws = build(target);
  const cfg = cfgOf(ws);
  assert.equal(cfg.baseUrl, "https://mcp.example.com");
  assert.equal(cfg.mcp.token, "tok_live_1");
  assert.ok(!existsSync(join(ws, "BRIEF.md")));
  assert.ok(!scopeEnv(target).SCOPE_NOTES.includes("tok_live_1"), "every agent gets the notes, so no token there");
  assert.match(PACKS["ai-mcp"].kickoff(ws, {}), /Your only credential is this bearer token: tok_live_1/);
});

test("a domain capture gets the root domain and a governed reach block", () => {
  const ws = build(live("app.example.com", "domains"));
  const cfg = cfgOf(ws);
  assert.equal(cfg.domain, "app.example.com");
  assert.equal(cfg.reach.granted, true);
  assert.deepEqual(cfg.reach.scope, ["app.example.com"]);
  // The ports come from the origin the operator typed, never a default pair.
  assert.deepEqual(cfg.reach.ports, [{ scheme: "https", port: 443 }]);
});

test("an explicit port survives into the capture ports", () => {
  const target = { ...live("example.org", "surface"), origins: ["http://example.org:8080"] };
  const ws = build(target);
  assert.deepEqual(cfgOf(ws).reach.ports, [{ scheme: "http", port: 8080 }]);
});

// A live run sends its DNS questions for the granted domain to a resolver the
// platform names here. A public recursive resolver by default; an env override;
// a private override is refused unless the scope's own grant allows private space.
test("a live domain capture gets the default public resolver", () => {
  delete process.env.TOUCHSTONE_DNS_RESOLVER;
  assert.equal(cfgOf(build(live("app.example.com", "domains"))).reach.resolver, "1.1.1.1");
  assert.equal(cfgOf(build(live("app.example.com", "surface"))).reach.resolver, "1.1.1.1");
});

test("TOUCHSTONE_DNS_RESOLVER overrides the resolver when it is a public address", () => {
  process.env.TOUCHSTONE_DNS_RESOLVER = "9.9.9.9";
  assert.equal(cfgOf(build(live("app.example.com", "domains"))).reach.resolver, "9.9.9.9");
});

test("a private, loopback or bad resolver override is refused for a normal live target", () => {
  // n4: a bare IP only. URL-ish or port-suffixed forms are refused, not read as public.
  for (const bad of ["10.0.0.53", "127.0.0.1", "169.254.169.254", "not-an-ip", "1.1.1.1:53", "1.1.1.1#53", "https://1.1.1.1", "tls://1.1.1.1", "1.1.1", "010.0.0.1"]) {
    process.env.TOUCHSTONE_DNS_RESOLVER = bad;
    // No resolver reaches the config, so the DNS tools gap (live.mjs), not a private resolver.
    assert.equal("resolver" in cfgOf(build(live("app.example.com", "domains"))).reach, false, bad);
  }
});

test("a private resolver override is allowed when the scope's own grant allows private space", () => {
  const labScope = addLiveScope({ title: "lab", hosts: ["127.0.0.1"], permission: true, allowPrivate: true });
  assert.equal(allowsPrivate(labScope), true);
  process.env.TOUCHSTONE_DNS_RESOLVER = "10.0.0.53";
  assert.equal(cfgOf(build({ ...labScope, pack: "domains" })).reach.resolver, "10.0.0.53");
  // A loopback resolver too.
  process.env.TOUCHSTONE_DNS_RESOLVER = "127.0.0.1";
  assert.equal(cfgOf(build({ ...labScope, pack: "surface" })).reach.resolver, "127.0.0.1");
});

test("every website pack takes a live scope; a source-only pack is refused", () => {
  const scope = addLiveScope({ title: "site", hosts: ["https://app.example.com"], permission: true });
  // The scope row is offered (its stored module is web).
  assert.equal(listTargets().find((t) => t.id === scope.id)?.runnable, true);
  for (const pack of ["web", "ai-mcp", "domains", "surface"]) {
    const ws = build({ ...scope, pack });
    assert.equal(cfgOf(ws).kind, "live");
  }
  // A pack with no live lane is refused at workspace build.
  assert.throws(() => build({ ...scope, pack: "contracts" }), /cannot test a live website yet/);
});
