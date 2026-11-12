// Source navigation is the DEFAULT code-reading layer mounted on top of the
// Contracts and Review packs — not a selectable pack. These tests cover the
// pure wiring (the five tools, the prefer-the-index prompt, the fingerprint that
// triggers a re-index) and the staging mechanism that scopes the index to
// src/ + vendor/ so test fixtures and vendored toolchains cannot shadow the
// target. The engine binary is RUN, never committed, so the few assertions that
// need it are gated on resolveCbmBinary(); the rest run everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceNavTools, NAV_SYSTEM, sourceFingerprint, stageSources, VENDOR_STAGE } from '../packs/source-nav/pack.mjs';
import { PACKS } from '../packs/index.mjs';

const NAV_NAMES = ['resolve_symbol', 'read_symbol', 'get_code_snippets', 'read_symbols', 'search_and_read_symbols'];

function workspace() {
  const ws = mkdtempSync(join(tmpdir(), 'nav-test-'));
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, 'src', 'Vault.sol'),
    'pragma solidity ^0.8.0;\ncontract Vault {\n  function withdraw(uint256 x) public returns (uint256) { return x; }\n}\n');
  return ws;
}

test('sourceNavTools exposes exactly the five read-only query tools', () => {
  const ws = workspace();
  try {
    const tools = sourceNavTools(ws);
    assert.equal(tools.length, 5);
    assert.deepEqual(tools.map((t) => t.name).sort(), [...NAV_NAMES].sort());
    for (const t of tools) assert.equal(t.replay, 'safe');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('NAV_SYSTEM tells the hunter to prefer the index and names the tools', () => {
  assert.equal(typeof NAV_SYSTEM, 'string');
  assert.match(NAV_SYSTEM, /prefer it/i);
  assert.match(NAV_SYSTEM, /read_symbol/);
  assert.match(NAV_SYSTEM, /search_and_read_symbols/);
  assert.match(NAV_SYSTEM, /fall back/i);
});

test('source-nav is NOT a selectable pack', () => {
  assert.equal(PACKS['source-nav'], undefined);
});

test('fingerprint changes when source lands and is stable otherwise', () => {
  const ws = workspace();
  try {
    const a = sourceFingerprint(ws);
    assert.equal(sourceFingerprint(ws), a, 'stable with no change');
    writeFileSync(join(ws, 'src', 'Beta.sol'),
      'pragma solidity ^0.8.0;\ncontract Beta { function beta() public pure returns (uint256) { return 2; } }\n');
    assert.notEqual(sourceFingerprint(ws), a, 'changes when a src/ file is added');
    const b = sourceFingerprint(ws);
    // vendor/ is watched too (what fetch_source populates).
    mkdirSync(join(ws, 'vendor'), { recursive: true });
    writeFileSync(join(ws, 'vendor', 'Lib.sol'),
      'pragma solidity ^0.8.0;\ncontract Lib { function lib() public pure returns (uint256) { return 3; } }\n');
    assert.notEqual(sourceFingerprint(ws), b, 'changes when a vendor/ file is added');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('fingerprint ignores files outside src/ and vendor/, and skips symlinks', () => {
  const ws = workspace();
  try {
    const base = sourceFingerprint(ws);
    mkdirSync(join(ws, 'test'), { recursive: true });
    writeFileSync(join(ws, 'test', 'Vault.t.sol'), 'contract T {}\n');
    writeFileSync(join(ws, 'README.md'), '# ignore me\n');
    assert.equal(sourceFingerprint(ws), base, 'test/ and top-level files do not count');
    // A symlink inside src/ is skipped, not followed (no loop, no outside code).
    symlinkSync(join(ws, 'test'), join(ws, 'src', 'link'), 'dir');
    assert.equal(sourceFingerprint(ws), base, 'a symlink under src/ is skipped');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('stageSources materializes only src/ and vendor/, excluding everything else', () => {
  const ws = workspace();
  mkdirSync(join(ws, 'vendor', 'forge-std'), { recursive: true });
  writeFileSync(join(ws, 'vendor', 'forge-std', 'Test.sol'), 'contract StdTest {}\n');
  mkdirSync(join(ws, 'test'), { recursive: true });
  writeFileSync(join(ws, 'test', 'Vault.t.sol'), 'contract VaultTest {}\n');
  mkdirSync(join(ws, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(ws, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  let staging;
  try {
    staging = stageSources(ws);
    assert.ok(existsSync(join(staging, 'src', 'Vault.sol')), 'src/ is staged');
    // vendor/ is staged under the sentinel so the engine's dependency-dir ignore
    // does not drop it; query() maps the sentinel back to "vendor" in results.
    assert.ok(existsSync(join(staging, VENDOR_STAGE, 'forge-std', 'Test.sol')), 'vendor/ is staged under the sentinel');
    assert.equal(existsSync(join(staging, 'vendor')), false, 'vendor/ is NOT staged under its own (ignored) name');
    assert.equal(existsSync(join(staging, 'test')), false, 'test/ is excluded');
    assert.equal(existsSync(join(staging, 'node_modules')), false, 'node_modules/ is excluded');
    assert.equal(existsSync(join(staging, 'README.md')), false, 'top-level files are excluded');
    assert.deepEqual(readdirSync(staging).sort(), [VENDOR_STAGE, 'src'].sort());
  } finally {
    rmSync(ws, { recursive: true, force: true });
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
});

test('stageSources mirrors the read layer: nested dep/build/hidden dirs and secret files never reach the index', () => {
  // The engine's own dependency-dir ignore only matches a LEADING segment, so
  // once vendor/ is restaged under the sentinel a nested node_modules/ or out/ is
  // no longer protected. staging must prune them itself (and secret files), or the
  // symbol index would expose what the pack's file tools deliberately hide.
  const ws = workspace();
  const repo = join(ws, 'vendor', 'dep__lib');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'Good.sol'), 'pragma solidity ^0.8.0;\ncontract Good { function g() public pure returns (uint256) { return 1; } }\n');
  // Nested dependency/build/hidden folders — all dropped.
  mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'pkg', 'Dep.sol'), 'contract Dep { function g() public {} }\n');
  mkdirSync(join(repo, 'out'), { recursive: true });
  writeFileSync(join(repo, 'out', 'Built.sol'), 'contract Built { function g() public {} }\n');
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, '.git', 'config'), '[core]\n');
  // Secret-NAMED files — dropped by classifyPath.
  writeFileSync(join(repo, '.env'), 'PRIVATE_KEY=0xdeadbeef\n');
  writeFileSync(join(repo, 'secrets.json'), '{"k":"v"}\n');
  writeFileSync(join(repo, 'id_rsa.pem'), 'x\n');
  // Secret-CONTENT source — kept by name, dropped by secretContent.
  writeFileSync(join(repo, 'Leaky.sol'), 'pragma solidity ^0.8.0;\n// -----BEGIN RSA PRIVATE KEY-----\ncontract Leaky {}\n');
  let staging;
  try {
    staging = stageSources(ws);
    const at = (...p) => existsSync(join(staging, VENDOR_STAGE, 'dep__lib', ...p));
    assert.ok(at('Good.sol'), 'ordinary vendored source is staged');
    assert.equal(at('node_modules', 'pkg', 'Dep.sol'), false, 'nested node_modules/ is pruned');
    assert.equal(at('out', 'Built.sol'), false, 'nested build output is pruned');
    assert.equal(at('.git', 'config'), false, 'nested .git/ is pruned');
    assert.equal(at('.env'), false, 'a .env secret file is dropped');
    assert.equal(at('secrets.json'), false, 'a secrets.* file is dropped');
    assert.equal(at('id_rsa.pem'), false, 'a .pem key file is dropped');
    assert.equal(at('Leaky.sol'), false, 'source carrying an embedded private key is dropped (secretContent)');
  } finally {
    rmSync(ws, { recursive: true, force: true });
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
});

test('fingerprint prunes the same nested dep dirs (a node_modules change does not force a re-index)', () => {
  const ws = workspace();
  const repo = join(ws, 'vendor', 'dep__lib');
  mkdirSync(join(repo, 'node_modules'), { recursive: true });
  writeFileSync(join(repo, 'Good.sol'), 'pragma solidity ^0.8.0;\ncontract Good {}\n');
  try {
    const base = sourceFingerprint(ws);
    // A change under a pruned dependency dir must NOT move the fingerprint...
    writeFileSync(join(repo, 'node_modules', 'noise.js'), 'module.exports = Math.random();\n');
    assert.equal(sourceFingerprint(ws), base, 'a nested node_modules/ change is ignored');
    // ...but a change to real vendored source must.
    writeFileSync(join(repo, 'More.sol'), 'pragma solidity ^0.8.0;\ncontract More {}\n');
    assert.notEqual(sourceFingerprint(ws), base, 'a real vendored source change re-indexes');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('stageSources skips symlinks (never copies code from outside the two roots)', () => {
  const ws = workspace();
  const outside = mkdtempSync(join(tmpdir(), 'nav-outside-'));
  writeFileSync(join(outside, 'Evil.sol'), 'contract Evil {}\n');
  symlinkSync(join(outside, 'Evil.sol'), join(ws, 'src', 'Evil.sol'), 'file');
  let staging;
  try {
    staging = stageSources(ws);
    assert.equal(existsSync(join(staging, 'src', 'Evil.sol')), false, 'a symlinked file under src/ is not staged');
    assert.ok(existsSync(join(staging, 'src', 'Vault.sol')), 'real files are still staged');
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
});

// The agent-run wiring gates the nav tools + prompt on the engine binary
// resolving. Mirror that gate here so this file passes on hosts without the
// pinned binary (CI): the engine-dependent behavior is covered by the offline
// smoke (spike/test/cbm-smoke.mjs), which is run deliberately, not in this suite.
test('nav tools are pure builders — constructing them needs no engine', () => {
  const ws = workspace();
  try {
    // Building the tools must not spawn or require the binary; it is resolved
    // lazily on first query. This asserts the builder stays side-effect-free.
    const tools = sourceNavTools(ws);
    assert.ok(tools.every((t) => typeof t.execute === 'function'));
  } finally { rmSync(ws, { recursive: true, force: true }); }
});
