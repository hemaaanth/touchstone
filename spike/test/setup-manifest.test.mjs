// The setup manifest (scripts/setup.mjs) is the one list a fresh machine builds
// from. Each pack image the code runs must be on it, with a recipe that exists;
// a Docker tool missing from it cannot be provisioned, so `--dry-run` would not
// list it and a fresh machine would silently lack it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { MANIFEST } from "../scripts/setup.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SETUP = join(ROOT, "spike/scripts/setup.mjs");
const imageIn = (file) => readFileSync(join(ROOT, file), "utf8").match(/const IMAGE = process\.env\.\w+ \|\| "([^"]+)"/)[1];

// ---- contracts images (Halmos, Chimera)

for (const [name, file, recipe] of [
  ["Halmos", "spike/packs/contracts/halmos.mjs", "Dockerfile.halmos"],
  ["Chimera", "spike/packs/contracts/chimera.mjs", "Dockerfile.chimera"],
]) {
  test(`the ${name} image the pack runs is a contracts build in the setup manifest, with the build.sh recipe`, () => {
    const tag = imageIn(file);
    const item = MANIFEST.find((m) => m.tag === tag);
    assert.ok(item, `${tag} is not in the setup manifest`);
    assert.equal(item.group, "contracts");
    assert.equal(item.kind, "build");
    assert.ok(!item.optional, "a default setup must build it");
    // The same Dockerfile and context as images/build.sh.
    assert.equal(item.file, `spike/packs/contracts/images/${recipe}`);
    assert.equal(item.context, "spike/packs/contracts/images");
    assert.ok(existsSync(join(ROOT, item.file)));
    assert.match(readFileSync(join(ROOT, "spike/packs/contracts/images/build.sh"), "utf8"), new RegExp(`-f ${recipe} -t ${tag.replace(/\./g, "\\.")} \\.`));
  });
}

test("setup --list prints both images; importing the manifest runs nothing", () => {
  const out = execFileSync(process.execPath, [SETUP, "--list", "--only=contracts"], { encoding: "utf8" });
  assert.match(out, /build touchstone\/halmos:0\.3\.3\n/);
  assert.match(out, /build touchstone\/chimera:e2\.3\.3-m1\.5\.1\n/);
});

test("every contracts build in the manifest names a context and Dockerfile that exist", () => {
  for (const m of MANIFEST.filter((x) => x.kind === "build" && x.group === "contracts")) {
    assert.ok(existsSync(join(ROOT, m.context)), `${m.tag}: ${m.context}`);
    assert.ok(existsSync(join(ROOT, m.file ?? join(m.context, "Dockerfile"))), `${m.tag}: ${m.file}`);
  }
});

// ---- web images (Schemathesis, jwt_tool)
//
// `--list` prints the manifest and runs no docker commands, so these tests are
// hermetic: they assert the list, not the machine's current image state.
const list = execFileSync(process.execPath, [SETUP, "--list"], { encoding: "utf8" });

test("setup manifest lists the web schemathesis image", () => {
  assert.match(list, /build touchstone\/web-schemathesis:4\.33\.4/);
});

test("setup manifest lists the web jwt_tool image", () => {
  assert.match(list, /build touchstone\/web-jwt-tool:2\.3\.0/);
});

test("both new web images sit in the web group, as build recipes", () => {
  const web = list.slice(list.indexOf("\nweb\n"));
  const nextGroup = web.indexOf("\nai-mcp\n");
  const webBlock = nextGroup > 0 ? web.slice(0, nextGroup) : web;
  assert.ok(webBlock.includes("touchstone/web-schemathesis:4.33.4"), "schemathesis in web group");
  assert.ok(webBlock.includes("touchstone/web-jwt-tool:2.3.0"), "jwt_tool in web group");
});

// ---- flags (L14): a value flag takes both forms

test("setup --only takes both forms: --only=a,b and --only a,b", () => {
  for (const args of [["--only=web,contracts"], ["--only", "web,contracts"]]) {
    const out = execFileSync(process.execPath, [SETUP, "--list", ...args], { encoding: "utf8" });
    const groups = out.split("\n").filter((l) => /^[a-z]/.test(l) && !/ images\.$/.test(l));
    assert.deepEqual(groups, ["contracts", "web"], `groups for ${args.join(" ")}`);
  }
});

// ---- recipes (L14): every build recipe exists

