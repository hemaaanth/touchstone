// A run never builds an image. Setup builds every image
// (node spike/scripts/setup.mjs). When an image is missing, the pack says which
// image and how to build it. It starts no build.
//
// Every docker call here is a stub. Nothing reaches docker.
//
//   node --test spike/test/no-runtime-build.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { IMAGE, ensureImage, missingImage } from "../packs/domains/checks.mjs";
import { JSLUICE, ensureJsluice } from "../packs/domains/live.mjs";
import * as keys from "../packs/keys/common.mjs";

const SETUP = /Run node spike\/scripts\/setup\.mjs to build it/;

test("the domains tools image: a missing image is an error that names it, with no build", () => {
  const calls = [];
  const missing = (cmd, args) => { calls.push([cmd, ...args].join(" ")); throw new Error("No such image"); };
  assert.throws(() => ensureImage(missing), (e) => e.message.includes(IMAGE) && SETUP.test(e.message));
  assert.deepEqual(calls, [`docker image inspect ${IMAGE}`]);
  assert.equal(missingImage("x:1"), "The image x:1 is missing. Run node spike/scripts/setup.mjs to build it. A run never builds an image.");
});

test("the jsluice image: a missing image is a coverage reason, with no build", () => {
  const calls = [];
  const reason = ensureJsluice((cmd, args) => { calls.push([cmd, ...args].join(" ")); throw new Error("No such image"); });
  assert.ok(reason.includes(JSLUICE));
  assert.match(reason, SETUP);
  assert.deepEqual(calls, [`docker image inspect ${JSLUICE}`]);
  // A present image is ready: one inspect, nothing else.
  calls.length = 0;
  assert.equal(ensureJsluice((cmd, args) => { calls.push(args.join(" ")); }), null);
  assert.deepEqual(calls, [`image inspect ${JSLUICE}`]);
});

test("the keys and chain-watch lab image: a missing image rejects, with no build", async () => {
  const calls = [];
  const missing = (cmd, args, done) => { calls.push([cmd, ...args].join(" ")); done(new Error("No such image")); };
  await assert.rejects(() => keys.ensureImage(missing), (e) => e.message.includes(keys.IMAGE) && SETUP.test(e.message));
  assert.deepEqual(calls, [`docker image inspect ${keys.IMAGE}`]);
  // A present image resolves after one inspect.
  calls.length = 0;
  await keys.ensureImage((cmd, args, done) => { calls.push(args.join(" ")); done(null); });
  assert.deepEqual(calls, [`image inspect ${keys.IMAGE}`]);
});

// A guard for the next pack: no file under packs/ or lib/ starts `docker build`.
// The one exception is the cosign operator helper. No run path calls it.
test("no pack or lib file starts a docker build, except the cosign operator helper", () => {
  const spike = fileURLToPath(new URL("..", import.meta.url));
  const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules") return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : e.name.endsWith(".mjs") ? [p] : [];
  });
  const builds = ["packs", "lib"].flatMap((d) => files(path.join(spike, d)))
    .filter((f) => /["']docker["']\s*,\s*\[\s*["']build["']/.test(readFileSync(f, "utf8")))
    .map((f) => path.relative(spike, f));
  assert.deepEqual(builds, ["packs/supply-chain/cosign.mjs"]);
  const callers = ["packs", "lib"].flatMap((d) => files(path.join(spike, d)))
    .filter((f) => !f.endsWith("cosign.mjs") && readFileSync(f, "utf8").includes("buildCosignImage"));
  assert.deepEqual(callers, []);
});
