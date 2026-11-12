// What a live workspace looks like per pack, and which packs may take one.
//
// The website-facing packs each need a different shape of the same truth: the
// exact origin. Web and AI/MCP read `baseUrl`; AI/MCP also takes the caller's
// token; Domains and Surface capture a root domain over UDP DNS, so they get
// `domain` plus a reach block instead. No network, no Docker here.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "live-targets-test-"));
process.env.TOUCHSTONE_SCOPES_FILE = join(dir, "scopes.json");
process.env.TOUCHSTONE_GRANTS_FILE = join(dir, "grants.json");
after(() => rmSync(dir, { recursive: true, force: true }));

const { prepareWorkspace, listTargets } = await import("../lib/targets.mjs");
const { addLiveScope } = await import("../lib/scopes-store.mjs");

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
  assert.match(readFileSync(join(ws, "BRIEF.md"), "utf8"), /https:\/\/app\.example\.com/);
  // bindLive fills these at prepass time; prepare alone must not invent them.
  assert.equal(cfg.live, undefined);
});

test("an AI/MCP target carries its token into the brief and the config", () => {
  const target = { ...live("mcp.example.com", "ai-mcp"), mcp: { token: "tok_live_1" } };
  const ws = build(target);
  const cfg = cfgOf(ws);
  assert.equal(cfg.baseUrl, "https://mcp.example.com");
  assert.equal(cfg.mcp.token, "tok_live_1");
  assert.match(readFileSync(join(ws, "BRIEF.md"), "utf8"), /Bearer token: tok_live_1/);
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
