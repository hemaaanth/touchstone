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
//     A set is `process.env.NAME = …`, or, in an app test, a call of the
//     helper useEnv (app/tests/helpers/env.ts) whose object names NAME as a
//     plain key: `useEnv({ NAME: … })`. A commented-out line counts for neither.
// The check follows each test's relative imports to the stores, so a new
// test, or a new import chain, that reaches a store is caught here.
//
// lib/providers.mjs is guarded the same way: it reads spike/data/providers.json
// (saved provider keys), so its env is TOUCHSTONE_PROVIDERS_FILE.
//
//   node --test spike/test/test-isolation.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const STORES = ["spike/lib/grant-store.mjs", "spike/lib/scopes-store.mjs"].map((p) => join(ROOT, p));
// The saved provider config (spike/data/providers.json), read through TOUCHSTONE_PROVIDERS_FILE.
const PROVIDERS = join(ROOT, "spike/lib/providers.mjs");
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
// Does loading this file (static and dynamic imports) reach one of targets?
function reacher(targets) {
  const memo = new Map();
  const r = (file) => {
    if (targets.includes(file)) return true;
    if (memo.has(file)) return memo.get(file);
    memo.set(file, false); // a cycle reaches nothing new
    let src = "";
    try { src = readFileSync(file, "utf8"); } catch { return false; }
    const hit = imports(src).some(({ spec }) => { const p = resolveSpec(file, spec); return p && r(p); });
    memo.set(file, hit);
    return hit;
  };
  return r;
}
const reachesStore = reacher(STORES);
const reachesProviders = reacher([PROVIDERS]);
const reaches = (file) => reachesStore(file) || reachesProviders(file);

// Source with its comments taken out: a block comment, or a line whose code is
// only a comment. A commented-out set does not count.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
// The keys each `useEnv({ ... })` call names: a plain or quoted key, never a
// computed one.
const USE_ENV = /\buseEnv\s*\(\s*\{([^{}]*)\}\s*\)/g;
const useEnvKeys = (src) => [...src.matchAll(USE_ENV)].flatMap((m) => [...m[1].matchAll(/(?:^|,)\s*(["']?)([A-Za-z_$][\w$]*)\1\s*:/g)].map((k) => k[2]));
const SETS = (src, name) => new RegExp(`process\\.env\\.${name}\\s*=`).test(code(src)) || useEnvKeys(code(src)).includes(name);
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
  const stores = !hits.some((i) => reachesStore(i.path)) || (token && SETS(before, "TOUCHSTONE_GRANTS_FILE") && SETS(before, "TOUCHSTONE_SCOPES_FILE"));
  const providers = !hits.some((i) => reachesProviders(i.path)) || SETS(before, "TOUCHSTONE_PROVIDERS_FILE");
  if (stores && providers) return null;
  return `dynamic import ${hits[0].spec} reaches a store before the token, grants, scopes and providers env it needs are set`;
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
  // The app helper's form: useEnv({ NAME: … }) above the import is a set.
  const load = 'const m = await import("../lib/grant-store.mjs");\n';
  const token = 'useEnv({ TOUCHSTONE_GRANT_TOKEN: "t" });\n', grants = 'useEnv({ TOUCHSTONE_GRANTS_FILE: g });\n', scopes = 'useEnv({ "TOUCHSTONE_SCOPES_FILE": s });\n';
  assert.equal(violation(fake, token + grants + scopes + load), null);
  assert.equal(violation(fake, 'useEnv({ TOUCHSTONE_GRANT_TOKEN_FILE: f, TOUCHSTONE_GRANTS_FILE: g, TOUCHSTONE_SCOPES_FILE: s });\n' + load), null);
  // Below the import, missing one of the three, commented out, or a computed key: not a set.
  assert.match(violation(fake, token + grants + load + scopes), /dynamic import/);
  assert.match(violation(fake, token + grants + load), /dynamic import/);
  assert.match(violation(fake, token + grants + '// ' + scopes + load), /dynamic import/);
  assert.match(violation(fake, token + grants + '/* ' + scopes + ' */\n' + load), /dynamic import/);
  assert.match(violation(fake, token + grants + 'useEnv({ [name]: s });\n' + load), /dynamic import/);
  assert.match(violation(fake, token + grants + '// process.env.TOUCHSTONE_SCOPES_FILE = "s";\n' + load), /dynamic import/);
});

test("the guard sees the saved provider config: it is not blind", () => {
  const fake = join(ROOT, "spike/test/fake.test.mjs");
  // Direct, and through each module that loads it.
  for (const spec of ["../lib/providers.mjs", "../lib/inference.mjs", "../../app/server/settings.mjs", "../../app/server/runs.mjs", "../lib/daytona.mjs"]) {
    assert.ok(reachesProviders(resolveSpec(fake, spec)), `${spec} must reach providers`);
    assert.match(violation(fake, `import x from "${spec}";\n`), /static import/, spec);
    assert.equal(violation(fake, `import "./helpers/isolated-env.mjs";\nimport x from "${spec}";\n`), null, spec);
  }
  // A dynamic load needs TOUCHSTONE_PROVIDERS_FILE set above it.
  const load = 'const m = await import("../lib/providers.mjs");\n';
  assert.match(violation(fake, load), /dynamic import/);
  assert.match(violation(fake, load + 'process.env.TOUCHSTONE_PROVIDERS_FILE = "p";\n'), /dynamic import/);
  assert.equal(violation(fake, 'process.env.TOUCHSTONE_PROVIDERS_FILE = "p";\n' + load), null);
  // Through a module that also loads the grant store, all four are needed.
  const both = 'const m = await import("../../app/server/settings.mjs");\n';
  const three = 'process.env.TOUCHSTONE_GRANT_TOKEN = "t";\nprocess.env.TOUCHSTONE_GRANTS_FILE = "g";\nprocess.env.TOUCHSTONE_SCOPES_FILE = "s";\n';
  assert.match(violation(fake, three + both), /dynamic import/);
  assert.equal(violation(fake, three + 'process.env.TOUCHSTONE_PROVIDERS_FILE = "p";\n' + both), null);
});

test("every test that loads the grant, scope or provider store isolates them first", () => {
  const bad = [];
  for (const f of testFiles()) {
    const why = violation(f, readFileSync(f, "utf8"));
    if (why) bad.push(`${f.slice(ROOT.length + 1)}: ${why}`);
  }
  assert.deepEqual(bad, [], "make the helper the first import (spike: import \"./helpers/isolated-env.mjs\"; app: import \"./helpers/isolated-env\")");
});
