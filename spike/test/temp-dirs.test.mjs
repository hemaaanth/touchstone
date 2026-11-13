// lib/temp-dirs.mjs: a tracked temp folder does not outlive a killed process,
// and the process still dies by the signal. No Docker.
//
//   node --test spike/test/temp-dirs.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTempDir, trackTempDir, trackedTempDirs } from "../lib/temp-dirs.mjs";

const MOD = fileURLToPath(new URL("../lib/temp-dirs.mjs", import.meta.url));

test("removeTempDir removes the folder and drops the signal handlers", () => {
  const before = process.listenerCount("SIGTERM");
  const dir = trackTempDir(mkdtempSync(join(tmpdir(), "temp-dirs-test-")));
  assert.equal(process.listenerCount("SIGTERM"), before + 1);
  assert.ok(trackedTempDirs().includes(dir));
  removeTempDir(dir);
  assert.equal(existsSync(dir), false);
  assert.equal(process.listenerCount("SIGTERM"), before);
});

for (const [name, extra] of [["alone", ""], ["after another handler that does not re-raise", "process.on('SIGTERM', () => {});"]]) {
  test(`a SIGTERM removes the tracked folder (${name}) and the process still dies by it`, async () => {
    // The other handler stands in for lab-net's when it is not alone: it does nothing.
    // With it, this module must not re-raise (a listener is left), and node keeps running;
    // so that case ends the child itself after the folder is gone.
    const child = spawn(process.execPath, ["--input-type=module", "-e",
      `${extra} const { trackTempDir } = await import(${JSON.stringify(MOD)}); const { mkdtempSync } = await import("node:fs");` +
      `const d = trackTempDir(mkdtempSync(${JSON.stringify(join(tmpdir(), "temp-dirs-kill-"))})); console.log(d);` +
      (extra ? `process.on('SIGTERM', () => setTimeout(() => process.exit(7), 50));` : "") + `setInterval(() => {}, 1000);`],
    { stdio: ["ignore", "pipe", "inherit"] });
    const dir = await new Promise((resolve) => { let out = ""; child.stdout.on("data", (d) => { out += d; if (out.includes("\n")) resolve(out.trim()); }); });
    assert.ok(existsSync(dir));
    const end = new Promise((resolve) => child.on("exit", (code, signal) => resolve(signal ?? code)));
    child.kill("SIGTERM");
    assert.equal(await end, extra ? 7 : "SIGTERM");
    assert.equal(existsSync(dir), false, `${dir} left behind`);
  });
}
