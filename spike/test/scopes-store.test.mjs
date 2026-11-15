// Tests for operator scopes with members (repos + folders, any language).
//
// Each test writes to a throwaway store via TOUCHSTONE_SCOPES_FILE, so the real
// spike/data/scopes.json is never touched. No network, no docker.
//
//   node --test spike/test/scopes-store.test.mjs
import "./helpers/isolated-env.mjs";
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "scopes-store-test-"));
process.env.TOUCHSTONE_SCOPES_FILE = path.join(dir, "scopes.json");
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => rmSync(process.env.TOUCHSTONE_SCOPES_FILE, { force: true }));

const store = await import("../lib/scopes-store.mjs");
const { addScope, getUserScope, readScopes, addSourceScope, addRepoScope, classifyPath, scopePack } = store;

const file = (p, content = "x") => ({ path: p, content });
const folder = (name, files) => ({ kind: "folder", name, files });
const repo = (url) => ({ kind: "repo", url });

test("a mixed repo + folder scope round-trips through the store", () => {
  const added = addScope({
    title: "Vault + indexer",
    members: [
      repo("https://github.com/acme/vault?x=1#y"),
      folder("indexer", [file("src/main.py", "print(1)\n"), file("README.md", "# hi\n")]),
      folder("contracts", [file("src/Vault.sol", "contract V {}\n")]),
    ],
  });
  assert.match(added.id, /^scope-vault-indexer-[0-9a-f]{8}$/);
  assert.equal(added.kind, "scope");
  assert.equal(added.pack, "contracts"); // a Solidity file is present
  assert.deepEqual(added.links, ["https://github.com/acme/vault"]); // query and fragment dropped
  const back = getUserScope(added.id);
  assert.deepEqual(back, added);
  assert.deepEqual(back.members.map((m) => m.kind), ["repo", "folder", "folder"]);
  assert.deepEqual(back.members[1].files.map((f) => f.path), ["src/main.py", "README.md"]);
  // The store is one JSON file at the configured path.
  assert.equal(JSON.parse(readFileSync(process.env.TOUCHSTONE_SCOPES_FILE, "utf8"))[0].id, added.id);
});

test("a non-Solidity folder is accepted and gets the read-only review pack", () => {
  const s = addScope({ title: "api", members: [folder("api", [file("server.go", "package main\n"), file("go.mod", "module x\n")])] });
  assert.equal(s.pack, "review");
  assert.equal(s.proofSurface.kind, "none");
  assert.equal(readScopes().length, 1);
});

test("the pack follows content, with no automatic fallback to Contracts", () => {
  const f = (p) => ({ kind: "folder", name: "a", files: [{ path: p, content: "" }] });
  assert.equal(scopePack([f("x.sol")]), "contracts");
  assert.equal(scopePack([f("x.rs")]), "review");
  assert.equal(scopePack([f("x.rs")], "contracts"), "review"); // known content beats the hint
  assert.equal(scopePack([repo("https://github.com/a/b")]), "review");
  assert.equal(scopePack([repo("https://github.com/a/b")], "contracts"), "contracts");
  assert.equal(scopePack([repo("https://github.com/a/b/blob/main/V.sol")]), "contracts");
  // The legacy single-repo route keeps its old Contracts meaning.
  assert.equal(addRepoScope({ title: "r", repo: "https://github.com/a/b" }).pack, "contracts");
});

test("hidden, host, absolute, and .. paths are rejected", () => {
  for (const p of [".env", "src/.git/config", "/etc/passwd", "../x.py", "a/../b.py", "C:/x.py", "a\\b.py", "a//b.py", "./a.py", "a/\u0001.py", ""]) {
    assert.throws(() => addScope({ title: "t", members: [folder("f", [file(p)])] }), /relative file paths/, p);
  }
  assert.throws(() => addScope({ title: "t", members: [folder("..", [file("a.py")])] }), /folder name/);
  assert.throws(() => addScope({ title: "t", members: [folder(".hidden", [file("a.py")])] }), /folder name/);
  assert.throws(() => addScope({ title: "t", members: [folder("a/b", [file("a.py")])] }), /folder name/);
  assert.equal(readScopes().length, 0);
});

