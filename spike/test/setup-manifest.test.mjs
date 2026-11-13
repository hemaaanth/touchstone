// The setup manifest (scripts/setup.mjs) is the one list a fresh machine builds
// from. Each pack image the code runs must be on it, with a recipe that exists;
// a Docker tool missing from it cannot be provisioned, so `--dry-run` would not
// list it and a fresh machine would silently lack it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
