// makeWorkspace keeps the target's .touchstone.json, so a run reaches its pack.
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeWorkspace, readTouchstone } from "../lib/sandbox.mjs";

const put = (root, rel, text = "x") => {
  const f = join(root, rel);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, text);
};

// Run `body(target)` with a temp target, then remove the target and its workspace.
function withTarget(files, body) {
  const target = mkdtempSync(join(tmpdir(), "target-"));
  let ws;
  try {
    for (const [rel, text] of Object.entries(files)) put(target, rel, text);
    ws = makeWorkspace(target);
    body(ws);
  } finally {
    rmSync(target, { recursive: true, force: true });
    if (ws) rmSync(ws, { recursive: true, force: true });
  }
}

test("a non-Contracts target is copied whole, with .git and its pack, and gets no Foundry files", () => {
  withTarget({
    ".touchstone.json": JSON.stringify({ pack: "supply-chain" }),
    "snapshot.json": "x", ".git/HEAD": "x", "node_modules/dep/index.js": "x",
    "out/build.txt": "x", "cache/c.txt": "x", "oracle/answer.txt": "x", "pkg/out/real.txt": "x",
  }, (ws) => {
    assert.equal(readTouchstone(ws).pack, "supply-chain");
    for (const keep of ["snapshot.json", ".git/HEAD", "pkg/out/real.txt"]) assert.ok(existsSync(join(ws, keep)), keep);
    for (const skip of ["node_modules", "out", "cache", "oracle", "test", "src", "lib", "foundry.toml"]) assert.ok(!existsSync(join(ws, skip)), skip);
  });
});

test("a Contracts target keeps today's copy and its config", () => {
  withTarget({
    "src/A.sol": "x", "lib/l.txt": "x", "foundry.toml": "x", "oracle/exploit.sol": "x",
    ".touchstone.json": JSON.stringify({ pack: "contracts" }),
  }, (ws) => {
    assert.equal(readTouchstone(ws).pack, "contracts");
    for (const keep of ["src/A.sol", "lib/l.txt", "foundry.toml", "test"]) assert.ok(existsSync(join(ws, keep)), keep);
    assert.ok(!existsSync(join(ws, "oracle")));
  });
});

test("a target with no config gives a workspace with no config", () => {
  withTarget({ "src/A.sol": "x", "lib/l.txt": "x", "foundry.toml": "x" }, (ws) => {
    assert.deepEqual(readTouchstone(ws), {});
  });
});

test("a target path with a trailing slash still skips oracle/", () => {
  const target = mkdtempSync(join(tmpdir(), "target-"));
  let ws;
  try {
    put(target, ".touchstone.json", JSON.stringify({ pack: "web" }));
    put(target, "oracle/answer.txt");
    put(target, "app.js");
    ws = makeWorkspace(target + "/");
    assert.ok(existsSync(join(ws, "app.js")));
    assert.ok(!existsSync(join(ws, "oracle")));
  } finally {
    rmSync(target, { recursive: true, force: true });
    if (ws) rmSync(ws, { recursive: true, force: true });
  }
});
