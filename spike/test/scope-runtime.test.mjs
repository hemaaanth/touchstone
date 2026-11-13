// Runtime tests for operator scopes: the workspace each pack gets, the module
// plan, and the Review pack's read-only proof gate.
//
//   node --test spike/test/scope-runtime.test.mjs
import "./helpers/isolated-env.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "scope-runtime-test-"));
process.env.TOUCHSTONE_SCOPES_FILE = path.join(dir, "scopes.json");
const cleanup = [dir];
after(() => { for (const d of cleanup) rmSync(d, { recursive: true, force: true }); });

const { addScope } = await import("../lib/scopes-store.mjs");
const { prepareWorkspace, targetSummary, pickTarget, listTargets, scopeEnv } = await import("../lib/targets.mjs");
const { planModules, moduleOn } = await import("../lib/modules.mjs");
const { readTouchstone } = await import("../lib/sandbox.mjs");
const { PACKS, packFor } = await import("../packs/index.mjs");
const review = await import("../packs/review/pack.mjs");
const { pruneClone } = await import("../lib/fetch.mjs");

const folder = (name, files) => ({ kind: "folder", name, files: files.map(([p, c]) => ({ path: p, content: c })) });

test("a non-Solidity scope runs under Review: no Foundry, replay off, no way to prove", async () => {
  const s = addScope({ title: "svc", members: [folder("api", [["main.go", "package main\n"]]), folder("web", [["app.ts", "export {}\n"]]), { kind: "repo", url: "https://github.com/acme/svc" }] });
  assert.equal(s.pack, "review");
  const plan = planModules(s);
  assert.deepEqual(plan.map((m) => [m.id, m.on]), [["agent", true], ["fetch", true], ["replay", false]]);
  assert.equal(plan.find((m) => m.id === "replay").available, false);
  const ws = prepareWorkspace(s, { modules: plan });
  cleanup.push(ws);
  assert.equal(readFileSync(path.join(ws, "src/api/main.go"), "utf8"), "package main\n");
  assert.ok(existsSync(path.join(ws, "src/web/app.ts")));
  assert.ok(!existsSync(path.join(ws, "foundry.toml")));
  assert.ok(!existsSync(path.join(ws, "BRIEF.md")), "the scope text is not a workspace file");
  assert.match(scopeEnv(s).SCOPE_NOTES, /github\.com\/acme\/svc/);
  const cfg = readTouchstone(ws);
  assert.equal(cfg.pack, "review");
  const pack = packFor(cfg);
  const names = pack.tools(ws, {}).map((t) => t.name);
  assert.deepEqual(names, ["list_sources", "read_source", "search_source", "record_lead", "fetch_source"]);
  assert.ok(!names.includes("submit_finding") && !names.includes("run_poc"));
  // Even a forged finding list proves nothing.
  assert.deepEqual(await pack.prove(ws, [{ title: "x", severity: "critical", poc: "X" }], [], () => {}), []);
  const sum = targetSummary(s);
  assert.equal(sum.proofSurface.kind, "none");
  assert.deepEqual(sum.members.map((m) => m.proof), ["none", "none", "none"]);
  assert.ok(!JSON.stringify(sum).includes("package main")); // no content in the summary
});

test("a Solidity scope runs under Contracts with Foundry, and only Solidity is marked provable", () => {
  const s = addScope({ title: "vault", members: [folder("c", [["src/V.sol", "contract V {}\n"]]), folder("bot", [["bot.py", "x=1\n"]])] });
  assert.equal(s.pack, "contracts");
  const plan = planModules(s);
  assert.ok(moduleOn(plan, "static") && moduleOn(plan, "replay"));
  const ws = prepareWorkspace(s, { modules: plan });
  cleanup.push(ws);
  assert.ok(existsSync(path.join(ws, "foundry.toml")));
  assert.ok(existsSync(path.join(ws, "src/c/src/V.sol")));
  assert.equal(readTouchstone(ws).kind, "local-source");
  assert.deepEqual(targetSummary(s).members.map((m) => m.proof), ["forge", "none"]);
});

test("random pick for a pack with no labs uses the operator's scopes", () => {
  const t = pickTarget({ pack: "review" });
  assert.equal(t.pack, "review");
  assert.ok(listTargets().some((x) => x.kind === "scope" && x.runnable));
  assert.ok(PACKS.review);
});