test("every build in the manifest names a context and Dockerfile that exist", () => {
  for (const m of MANIFEST.filter((x) => x.kind === "build")) {
    assert.ok(existsSync(join(ROOT, m.context)), `${m.tag}: context ${m.context}`);
    assert.ok(existsSync(join(ROOT, m.file ?? join(m.context, "Dockerfile"))), `${m.tag}: ${m.file}`);
  }
});

// ---- coverage (L14): every image the code can run is in the manifest
//
// Scans every string literal in the code (spike/ without its tests, and
// app/server) that has the shape of an image reference, and every public image
// a test runs. A new tool whose image is not in the manifest fails here.

const SKIP_DIRS = new Set(["node_modules", "results", "data", "fixtures", ".git", "dist"]);
function* sources(dir, { tests = false } = {}) {
  for (const n of readdirSync(dir)) {
    if (SKIP_DIRS.has(n) || (!tests && n === "test")) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) yield* sources(p, { tests });
    else if (/\.(mjs|js|cjs)$/.test(n)) yield p;
  }
}
const LITERAL = /(["'`])((?:[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*(?::[A-Za-z0-9][A-Za-z0-9._-]{0,127})?(?:@sha256:[0-9a-f]{64})?)\1/g;
// Split "repo:tag@sha256:…" into its parts.
function parseRef(s) {
  const at = s.indexOf("@sha256:");
  const name = at >= 0 ? s.slice(0, at) : s;
  const c = name.lastIndexOf(":");
  const hasTag = c > name.lastIndexOf("/");
  return { repo: hasTag ? name.slice(0, c) : name, tag: hasTag ? name.slice(c + 1) : "", digest: at >= 0 ? s.slice(at + 1) : "" };
}
function looksLikeImage(s) {
  const { repo, tag, digest } = parseRef(s);
  if (!tag && !digest) return false;
  if (/\.(m?js|ts|json|ya?ml|txt|sol)$/.test(repo)) return false;
  if (!repo.includes("/")) return /^touchstone-/.test(repo) || (/^[a-z][a-z0-9-]*$/.test(repo) && /^\d/.test(tag) && !/^\d+$/.test(tag));
  return /^[a-z]/.test(repo);
}
function imagesIn(files) {
  const found = new Map();
  for (const f of files) {
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // a comment names images as examples
      for (const m of line.matchAll(LITERAL)) {
        if (looksLikeImage(m[2]) && !found.has(m[2])) found.set(m[2], `${f.slice(ROOT.length + 1)}:${i + 1}`);
      }
    });
  }
  return found;
}
const SETUP_FILE = join(ROOT, "spike/scripts/setup.mjs");
const codeImages = imagesIn([...sources(join(ROOT, "spike")), ...sources(join(ROOT, "app/server"))].filter((f) => f !== SETUP_FILE));
// This file names images in its own exception lists; it is the guard, not a user.
const testImages = imagesIn([...sources(join(ROOT, "spike/test"), { tests: true })].filter((f) => f !== fileURLToPath(import.meta.url)));

// Named in the code but never run on this host, each with its reason.
const NOT_RUN_HERE = {
  "docker:28.5.1-dind": "daytona.mjs: the Daytona snapshot base; Daytona pulls it on the remote machine",
};

test("the scan finds the images the code runs (it is not empty or blind)", () => {
  for (const ref of ["touchstone/web-lab:dev", "coredns/coredns:1.12.0@sha256:40384aa1f5ea6bfdc77997d243aec73da05f27aed0c5e9d65bfa98933c519d97"]) {
    assert.ok(codeImages.has(ref), `scan missed ${ref}`);
  }
  assert.ok(codeImages.size > 40, `only ${codeImages.size} images found`);
});

test("every image the code can run is in the setup manifest", () => {
  const known = new Set(MANIFEST.flatMap((m) => [m.tag, m.ref].filter(Boolean)));
  const missing = [...codeImages].filter(([ref]) => !known.has(ref) && !NOT_RUN_HERE[ref]).map(([ref, at]) => `${ref} (${at})`);
  assert.deepEqual(missing, [], "add these to spike/scripts/setup.mjs");
});

test("every public image a test runs is in the setup manifest", () => {
  const known = new Set(MANIFEST.flatMap((m) => [m.tag, m.ref].filter(Boolean)));
  const missing = [...testImages]
    .filter(([ref]) => !/^touchstone/.test(ref) && !known.has(ref) && !NOT_RUN_HERE[ref])
    .map(([ref, at]) => `${ref} (${at})`);
  assert.deepEqual(missing, [], "add these to spike/scripts/setup.mjs");
});

