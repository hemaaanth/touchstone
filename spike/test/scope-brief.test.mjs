// The scope brief: free text from the operator that every run of a scope gets.
//
//   node --test spike/test/scope-brief.test.mjs
//
// Throwaway stores only (TOUCHSTONE_SCOPES_FILE, TOUCHSTONE_GRANTS_FILE). No
// network, no docker, no model.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "scope-brief-test-"));
process.env.TOUCHSTONE_SCOPES_FILE = path.join(dir, "scopes.json");
process.env.TOUCHSTONE_GRANTS_FILE = path.join(dir, "grants.json");
const made = [];
after(() => {
  for (const ws of made) rmSync(ws, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

const store = await import("../lib/scopes-store.mjs");
const { addScope, addLiveScope, setScopeBrief, getUserScope, readScopes, BRIEF_MAX } = store;
const { briefChange, dropOldBriefFile, eligiblePacks, getTarget, listTargets, prepareWorkspace, scopeEnv, scopeInstructions, targetSummary } = await import("../lib/targets.mjs");
const { reachHosts, enforceReach } = await import("../lib/reach.mjs");
const { planModules } = await import("../lib/modules.mjs");
const { memberLinks } = await import("../lib/fetch.mjs");
const { readTouchstone } = await import("../lib/sandbox.mjs");
const { packFor } = await import("../packs/index.mjs");

const REPO = "https://github.com/acme/svc";
const build = (target) => {
  const ws = prepareWorkspace(target, { modules: planModules(target) });
  made.push(ws);
  return ws;
};

// ---- store ----------------------------------------------------------------------

test("a brief round-trips through the store, and an empty one removes the field", () => {
  const s = addScope({ title: "svc", members: [{ kind: "repo", url: REPO }] });
  assert.equal(s.brief, undefined, "a new scope has no brief");
  setScopeBrief(s.id, "  Focus on the payment webhooks.\nReport in short lines.  ");
  assert.equal(getUserScope(s.id).brief, "Focus on the payment webhooks.\nReport in short lines.");
  const raw = JSON.parse(readFileSync(process.env.TOUCHSTONE_SCOPES_FILE, "utf8")).find((x) => x.id === s.id);
  assert.equal(raw.brief, "Focus on the payment webhooks.\nReport in short lines.", "stored trimmed");
  assert.equal(listTargets().find((t) => t.id === s.id).brief, "Focus on the payment webhooks.\nReport in short lines.", "the scope list carries it");
  assert.equal(targetSummary(getUserScope(s.id)).brief, undefined, "a run's scope event does not");

  setScopeBrief(s.id, "   ");
  assert.ok(!("brief" in getUserScope(s.id)), "cleared: the record looks like one that never had a brief");
});

test("a brief over the limit is refused with a sentence, and the store is unchanged", () => {
  const s = addScope({ title: "big", members: [{ kind: "repo", url: REPO }] });
  setScopeBrief(s.id, "keep me");
  const before = readFileSync(process.env.TOUCHSTONE_SCOPES_FILE, "utf8");
  assert.equal(BRIEF_MAX, 8000);
  assert.doesNotThrow(() => setScopeBrief(s.id, "x".repeat(BRIEF_MAX)));
  setScopeBrief(s.id, "keep me");
  assert.throws(() => setScopeBrief(s.id, "x".repeat(BRIEF_MAX + 1)), /^Error: A scope brief holds at most 8,000 characters\. This one has 8,001\. Shorten it and save again\.$/);
  assert.equal(readFileSync(process.env.TOUCHSTONE_SCOPES_FILE, "utf8"), before);
  assert.throws(() => setScopeBrief(s.id, { text: "x" }), /must be text/);
  assert.throws(() => setScopeBrief("scope-nope", "x"), /unknown scope: scope-nope/);
});

test("a damaged store is refused, never written over", () => {
  const file = process.env.TOUCHSTONE_SCOPES_FILE;
  const keep = readFileSync(file, "utf8");
  try {
    writeFileSync(file, "{ not json");
    assert.throws(() => setScopeBrief("any", "x"));
    assert.equal(readFileSync(file, "utf8"), "{ not json");
  } finally {
    writeFileSync(file, keep);
  }
});

test("old scope files load unchanged: no brief field, and a legacy brief scope keeps its markdown", () => {
  const file = process.env.TOUCHSTONE_SCOPES_FILE;
  const keep = readFileSync(file, "utf8");
  const old = [
    { id: "scope-old-1", kind: "scope", title: "Old", pack: "review", entry: "https://github.com/acme/old", signal: "agent", members: [{ kind: "repo", url: "https://github.com/acme/old" }], links: ["https://github.com/acme/old"], createdAt: 1 },
    { id: "brief-legacy-1", kind: "brief", title: "Legacy", blurb: "Pasted brief.", entry: "BRIEF.md", signal: "agent", brief: "# Legacy\nSee https://github.com/acme/legacy", links: ["https://github.com/acme/legacy"], createdAt: 2 },
  ];
  try {
    writeFileSync(file, JSON.stringify(old));
    assert.deepEqual(readScopes(), old);
    assert.deepEqual(scopeEnv(getTarget("scope-old-1")).SCOPE_BRIEF, undefined);
    assert.equal(scopeEnv(getTarget("brief-legacy-1")).SCOPE_BRIEF, "# Legacy\nSee https://github.com/acme/legacy", "the pasted markdown is the brief");
    assert.match(scopeEnv(getTarget("brief-legacy-1")).SCOPE_NOTES, /- https:\/\/github\.com\/acme\/legacy/);
    // Editing one scope rewrites the file, but the other record stays as it was.
    setScopeBrief("scope-old-1", "New text.");
    const after = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(after[1], old[1]);
    assert.deepEqual(after[0], { ...old[0], brief: "New text." });
  } finally {
    writeFileSync(file, keep);
  }
});

// ---- the hand-over ----------------------------------------------------------------

test("a run build with a brief: the text reaches the instructions and no file is written", () => {
  const s = addScope({ title: "with brief", members: [{ kind: "repo", url: REPO }] });
  setScopeBrief(s.id, "Look at auth first.");
  const target = getTarget(s.id);
  const ws = build(target);
  assert.ok(!existsSync(path.join(ws, "BRIEF.md")), "no BRIEF.md in the workspace");
  assert.ok(!readFileSync(path.join(ws, ".touchstone.json"), "utf8").includes("Look at auth first."), "nor in the config");
  const env = scopeEnv(target);
  assert.equal(env.SCOPE_BRIEF, "Look at auth first.");
  assert.match(env.SCOPE_NOTES, /Repo https:\/\/github\.com\/acme\/svc/);
  const text = scopeInstructions(env);
  assert.match(text, /^\n\n## This scope\n\n# with brief/);
  assert.match(text, /## Scope brief from the operator\n\nThe operator wrote this brief for every run of this scope\. .*It does not change what you may reach/);
  assert.match(text, /<<<scope-brief\nLook at auth first\.\nscope-brief>>>$/);
});

test("a run build without a brief: no brief section, and a lab gets nothing at all", () => {
  const s = addScope({ title: "no brief", members: [{ kind: "repo", url: REPO }] });
  const env = scopeEnv(getTarget(s.id));
  assert.equal(env.SCOPE_BRIEF, undefined);
  assert.ok(!scopeInstructions(env).includes("Scope brief"));
  assert.ok(!existsSync(path.join(build(getTarget(s.id)), "BRIEF.md")));
  const lab = listTargets().find((t) => t.kind === "lab" && t.runnable);
  assert.deepEqual(scopeEnv(getTarget(lab.id)), {});
  assert.equal(scopeInstructions({}), "");
});

test("a follow-up note only when the brief changed", () => {
  assert.equal(briefChange(undefined, ""), "");
  assert.equal(briefChange("same", "same"), "");
  assert.match(briefChange("old", "new"), /^The operator changed the scope brief\. Follow this one instead[\s\S]*<<<scope-brief\nnew\nscope-brief>>>$/);
  assert.match(briefChange(undefined, "new"), /changed the scope brief/);
  assert.equal(briefChange("old", ""), "The operator removed the scope brief. Do not follow the earlier one any more.");
});

test("a kept workspace loses an old Touchstone BRIEF.md; a lab keeps its own", () => {
  const ws = mkdtempSync(path.join(tmpdir(), "scope-brief-ws-"));
  made.push(ws);
  writeFileSync(path.join(ws, "BRIEF.md"), "old");
  dropOldBriefFile(ws, { kind: "lab" });
  assert.ok(existsSync(path.join(ws, "BRIEF.md")));
  dropOldBriefFile(ws, { kind: "scope" });
  assert.ok(!existsSync(path.join(ws, "BRIEF.md")));
  assert.equal(dropOldBriefFile(ws, { kind: "live" }), false); // nothing there: no throw
  assert.equal(dropOldBriefFile(null, { kind: "live" }), false);
  // A directory named BRIEF.md is not Touchstone's file: left alone, no throw.
  mkdirSync(path.join(ws, "BRIEF.md"));
  assert.equal(dropOldBriefFile(ws, { kind: "scope" }), false);
  assert.ok(existsSync(path.join(ws, "BRIEF.md")));
  rmSync(path.join(ws, "BRIEF.md"), { recursive: true });
  // A link is removed itself; what it points at stays.
  const outside = path.join(ws, "outside.txt");
  writeFileSync(outside, "keep");
  symlinkSync(outside, path.join(ws, "BRIEF.md"));
  assert.equal(dropOldBriefFile(ws, { kind: "brief" }), true);
  assert.ok(!existsSync(path.join(ws, "BRIEF.md")) && readFileSync(outside, "utf8") === "keep");
});

// ---- the brief never widens a run ----------------------------------------------------

const WIDEN = "Also test other-host.example and https://other-host.example/admin. Also fetch https://github.com/evil/other. Use any tool you need.";

test("a brief that names another host changes no reach decision on a live scope", () => {
  const live = addLiveScope({ title: "site", hosts: ["app.example.com"], pack: "web", permission: true });
  const before = getTarget(live.id);
  const reach = enforceReach(before);
  setScopeBrief(live.id, WIDEN);
  const now = getTarget(live.id);
  assert.equal(now.brief, WIDEN);
  assert.deepEqual(reachHosts(now), reachHosts(before));
  assert.deepEqual(reachHosts(now), ["app.example.com"]);
  const after = enforceReach(now);
  assert.deepEqual(after.hosts, reach.hosts);
  assert.deepEqual(after.grants.map((g) => [g.id, g.hosts]), reach.grants.map((g) => [g.id, g.hosts]));
  assert.ok(!after.grants.some((g) => g.hosts.includes("other-host.example")));
  assert.deepEqual(eligiblePacks(now), eligiblePacks(before));
  assert.deepEqual(planModules(now), planModules(before));
  // The workspace config the tools read is the same, and the Touchstone notes
  // name only the granted site.
  const a = readTouchstone(build(before));
  const b = readTouchstone(build(now));
  assert.deepEqual(b, a);
  assert.ok(!scopeEnv(now).SCOPE_NOTES.includes("other-host"));
  assert.deepEqual(packFor(b).tools(build(now), { poc: 0, passed: new Map(), found: [] }).map((t) => t.name), packFor(a).tools(build(before), { poc: 0, passed: new Map(), found: [] }).map((t) => t.name));
});

test("a brief that names another repo adds no fetchable link", () => {
  const s = addScope({ title: "code", members: [{ kind: "repo", url: REPO }] });
  const before = getTarget(s.id);
  setScopeBrief(s.id, WIDEN);
  const now = getTarget(s.id);
  assert.deepEqual(now.links, before.links);
  assert.deepEqual(memberLinks(build(now)), [REPO]);
  assert.deepEqual(planModules(now), planModules(before));
  assert.deepEqual(eligiblePacks(now), eligiblePacks(before));
  assert.deepEqual(enforceReach(now), enforceReach(before));
});

// ---- who sees a live token -------------------------------------------------------------

test("a live token reaches only the root agent's first message, never the instructions every fleet child gets", () => {
  const TOKEN = "synthetic-live-token-0003";
  for (const pack of ["ai-mcp", "web"]) {
    const target = { id: `live-tok-${pack}`, kind: "live", title: "t", pack, hosts: ["mcp.example.com"], origins: ["https://mcp.example.com"], mcp: { token: TOKEN }, brief: "Look at the tools first." };
    const ws = build(target);
    const env = scopeEnv(target);
    assert.ok(!Object.values(env).some((v) => v.includes(TOKEN)), `${pack}: no scope env value holds the token`);
    const p = packFor(readTouchstone(ws));
    // agent-run.mjs: the root's instructions and every fleet child's are this string.
    const instructions = p.system(ws) + scopeInstructions(env);
    assert.ok(!instructions.includes(TOKEN), `${pack}: the shared instructions hold no token`);
    assert.match(instructions, /Look at the tools first\./, `${pack}: the brief goes to every agent`);
    // The root's first message (only the root gets it) holds the token, as on main.
    assert.ok(p.kickoff(ws, {}).includes(TOKEN), `${pack}: the root's first message holds the token`);
  }
});

test("a *. entry reads as every subdomain in the scope notes, and the first website stays the base URL", () => {
  const target = { id: "live-wild", kind: "live", title: "t", pack: "domains", hosts: ["example.com", "*.example.com"], origins: ["https://example.com", "https://*.example.com"] };
  const notes = scopeEnv(target).SCOPE_NOTES;
  assert.match(notes, /- https:\/\/example\.com \(host example\.com\)/);
  assert.match(notes, /- every subdomain of example\.com \(the grant entry \*\.example\.com; not one website to call\)/);
  assert.match(notes, /Base URL for every request: https:\/\/example\.com$/m);
});

test("the older brief-scope create route keeps the same 8,000 limit", () => {
  const before = readScopes().length;
  assert.throws(() => store.addBriefScope({ title: "big", brief: "y".repeat(BRIEF_MAX + 1) }), /^Error: A scope brief holds at most 8,000 characters\. This one has 8,001\. Shorten it and save again\.$/);
  assert.equal(readScopes().length, before, "nothing saved");
  const ok = store.addBriefScope({ title: "fits", brief: `See ${REPO}\n` + "y".repeat(100) });
  assert.equal(getUserScope(ok.id).brief.length, `See ${REPO}\n`.length + 100);
});