test("a whole monorepo fits: 12000 files and 120 MB, across folders", () => {
  const many = (n, pre) => Array.from({ length: n }, (_, i) => file(`${pre}${i}.py`));
  // 292 files (privacy-pools-core) is an ordinary app, not a special case.
  assert.ok(addScope({ title: "t", members: [folder("a", many(292, "a"))] }));
  assert.ok(addScope({ title: "t", members: [folder("a", many(8000, "a")), folder("b", many(3999, "b"))] }));
  assert.throws(() => addScope({ title: "t", members: [folder("a", many(12001, "a"))] }), /1 to 12000 files/);
  assert.throws(() => addScope({ title: "t", members: [folder("a", many(8000, "a")), folder("b", many(4001, "b"))] }), /1 to 12000 files/);
  const big = "x".repeat(61 * 1024 * 1024);
  assert.throws(() => addScope({ title: "t", members: [folder("a", [file("a.py", big)]), folder("b", [file("b.py", big)])] }), /under 120 MB/);
  assert.throws(() => addScope({ title: "t", members: [folder("a", [])] }), /at least one file/);
  assert.throws(() => addScope({ title: "t", members: [] }), /1 to 20/);
});

test("non-GitHub, http, credentialed, and ported URLs are rejected", () => {
  for (const url of [
    "http://github.com/a/b",
    "https://gitlab.com/a/b",
    "https://github.com.evil.io/a/b",
    "https://user:pw@github.com/a/b",
    "https://github.com:8443/a/b",
    "https://github.com/a",
    "file:///etc/passwd",
    "not a url",
  ]) {
    assert.throws(() => addScope({ title: "t", members: [repo(url)] }), /GitHub/, url);
  }
});

test("secrets, dependencies, build output, binaries, and our sandbox config are dropped, never stored", () => {
  const s = addScope({
    title: "app",
    members: [folder("app", [
      file("index.ts", "export {}\n"),
      file("node_modules/x/index.js"),
      file("dist/bundle.js"),
      file("id_rsa", "secret"),
      file("deploy/prod.pem", "secret"),
      file("credentials.json", "{}"),
      file("config/keys.ts", "-----BEGIN RSA PRIVATE KEY-----\nabc\n"),
      file("logo.png", "binary-ish"),
      file("foundry.toml", "[profile]"),
    ])],
  });
  assert.deepEqual(s.members[0].files.map((f) => f.path), ["index.ts"]);
  assert.deepEqual(s.members[0].dropped, { "dependency or build folder": 2, "secret file": 4, "not a source file": 1, "sandbox config": 1 });
  assert.ok(!JSON.stringify(readScopes()).includes("PRIVATE KEY"));
  assert.throws(() => addScope({ title: "t", members: [folder("a", [file("id_ed25519")])] }), /No source files left/);
  // lib/ is a Foundry dependency folder only next to Solidity.
  assert.equal(classifyPath("lib/forge-std/Test.sol", { solidity: true }), "dependency or build folder");
  assert.equal(classifyPath("lib/app.rb"), "keep");
  // A NUL inside source is kept, minus the byte: webapp files do carry one.
  const nul = addScope({ title: "nul", members: [folder("n", [file("a.py", "a\u0000b")])] });
  assert.equal(nul.members[0].files[0].content, "ab");
});

test("the legacy single-folder helper routes through members and accepts non-Solidity", () => {
  const s = addSourceScope({ title: "Old folder", files: [file("src/A.sol", "contract A {}"), file("notes.md", "# n")] });
  assert.equal(s.kind, "scope");
  assert.equal(s.pack, "contracts");
  assert.deepEqual(s.members[0].files.map((f) => f.path), ["src/A.sol", "notes.md"]);
  assert.throws(() => addSourceScope({ title: "", files: [file("a.py")] }), /scope name/);
});