// ---- pins (L9): a run cannot silently use a newer image

test("every pulled image in the manifest is pinned by digest", () => {
  const loose = MANIFEST.filter((m) => m.kind === "pull" && !/@sha256:[0-9a-f]{64}$/.test(m.ref)).map((m) => m.tag);
  assert.deepEqual(loose, [], "pin these by digest: docker image inspect --format '{{json .RepoDigests}}' <image>");
});

test("the code runs a pulled image only by its pinned ref, never by tag alone", () => {
  const builds = new Set(MANIFEST.filter((m) => m.kind === "build").map((m) => m.tag));
  const pinned = new Set(MANIFEST.filter((m) => m.kind === "pull").map((m) => m.ref));
  const loose = [...codeImages].filter(([ref]) => !builds.has(ref) && !pinned.has(ref) && !NOT_RUN_HERE[ref]).map(([ref, at]) => `${ref} (${at})`);
  assert.deepEqual(loose, [], "use the manifest's pinned ref");
});

// Base images of local builds that are NOT on this host and have no digest
// recorded anywhere in the repo. Pinning them needs one pull (thread 1e).
const UNPINNED_BASES = {
  "alpine:3.21": "spike/packs/web/Dockerfile.ffuf: not on this host, no recorded digest",
  "oven/bun:1.4.4": "spike/packs/keys/runtime/Dockerfile: not on this host, no recorded digest",
};

test("every local build pins its base images by digest (named exceptions only)", () => {
  const loose = [];
  for (const m of MANIFEST.filter((x) => x.kind === "build")) {
    const file = join(ROOT, m.file ?? join(m.context, "Dockerfile"));
    const stages = new Set();
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const f = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
      if (!f) continue;
      const [, image, alias] = f;
      if (!stages.has(image) && image !== "scratch" && !/@sha256:[0-9a-f]{64}$/.test(image) && !UNPINNED_BASES[image]) loose.push(`${image} (${file.slice(ROOT.length + 1)})`);
      if (alias) stages.add(alias);
    }
  }
  assert.deepEqual(loose, []);
});

// setup pulls `repo:tag@sha256:…`, which docker stores without the short tag.
// It then adds the tag (a check by tag must find the pinned image), but never
// moves a tag that already exists. Proven with a docker shim, no real docker.
test("setup tags a pinned pull with its short tag, and leaves an existing tag alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "setup-shim-"));
  try {
    const log = join(dir, "calls");
    // `image inspect` fails for everything except alpine:3.20 (an existing tag).
    writeFileSync(join(dir, "docker"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "' + log + '"\n' +
      'if [ "$1" = image ] && [ "$2" = inspect ]; then [ "$3" = "alpine:3.20" ] && exit 0; exit 1; fi\nexit 0\n',
      { mode: 0o755 });
    execFileSync(process.execPath, [SETUP, "--only", "base", "--include-optional", "--jobs", "1"], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8" });
    const calls = readFileSync(log, "utf8").trim().split("\n");
    const node = MANIFEST.find((m) => m.tag === "node:20-slim");
    const alpine = MANIFEST.find((m) => m.tag === "alpine:3.20");
    assert.ok(calls.includes(`pull ${node.ref}`), "pulls the pinned ref");
    assert.ok(calls.includes(`tag ${node.ref} node:20-slim`), "tags it with its short tag");
    assert.ok(calls.includes(`pull ${alpine.ref}`));
    assert.ok(!calls.some((c) => c.startsWith("tag ") && c.endsWith(" alpine:3.20")), "never moves an existing tag");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Review m2: a default setup must not pull an image it did not pull before.
// alpine:3.20 is run only by two capture-mode tests (they skip without it), so
// it is optional: listed with --include-optional, left out without flags.
test("alpine:3.20 is optional: a setup with no flags does not select it", () => {
  const plain = execFileSync(process.execPath, [SETUP, "--list"], { encoding: "utf8" });
  const all = execFileSync(process.execPath, [SETUP, "--list", "--include-optional"], { encoding: "utf8" });
  assert.doesNotMatch(plain, /pull {2}alpine:3\.20/);
  assert.match(all, /pull {2}alpine:3\.20 {2}\(optional\)/);
});
