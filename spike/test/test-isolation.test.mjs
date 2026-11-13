// Guard (L19): no test may load the console-token store with the real files.
//
// lib/grant-store.mjs reads (or creates) spike/data/console-token when it
// loads, and the grant and scope stores read spike/data/grants.json and
// scopes.json. In the main checkout those are the operator's real token,
// grants and scopes. A test that loads either store, even through other
// modules, must point them at test values BEFORE the load:
//   - a static import that reaches a store: the file's FIRST import is the
//     helper (spike: "./helpers/isolated-env.mjs", app: "./helpers/isolated-env").
//     Static imports run before the test body, so env set there is too late.
//   - a store reached only by a dynamic import: the token (or token file),
//     grants and scopes env are set above that import, or the helper is first.
// The check follows each test's relative imports to the stores, so a new
// test, or a new import chain, that reaches a store is caught here.
//
//   node --test spike/test/test-isolation.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const STORES = ["spike/lib/grant-store.mjs", "spike/lib/scopes-store.mjs"].map((p) => join(ROOT, p));
const HELPER = /^\.\/helpers\/isolated-env(\.mjs|\.ts)?$/;

// Every import with a relative specifier, in source order, with its position.
const IMPORT = /(?:^|[;\s])(?:import\s*(?:[\w*{}\s,$]+?\s*from\s*)?|export\s+[\w*{}\s,$]+?\s+from\s*|import\s*\(\s*)(["'])(\.{1,2}\/[^"']+)\1/g;
function imports(src) {
  const out = [];
  for (const m of src.matchAll(IMPORT)) {
    const dynamic = /import\s*\(\s*$/.test(src.slice(m.index, m.index + m[0].length - m[2].length - 2));
    out.push({ spec: m[2], at: m.index, dynamic });
  }
  return out;
}
function resolveSpec(from, spec) {
  const base = resolve(dirname(from), spec);
  for (const p of [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, join(base, "index.ts")]) {
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}
const memo = new Map();
// Does loading this file (static and dynamic imports) reach a store?
function reaches(file) {
  if (STORES.includes(file)) return true;
  if (memo.has(file)) return memo.get(file);
  memo.set(file, false); // a cycle reaches nothing new
  let src = "";
  try { src = readFileSync(file, "utf8"); } catch { return false; }
  const hit = imports(src).some(({ spec }) => { const p = resolveSpec(file, spec); return p && reaches(p); });
  memo.set(file, hit);
  return hit;
}

const SETS = (src, name) => new RegExp(`process\\.env\\.${name}\\s*=`).test(src);
export function violation(file, src) {
  const list = imports(src).map((i) => ({ ...i, path: resolveSpec(file, i.spec) }));
  const hits = list.filter((i) => i.path && reaches(i.path));
  if (!hits.length) return null;
  const first = list[0];
  if (first && !first.dynamic && HELPER.test(first.spec)) return null;
  const staticHit = hits.find((i) => !i.dynamic);
  if (staticHit) return `static import ${staticHit.spec} reaches a store, and the first import is not the helper`;
  const before = src.slice(0, hits[0].at);
  const token = SETS(before, "TOUCHSTONE_GRANT_TOKEN") || SETS(before, "TOUCHSTONE_GRANT_TOKEN_FILE");
  if (token && SETS(before, "TOUCHSTONE_GRANTS_FILE") && SETS(before, "TOUCHSTONE_SCOPES_FILE")) return null;
  return `dynamic import ${hits[0].spec} reaches a store before the token, grants and scopes env are set`;
}

function testFiles() {
  const out = [];
  for (const [dir, re] of [["spike/test", /\.test\.mjs$/], ["app/tests", /\.test\.tsx?$/]]) {
    for (const n of readdirSync(join(ROOT, dir)).sort()) if (re.test(n)) out.push(join(ROOT, dir, n));
  }
  // This file names store imports inside its own test strings.
  return out.filter((f) => f !== fileURLToPath(import.meta.url));
}

test("the guard sees the stores: it is not blind", () => {
  const f = join(ROOT, "spike/test/grant-store.test.mjs");
  assert.ok(reaches(f), "grant-store.test.mjs must reach grant-store");
  // A file whose first import is the helper passes; the same file without it fails.
  const fake = join(ROOT, "spike/test/fake.test.mjs");
  assert.equal(violation(fake, 'import "./helpers/isolated-env.mjs";\nimport x from "../lib/grant-store.mjs";\n'), null);
  assert.match(violation(fake, 'import x from "../lib/grant-store.mjs";\n'), /static import/);
  assert.match(violation(fake, 'process.env.TOUCHSTONE_GRANTS_FILE = "g";\nimport x from "../lib/grant-store.mjs";\n'), /static import/);
  assert.match(violation(fake, 'const m = await import("../lib/grant-store.mjs");\n'), /dynamic import/);
  assert.equal(violation(fake, 'process.env.TOUCHSTONE_GRANT_TOKEN = "t";\nprocess.env.TOUCHSTONE_GRANTS_FILE = "g";\nprocess.env.TOUCHSTONE_SCOPES_FILE = "s";\nconst m = await import("../lib/grant-store.mjs");\n'), null);
});

// Files of open cloud PRs: closed to this branch (RULES.md). Each needs the
// same one-line fix; until its PR lands it is named here, not hidden.
const CLOSED = {
  "spike/test/harm-gate.test.mjs": "open cloud PR file; needs import \"./helpers/isolated-env.mjs\" first",
  "app/tests/report.test.ts": "open cloud PR file; needs import \"./helpers/isolated-env\" first",
};

test("every test that loads the grant or scope store isolates them first", () => {
  const bad = [];
  for (const f of testFiles().filter((x) => !CLOSED[x.slice(ROOT.length + 1)])) {
    const why = violation(f, readFileSync(f, "utf8"));
    if (why) bad.push(`${f.slice(ROOT.length + 1)}: ${why}`);
  }
  assert.deepEqual(bad, [], "make the helper the first import (spike: import \"./helpers/isolated-env.mjs\"; app: import \"./helpers/isolated-env\")");
});

test("each closed exception still needs it (remove the entry once its PR adds the helper)", () => {
  for (const rel of Object.keys(CLOSED)) {
    const f = join(ROOT, rel);
    assert.ok(violation(f, readFileSync(f, "utf8")), `${rel} is isolated now: remove it from CLOSED`);
  }
});
