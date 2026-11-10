// Aderyn runs in Docker. This test needs the image (tools/build-aderyn-image.sh)
// and skips when it is not built.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { aderynScan } from "../lib/aderyn.mjs";
import { makeWorkspace, cleanupWorkspace } from "../lib/sandbox.mjs";

const hasImage = (() => {
  try { execFileSync("docker", ["image", "inspect", "touchstone/aderyn:0.6.8"], { stdio: "ignore" }); return true; } catch { return false; }
})();

test("Aderyn finds the reentrancy lead on the vault lab and leaves the workspace clean", { skip: !hasImage && "image not built" }, async () => {
  const ws = makeWorkspace(new URL("../../lab/vault-reentrancy", import.meta.url).pathname);
  try {
    const before = readdirSync(ws).sort();
    const scan = await aderynScan(ws);
    assert.equal(scan.available, true);
    assert.ok(scan.leads.some((l) => l.check === "reentrancy-state-change" && l.file === "src/Vault.sol" && l.engine === "Aderyn"));
    assert.deepEqual(readdirSync(ws).sort(), before);
  } finally { cleanupWorkspace(ws); }
});

test("Aderyn reports unavailable, not clean, when the image is missing", async () => {
  process.env.ADERYN_IMAGE = "touchstone/aderyn:does-not-exist";
  try {
    const mod = await import("../lib/aderyn.mjs?missing");
    const scan = await mod.aderynScan("/tmp", { timeoutMs: 20_000 });
    assert.equal(scan.available, false);
    assert.deepEqual(scan.leads, []);
  } finally { delete process.env.ADERYN_IMAGE; }
});
