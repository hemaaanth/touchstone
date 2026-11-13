// The grant store and the scope store do not lose data.
//
//   - A write goes to a temp file in the same directory, then a rename.
//   - A missing file is an empty store.
//   - A file that exists but cannot be read or parsed is damaged: every
//     mutation is refused with a clear sentence, and the file stays as it is.
//
// Throwaway stores in a temp directory. No network, no docker.
//
//   node --test spike/test/store-durable.test.mjs
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "store-durable-test-"));
const store = path.join(dir, "store");
process.env.TOUCHSTONE_SCOPES_FILE = path.join(store, "scopes.json");
process.env.TOUCHSTONE_GRANTS_FILE = path.join(store, "grants.json");
// A throwaway console token, so the real spike/data/console-token is not read.
process.env.TOUCHSTONE_GRANT_TOKEN = "store-durable-test-token";
const scopesFile = process.env.TOUCHSTONE_SCOPES_FILE;
const grantsFile = process.env.TOUCHSTONE_GRANTS_FILE;
beforeEach(() => rmSync(store, { recursive: true, force: true }));
after(() => rmSync(dir, { recursive: true, force: true }));

const { addGrant, removeGrant, readGrants, getGrant } = await import("../lib/grant-store.mjs");
const { addScope, addBriefScope, addLiveScope, removeScope, readScopes, getUserScope } = await import("../lib/scopes-store.mjs");

const grant = (host) => addGrant({ hosts: [host], kind: "operator-owned", ownership: true });
const folderScope = (title) => addScope({ title, members: [{ kind: "folder", name: "api", files: [{ path: "main.go", content: "package main\n" }] }] });
const damage = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };

// Each way a store file can be damaged. A truncated file is what a crash in
// the middle of the old write left behind.
const DAMAGED = [
  ["truncated JSON", '[{"id":"grant-a","hosts":["a.exa'],
  ["an empty file", ""],
  ["not a list", '{"id":"scope-a"}'],
];

test("a missing file is an empty store, and the first add creates it", () => {
  assert.deepEqual(readGrants(), []);
  assert.deepEqual(readScopes(), []);
  const g = grant("a.example.com");
  const s = folderScope("first");
  assert.deepEqual(JSON.parse(readFileSync(grantsFile, "utf8")).map((x) => x.id), [g.id]);
  assert.deepEqual(JSON.parse(readFileSync(scopesFile, "utf8")).map((x) => x.id), [s.id]);
});

test("a normal add survives: every record is still there after later adds and a remove", () => {
  const g1 = grant("a.example.com");
  const g2 = grant("b.example.com");
  const g3 = grant("c.example.com");
  assert.equal(removeGrant(g2.id), true);
  assert.deepEqual(readGrants().map((g) => g.id), [g3.id, g1.id]);
  assert.deepEqual(getGrant(g1.id), g1);
  const s1 = folderScope("one");
  const s2 = folderScope("two");
  assert.deepEqual(readScopes().map((s) => s.id), [s2.id, s1.id]);
  assert.deepEqual(getUserScope(s1.id), s1);
});

test("a write leaves no temp file behind, and keeps the mode of the store file", () => {
  grant("a.example.com");
  chmodSync(grantsFile, 0o600);
  grant("b.example.com");
  folderScope("one");
  assert.deepEqual(readdirSync(store).sort(), ["grants.json", "scopes.json"]);
  assert.equal(statSync(grantsFile).mode & 0o777, 0o600);
});

test("a write replaces the file by a rename, never a write in place", () => {
  const g1 = grant("a.example.com");
  const before = statSync(grantsFile).ino;
  grant("b.example.com");
  // A rename gives the path a new file. A write in place keeps the same file.
  assert.notEqual(statSync(grantsFile).ino, before);
  assert.equal(readGrants().at(-1).id, g1.id);
});

test("legacy records in the array still load", () => {
  const legacy = [
    { id: "brief-old", kind: "brief", title: "Old brief", brief: "# old\n", links: [] },
    { id: "src-old", kind: "local-source", title: "Old folder", files: [{ path: "src/A.sol", content: "contract A {}" }] },
  ];
  damage(scopesFile, JSON.stringify(legacy));
  assert.deepEqual(readScopes(), legacy);
  // A new record goes in front. The legacy records stay as they are.
  const s = folderScope("new");
  assert.deepEqual(readScopes(), [s, ...legacy]);
  // A grant written before allowPrivate and scopeId existed still loads.
  const old = [{ id: "grant-old", kind: "operator-owned", hosts: ["old.example.com"], ownership: true, approvedBy: "operator", approvedAt: 1, expiresAt: null }];
  damage(grantsFile, JSON.stringify(old));
  assert.deepEqual(readGrants(), old);
  const g = grant("new.example.com");
  assert.deepEqual(readGrants(), [g, ...old]);
});

for (const [name, text] of DAMAGED) {
  test(`a damaged grant store (${name}) refuses every mutation and is left as it is`, () => {
    damage(grantsFile, text);
    assert.throws(() => grant("a.example.com"), /Refused: the grant store file .* (is not a valid JSON list|cannot be read)/);
    assert.throws(() => removeGrant("grant-a"), /Refused: the grant store file/);
    // A live scope writes a grant first: it is refused, and no scope is saved.
    assert.throws(() => addLiveScope({ hosts: ["a.example.com"], permission: true }), /Refused: the grant store file/);
    assert.equal(readFileSync(grantsFile, "utf8"), text);
    assert.deepEqual(readdirSync(store), ["grants.json"]);
    // The gate reads a damaged store as "no grants": it fails closed.
    assert.deepEqual(readGrants(), []);
  });

  test(`a damaged scope store (${name}) refuses every mutation and is left as it is`, () => {
    damage(scopesFile, text);
    assert.throws(() => folderScope("x"), /Refused: the scope store file .* is not a valid JSON list\. Nothing was changed\./);
    assert.throws(() => addBriefScope({ title: "b", brief: "# b\n" }), /Refused: the scope store file/);
    assert.throws(() => removeScope("scope-a"), /Refused: the scope store file/);
    // The live scope's grant is rolled back when the scope cannot be saved.
    assert.throws(() => addLiveScope({ hosts: ["a.example.com"], permission: true }), /Refused: the scope store file/);
    assert.equal(readFileSync(scopesFile, "utf8"), text);
    assert.deepEqual(readGrants(), []);
    assert.deepEqual(readScopes(), []);
  });
}

test("a store file that cannot be read refuses the mutation and is left as it is", () => {
  // A directory at the store path: the read fails with an error that is not "missing".
  mkdirSync(grantsFile, { recursive: true });
  assert.throws(() => grant("a.example.com"), /Refused: the grant store file .* exists but cannot be read \(EISDIR\)/);
  assert.equal(statSync(grantsFile).isDirectory(), true);
  assert.deepEqual(readdirSync(store), ["grants.json"]);
});

test("removing a scope is refused when the grant store is damaged, and the scope stays", () => {
  const scope = addLiveScope({ hosts: ["a.example.com"], permission: true });
  const text = readFileSync(grantsFile, "utf8").slice(0, 40);
  writeFileSync(grantsFile, text);
  assert.throws(() => removeScope(scope.id), /Refused: the grant store file/);
  assert.equal(getUserScope(scope.id).id, scope.id);
  assert.equal(readFileSync(grantsFile, "utf8"), text);
});
