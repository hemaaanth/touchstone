import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { copyWritable } from "../lib/writable-copy.mjs";
import { makeLabCopy, removeLabCopy } from "../packs/domains/labctl.mjs";
import { makeWorkspace, writePoc, writeTouchstone } from "../lib/sandbox.mjs";

function modes(path, writable) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  chmodSync(path, stat.isDirectory() ? (writable ? 0o700 : 0o500) : (writable ? 0o600 : 0o400));
  if (stat.isDirectory()) for (const name of readdirSync(path)) modes(join(path, name), writable);
}
const remove = (path) => { if (path && existsSync(path)) { modes(path, true); rmSync(path, { recursive: true, force: true }); } };
const put = (root, path, text) => { const file = join(root, path); mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, text); };

test("writable copies preserve executable bits and never chmod source or symlink targets", () => {
  const root = mkdtempSync(join(tmpdir(), "copy-permissions-"));
  try {
    const source = join(root, "source"), copy = join(root, "copy"), outside = join(root, "outside");
    put(source, "nested/file", "source"); put(source, "run.sh", "#!/bin/sh\n"); writeFileSync(outside, "outside", { mode: 0o400 });
    symlinkSync(outside, join(source, "link")); modes(source, false); chmodSync(join(source, "run.sh"), 0o500);
    copyWritable(source, copy, { recursive: true });
    assert.equal(statSync(join(copy, "nested")).mode & 0o777, 0o700);
    assert.equal(statSync(join(copy, "nested/file")).mode & 0o777, 0o600);
    assert.equal(statSync(join(copy, "run.sh")).mode & 0o777, 0o700);
    assert.equal(statSync(join(source, "nested/file")).mode & 0o777, 0o400);
    assert.equal(statSync(source).mode & 0o777, 0o500);
    assert.equal(statSync(outside).mode & 0o777, 0o400);
  } finally { remove(root); }
});

test("the actual Example SDK generator completes against sealed release source", async (t) => {
  if (process.getuid() === 0) return t.skip("requires non-root to detect sealed-source permissions");
  const root = mkdtempSync(join(tmpdir(), "sealed-supply-"));
  const pack = join(root, "packs/supply-chain");
  const previous = process.env.TMPDIR;
  let ws;
  try {
    mkdirSync(pack, { recursive: true }); mkdirSync(join(root, "lib")); mkdirSync(join(root, "scratch"));
    symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"), "dir");
    for (const name of ["lab.mjs", "cosign-lab.mjs"]) copyFileSync(new URL(`../packs/supply-chain/${name}`, import.meta.url), join(pack, name));
    copyFileSync(new URL("../lib/writable-copy.mjs", import.meta.url), join(root, "lib/writable-copy.mjs"));
    cpSync(new URL("../packs/supply-chain/lab/", import.meta.url), join(pack, "lab"), { recursive: true });
    modes(pack, false);
    process.env.TMPDIR = join(root, "scratch");
    const { makeLabWorkspace } = await import(pathToFileURL(join(pack, "lab.mjs")).href);
    ws = await makeLabWorkspace();
    assert.ok(existsSync(join(ws, "node_modules/ethres/index.js")));
    assert.equal(existsSync(join(ws, "plant")), false);
    assert.ok(existsSync(join(ws, ".git/HEAD")));
    assert.equal(JSON.parse(readFileSync(join(ws, ".touchstone.json"), "utf8")).pack, "supply-chain");
    assert.equal(statSync(join(pack, "lab/plant")).mode & 0o777, 0o500);
    assert.equal(statSync(join(pack, "lab/plant/ethres/index.js")).mode & 0o777, 0o400);
    rmSync(ws, { recursive: true });
    assert.equal(existsSync(ws), false, "normal cleanup needs no permission repair");
  } finally {
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    remove(root);
  }
});

for (const pack of ["contracts", "review"]) {
  test(`${pack} workspaces from sealed source remain editable and removable`, (t) => {
    if (process.getuid() === 0) return t.skip("requires non-root to detect sealed-source permissions");
    const source = mkdtempSync(join(tmpdir(), "sealed-workspace-"));
    let ws;
    try {
      put(source, "src/Contract.sol", "contract Contract {}\n");
      put(source, "lib/dep/Library.sol", "library Library {}\n");
      put(source, "test/Original.t.sol", "// existing test\n");
      put(source, "foundry.toml", "[profile.default]\n");
      put(source, ".touchstone.json", JSON.stringify({ pack }));
      modes(source, false);
      ws = makeWorkspace(source);
      writeTouchstone(ws, { pack, kind: "lab" });
      if (pack === "contracts") writePoc(ws, "// generated test\n");
      writeFileSync(join(ws, "src/Contract.sol"), "// edited copy\n");
      assert.equal(readFileSync(join(source, "src/Contract.sol"), "utf8"), "contract Contract {}\n");
      assert.equal(statSync(join(source, ".touchstone.json")).mode & 0o777, 0o400);
      rmSync(ws, { recursive: true });
      assert.equal(existsSync(ws), false);
    } finally { remove(ws); remove(source); }
  });
}


test("sealed DNS lab files can be rewritten only in their disposable copy", (t) => {
  if (process.getuid() === 0) return t.skip("requires non-root to detect sealed-source permissions");
  const source = mkdtempSync(join(tmpdir(), "sealed-dns-lab-"));
  let ws;
  try {
    put(source, "nested/zone.db", "app IN A 172.30.44.20\n"); modes(source, false);
    ws = makeLabCopy(source, { dns: "10.208.1.3", web: "10.208.1.4" });
    assert.match(readFileSync(join(ws, "nested/zone.db"), "utf8"), /10\.208\.1\.4/);
    assert.match(readFileSync(join(source, "nested/zone.db"), "utf8"), /172\.30\.44\.20/);
    assert.equal(statSync(join(source, "nested/zone.db")).mode & 0o777, 0o400);
    removeLabCopy(ws); assert.equal(existsSync(ws), false); ws = null;
  } finally { if (ws) removeLabCopy(ws); remove(source); }
});

test("brief workspace cleanup works with sealed vendored libraries", async (t) => {
  if (process.getuid() === 0) return t.skip("requires non-root to detect sealed-source permissions");
  const root = mkdtempSync(join(tmpdir(), "sealed-brief-"));
  let ws;
  try {
    const lib = join(root, "spike/lib"); mkdirSync(lib, { recursive: true });
    for (const name of ["sandbox.mjs", "writable-copy.mjs"]) copyFileSync(new URL(`../lib/${name}`, import.meta.url), join(lib, name));
    writeFileSync(join(lib, "daytona.mjs"), "export const SOLC_VERSION = /^\\d+\\.\\d+\\.\\d+$/; export const closeRun = async () => {}; export const daytonaOn = () => false; export const remoteDocker = () => { throw Error('Unexpected remote tool'); };\n");
    const std = join(root, "lab/vault-reentrancy/lib/forge-std");
    put(std, "src/Test.sol", "// vendored fixture\n"); modes(std, false);
    const { makeBriefWorkspace } = await import(pathToFileURL(join(lib, "sandbox.mjs")).href);
    ws = makeBriefWorkspace(); rmSync(ws, { recursive: true });
    assert.equal(existsSync(ws), false);
    assert.equal(statSync(join(std, "src")).mode & 0o777, 0o500);
  } finally { remove(ws); remove(root); }
});