test("a hand-edited store cannot write outside the workspace", () => {
  const bad = { id: "scope-bad", kind: "scope", title: "bad", pack: "review", links: [], members: [{ kind: "folder", name: "a", files: [{ path: "../../escape.txt", content: "x" }] }] };
  assert.throws(() => prepareWorkspace(bad, { modules: [] }), /unsafe scope file path/);
  assert.throws(() => prepareWorkspace({ ...bad, pack: "web" }, { modules: [] }), /cannot run under pack/);
});

test("Review reads only allowlisted files inside the workspace; symlinks and secrets are refused", () => {
  const ws = mkdtempSync(path.join(tmpdir(), "review-read-"));
  cleanup.push(ws);
  const outside = mkdtempSync(path.join(tmpdir(), "review-outside-"));
  cleanup.push(outside);
  writeFileSync(path.join(outside, "host.ts"), "host secret");
  mkdirSync(path.join(ws, "src"), { recursive: true });
  mkdirSync(path.join(ws, "vendor/repo/.git"), { recursive: true });
  writeFileSync(path.join(ws, "src/ok.rs"), "fn main() {}\n");
  writeFileSync(path.join(ws, "src/id_rsa"), "key");
  writeFileSync(path.join(ws, "src/logo.png"), "png");
  writeFileSync(path.join(ws, "vendor/repo/lib.go"), "package x\n");
  writeFileSync(path.join(ws, "vendor/repo/.git/config"), "x");
  writeFileSync(path.join(ws, "BRIEF.md"), "# b\n");
  writeFileSync(path.join(ws, ".touchstone.json"), "{}");
  symlinkSync(path.join(outside, "host.ts"), path.join(ws, "src/link.ts"));
  assert.deepEqual(review.listFiles(ws), ["src/ok.rs", "vendor/repo/lib.go"]);
  assert.ok(review.resolveReadable(ws, "src/ok.rs"));
  for (const p of ["BRIEF.md", "src/link.ts", "src/id_rsa", "src/logo.png", "vendor/repo/.git/config", ".touchstone.json", "../x", path.join(outside, "host.ts"), "src/../../etc/passwd"]) {
    assert.equal(review.resolveReadable(ws, p), null, p);
  }
});

test("a fetched clone loses symlinks, hidden files, and secret files", () => {
  const d = mkdtempSync(path.join(tmpdir(), "prune-"));
  cleanup.push(d);
  mkdirSync(path.join(d, "src/.hidden"), { recursive: true });
  writeFileSync(path.join(d, "src/a.ts"), "");
  writeFileSync(path.join(d, ".env"), "SECRET=1");
  writeFileSync(path.join(d, "src/server.pem"), "");
  symlinkSync("/etc/passwd", path.join(d, "src/pw"));
  assert.equal(pruneClone(d), 4);
  assert.ok(existsSync(path.join(d, "src/a.ts")));
  assert.ok(!existsSync(path.join(d, ".env")) && !existsSync(path.join(d, "src/pw")) && !existsSync(path.join(d, "src/server.pem")));
});

test("a code scope allows Code review always, and Contracts only with Solidity or a repo", () => {
  const go = addScope({ title: "go only", members: [folder("api", [["main.go", "package main\n"]])] });
  assert.deepEqual(targetSummary(go).packs, ["review"]);
  assert.throws(() => pickTarget({ id: go.id, pack: "contracts" }), /belongs to pack "review"/);

  const sol = addScope({ title: "sol", members: [folder("c", [["src/V.sol", "contract V {}\n"]])] });
  assert.deepEqual(targetSummary(sol).packs, ["contracts", "review"]);
  // A run that picks Code review gets that module's proof surface: none.
  const view = pickTarget({ id: sol.id, pack: "review" });
  assert.equal(view.pack, "review");
  assert.equal(view.signal, "agent");
  assert.equal(targetSummary(view).proofSurface.kind, "none");
  assert.deepEqual(targetSummary(view).members.map((m) => m.proof), ["none"]);
  const ws = prepareWorkspace(view, { modules: planModules(view, undefined, PACKS.review) });
  cleanup.push(ws);
  assert.equal(readTouchstone(ws).pack, "review");
  assert.ok(!existsSync(path.join(ws, "foundry.toml")));
  // With no module named, the scope's own module is the default.
  assert.equal(pickTarget({ id: sol.id }).pack, "contracts");

  const repo = addScope({ title: "repo", members: [{ kind: "repo", url: "https://github.com/acme/svc" }] });
  assert.deepEqual(targetSummary(repo).packs, ["review", "contracts"]);
});
