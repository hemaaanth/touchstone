import "./helpers/isolated-env.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { STRIX_SANDBOX_IMAGE } from "../lib/images.mjs";
let missing = new Set();
const checked = [];
mock.module("../lib/reach-confine.mjs", { namedExports: { dockerReady: async () => ({ ok: true }) } });
mock.module("../lib/proof-http.mjs", { namedExports: { requireImage: async (image) => { checked.push(image); if (missing.has(image)) throw new Error("private synthetic detail"); } } });
const { strixReady, STRIX_IMAGE } = await import("../lib/strix.mjs");
for (const absent of [STRIX_IMAGE, STRIX_SANDBOX_IMAGE]) test(`missing ${absent} is unavailable with the working setup command`, async () => {
  missing = new Set([absent]); checked.length = 0;
  const result = await strixReady();
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("node spike/scripts/setup.mjs --only strix --include-optional"));
  assert.ok(!result.reason.includes("private synthetic"));
});
test("Strix is ready only with both of its images", async () => {
  missing = new Set(); checked.length = 0;
  assert.deepEqual(await strixReady(), { ok: true });
  assert.deepEqual(checked, [STRIX_IMAGE, STRIX_SANDBOX_IMAGE]);
});
