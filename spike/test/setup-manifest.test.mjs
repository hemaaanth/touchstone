// The setup manifest (scripts/setup.mjs) is the single source of truth for the
// Docker images each pack needs. A pack tool that runs in Docker but is missing
// from the manifest cannot be provisioned by `setup.mjs`, so `--dry-run` would
// not list it and a fresh machine would silently lack it. This test pins that
// the web pack's two python-based tool images -- schemathesis and jwt_tool --
// are in the manifest, so `--list`/`--dry-run` enumerate them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SETUP = resolve(HERE, "..", "scripts", "setup.mjs");

// `--list` prints the manifest and runs no docker commands, so the test is
// hermetic: it asserts the list, not the machine's current image state.
const list = execFileSync("node", [SETUP, "--list"], { encoding: "utf8" });

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
