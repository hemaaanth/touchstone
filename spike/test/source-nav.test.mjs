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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceNavTools, NAV_SYSTEM, sourceFingerprint, stageSources, VENDOR_STAGE } from '../packs/source-nav/pack.mjs';
import { PACKS } from '../packs/index.mjs';
import { resolveCbmBinary } from '../lib/cbm.mjs';

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

// ---- Index scope + failure cache + wiring (repair of the default-read-layer review) ----

const toolNamed = (ws, name) => sourceNavTools(ws).find((t) => t.name === name);
const call = async (ws, name, args) => {
  const r = await toolNamed(ws, name).execute(args);
  return { isError: !!r.isError, body: JSON.parse(r.output[0].text) };
};
const ERC20 = (name) =>
  `pragma solidity ^0.8.0;\ncontract ${name} {\n  mapping(address => uint256) public balanceOf;\n` +
  `  function transfer(address to, uint256 v) public returns (bool) { balanceOf[to] += v; return true; }\n` +
  `  function approve(address s, uint256 v) public returns (bool) { return v > 0 && s != address(0); }\n}\n`;

test('a deterministic index failure is cached per fingerprint, and retried only when the fingerprint changes', async () => {
  // A non-empty executable whose sha256 is not the pin: the wrapper refuses to run
  // it, so every index attempt fails the same way. Each attempt allocates a private
  // engine cache dir (touchstone-cbm-*), which lets us count real index attempts.
  const fake = mkdtempSync(join(tmpdir(), 'nav-fakebin-'));
  const bin = join(fake, 'cbm');
  writeFileSync(bin, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const attempts = () => readdirSync(tmpdir()).filter((n) => n.startsWith('touchstone-cbm-')).length;
  const prior = process.env.PI_CBM_BIN;
  process.env.PI_CBM_BIN = bin;
  const ws = workspace();
  try {
    const before = attempts();
    const first = await call(ws, 'resolve_symbol', { name: 'withdraw' });
    assert.equal(first.isError, true);
    assert.match(first.body.error, /index failed/);
    assert.equal(attempts() - before, 1, 'first call runs one index attempt');
    for (let i = 0; i < 4; i++) {
      const again = await call(ws, 'read_symbol', { name: 'withdraw' });
      assert.equal(again.isError, true);
      assert.match(again.body.error, /index failed/);
    }
    assert.equal(attempts() - before, 1, 'same fingerprint: the cached failure is returned, no re-index');
    // New code lands in vendor/ (a fetch_source clone): fingerprint moves, so retry once.
    mkdirSync(join(ws, 'vendor'), { recursive: true });
    writeFileSync(join(ws, 'vendor', 'Lib.sol'), 'pragma solidity ^0.8.0;\ncontract Lib { function lib() public {} }\n');
    await call(ws, 'resolve_symbol', { name: 'withdraw' });
    await call(ws, 'resolve_symbol', { name: 'withdraw' });
    assert.equal(attempts() - before, 2, 'a changed fingerprint retries exactly once more');
  } finally {
    if (prior === undefined) delete process.env.PI_CBM_BIN; else process.env.PI_CBM_BIN = prior;
    rmSync(ws, { recursive: true, force: true });
    rmSync(fake, { recursive: true, force: true });
  }
});

test('sourceFingerprint and stageSources never touch lib/, test/, node_modules/, out/ or .git/ at the workspace root', () => {
  // The scope shadows the review found (forge-std mocks, a stale AgentPoc.t.sol)
  // live OUTSIDE src/ and vendor/. This pins the scoping logic without the engine.
  const ws = workspace();
  for (const [dir, file] of [['lib/forge-std/src/mocks', 'MockERC20.sol'], ['test', 'AgentPoc.t.sol'], ['out', 'Built.sol'], ['node_modules/x', 'X.sol'], ['.git', 'cfg']]) {
    mkdirSync(join(ws, dir), { recursive: true });
    writeFileSync(join(ws, dir, file), ERC20('Shadow'));
  }
  let staging;
  try {
    const base = sourceFingerprint(ws);
    writeFileSync(join(ws, 'test', 'AgentPoc.t.sol'), ERC20('Rewritten')); // writePoc rewrite
    assert.equal(sourceFingerprint(ws), base, 'rewriting test/AgentPoc.t.sol does not move the fingerprint');
    staging = stageSources(ws);
    assert.deepEqual(readdirSync(staging), ['src'], 'only src/ is staged when vendor/ is absent');
    assert.deepEqual(readdirSync(join(staging, 'src')), ['Vault.sol']);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
});

test('agent-run mounts the nav tools + prompt only for contracts/review, and only when the binary resolves', () => {
  // agent-run.mjs is a runner (it executes on import), so the gate is pinned by
  // reading the one expression that decides it rather than by importing it.
  const src = readFileSync(new URL('../agent-run.mjs', import.meta.url), 'utf8');
  const gate = src.match(/const navy = (.+);/);
  assert.ok(gate, 'a single `navy` gate exists');
  // The two code-reading packs, named once, and a joined run when any module is
  // one of them.
  const reads = src.match(/const readsCode = \(id\) => (.+);/);
  assert.ok(reads, 'one `readsCode` list exists');
  assert.match(reads[1], /id === "contracts"/);
  assert.match(reads[1], /id === "review"/);
  assert.equal((reads[1].match(/id ===/g) ?? []).length, 2, 'no other pack is gated in');
  assert.match(gate[1], /pack\.readsCode === true/, 'a joined code run is gated in too');
  assert.match(gate[1], /await resolveCbmBinary\(\)\) !== null/, 'gated on the binary actually resolving');
  assert.match(src, /const navText = navy \?/, 'prompt only when navy');
  assert.match(src, /\.\.\.pack\.tools\(ws, state\), \.\.\.\(navy \? sourceNavTools\(ws\) : \[\]\)/, 'tools only when navy');
  // Both gated packs are real, selectable packs; every other pack is unchanged
  // because the gate names exactly those two ids (asserted above).
  for (const id of ['contracts', 'review']) assert.ok(PACKS[id], `${id} pack exists`);
});

test('with the engine: resolve_symbol/read_symbol on ERC20 names resolve to src/, never forge-std, test/ or out/ shadows', { skip: (await resolveCbmBinary()) ? false : 'codebase-memory-mcp binary not installed' }, async () => {
  const ws = workspace();
  writeFileSync(join(ws, 'src', 'Token.sol'), ERC20('Token'));
  for (const [dir, file, name] of [['lib/forge-std/src/mocks', 'MockERC20.sol', 'MockERC20'], ['test', 'AgentPoc.t.sol', 'AgentPoc'], ['out', 'Built.sol', 'Built'], ['node_modules/x', 'X.sol', 'X']]) {
    mkdirSync(join(ws, dir), { recursive: true });
    writeFileSync(join(ws, dir, file), ERC20(name));
  }
  try {
    for (const name of ['transfer', 'approve', 'balanceOf']) {
      const { isError, body } = await call(ws, 'resolve_symbol', { name });
      assert.equal(isError, false, `${name}: ${JSON.stringify(body)}`);
      const files = JSON.stringify(body);
      for (const shadow of ['forge-std', 'MockERC20', 'AgentPoc', 'Built', 'node_modules', '/test/', '/out/'])
        assert.equal(files.includes(shadow), false, `${name} leaks ${shadow}: ${files}`);
      assert.match(files, /src\/Token\.sol/, `${name} resolves into the target's own contract`);
    }
    // The ERC20 names that failed closed on main (33 candidates) now read cleanly.
    const read = await call(ws, 'read_symbol', { name: 'transfer', file_path: 'src/Token.sol' });
    assert.equal(read.isError, false, JSON.stringify(read.body));
    assert.match(JSON.stringify(read.body), /balanceOf\[to\] \+= v/);
    // A test/ rewrite after the index is built does not become readable as audited code.
    writeFileSync(join(ws, 'test', 'AgentPoc.t.sol'), 'contract StalePoc { function exploit() public {} }\n');
    const stale = await call(ws, 'resolve_symbol', { name: 'exploit' });
    assert.equal(JSON.stringify(stale.body).includes('StalePoc'), false, 'own stale PoC is not indexed');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// A vendored symbol frequently shares a NAME with a src/ symbol (forge-std ships
// its own Test, IERC20, console, SafeMath that a target shadows). The vendor
// input-map (toStagePath/mapIn) exists so a hunter who sees a result at
// "vendor/..." can pass that path straight back as a file_path disambiguator and
// select the VENDORED copy — on read_symbol, not just resolve_symbol. Nothing
// else pins that round trip: a future edit to the input map could silently make a
// vendor-path read return the src shadow's body instead. Both bodies are distinct
// so a wrong pick is unambiguous.
test('with the engine: a vendor/ file_path disambiguator reads the VENDORED body, not the src/ shadow of the same name', { skip: (await resolveCbmBinary()) ? false : 'codebase-memory-mcp binary not installed' }, async () => {
  const ws = workspace();
  mkdirSync(join(ws, 'vendor', 'forge-std'), { recursive: true });
  // Same contract + method name in both roots; bodies differ so the pick is provable.
  writeFileSync(join(ws, 'src', 'Shared.sol'),
    'pragma solidity ^0.8.0;\ncontract Shared {\n  function dualName(uint256 a) public pure returns (uint256) { return a + 1; }\n}\n');
  writeFileSync(join(ws, 'vendor', 'forge-std', 'Shared.sol'),
    'pragma solidity ^0.8.0;\ncontract Shared {\n  function dualName(uint256 b) public pure returns (uint256) { return b + 42; }\n}\n');
  try {
    // Undisambiguated: the name exists in both roots.
    const both = await call(ws, 'resolve_symbol', { name: 'dualName' });
    assert.equal(both.isError, false, JSON.stringify(both.body));
    assert.equal(both.body.total_candidates, 2, `dualName exists in src/ and vendor/: ${JSON.stringify(both.body)}`);

    // A vendor/ file_path selects exactly the vendored candidate...
    const vpick = await call(ws, 'resolve_symbol', { name: 'dualName', file_path: 'vendor/forge-std/Shared.sol' });
    assert.equal(vpick.body.total_candidates, 1, `vendor file_path narrows to one: ${JSON.stringify(vpick.body)}`);
    assert.equal(vpick.body.candidates[0].file_path, 'vendor/forge-std/Shared.sol');

    // ...and read_symbol with that file_path returns the VENDORED body, not src's.
    const vread = await call(ws, 'read_symbol', { name: 'dualName', file_path: 'vendor/forge-std/Shared.sol' });
    assert.equal(vread.isError, false, JSON.stringify(vread.body));
    const vbody = JSON.stringify(vread.body);
    assert.match(vread.body.source, /return b \+ 42/, `read returns the vendored body: ${vbody}`);
    assert.equal(vread.body.source.includes('return a + 1'), false, 'read did NOT return the src/ shadow body');
    // The agent-facing PATH + source stay clean: the staging sentinel never leaks
    // into a file_path or the source the hunter reads. (qualified_name/parent_class
    // deliberately keep the sentinel as opaque round-trip tokens — see pack.mjs.)
    assert.equal(vread.body.file_path, 'vendor/forge-std/Shared.sol');
    assert.equal(vread.body.resolved.file_path, 'vendor/forge-std/Shared.sol');
    assert.equal(vread.body.source.includes(VENDOR_STAGE), false, `no ${VENDOR_STAGE} sentinel in the source: ${vread.body.source}`);

    // Regression guard: the vendor input-map must not touch a src/ disambiguator.
    const sread = await call(ws, 'read_symbol', { name: 'dualName', file_path: 'src/Shared.sol' });
    assert.equal(sread.isError, false, JSON.stringify(sread.body));
    const sbody = JSON.stringify(sread.body);
    assert.match(sbody, /return a \+ 1/, `src file_path still reads the src body: ${sbody}`);
    assert.equal(sbody.includes('return b + 42'), false, 'src read did NOT return the vendored body');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});
