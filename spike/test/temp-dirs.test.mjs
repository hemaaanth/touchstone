// lib/temp-dirs.mjs: a tracked temp folder does not outlive a killed process,
// and the process still dies by the signal. No Docker.
//
//   node --test spike/test/temp-dirs.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
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

// ---- the rule: only a real directory directly inside the real temp folder

// Run fn with TMPDIR pointed at dir (os.tmpdir() reads it on each call).
function withTmpdir(dir, fn) {
  const old = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  try { return fn(); } finally { if (old === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = old; }
}

test("trackTempDir refuses a folder outside the temp folder, a nested folder and a symlink, and deletes none of them", () => {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "temp-dirs-rule-"));
  try {
    const tmp = join(base, "tmp");
    const outside = join(base, "outside");
    const nested = join(tmp, "a", "b");
    const link = join(tmp, "link");
    mkdirSync(outside); mkdirSync(nested, { recursive: true }); symlinkSync(outside, link);
    withTmpdir(tmp, () => {
      for (const dir of [outside, nested, link, join(tmp, "missing")]) {
        assert.throws(() => trackTempDir(dir), /is not a real directory directly inside the temp folder/, dir);
        assert.ok(!trackedTempDirs().includes(dir), `${dir} was tracked`);
      }
    });
    for (const dir of [outside, nested, link]) assert.ok(existsSync(dir), `${dir} was deleted`);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("trackTempDir takes a folder made by mkdtempSync in tmpdir(), also when TMPDIR is a symlinked path", () => {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "temp-dirs-link-"));
  try {
    mkdirSync(join(base, "real"));
    symlinkSync(join(base, "real"), join(base, "tmp-link"));
    withTmpdir(join(base, "tmp-link"), () => {
      const dir = trackTempDir(mkdtempSync(join(tmpdir(), "x-")));
      assert.ok(trackedTempDirs().includes(dir));
      removeTempDir(dir);
      assert.equal(existsSync(dir), false);
    });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// ---- the exit hook and the handlers' life

// A child with its own private TMPDIR; returns { out, end } (end: signal or code).
function child(script, tmp) {
  const p = spawn(process.execPath, ["--input-type=module", "-e",
    `const m = await import(${JSON.stringify(MOD)}); const { mkdtempSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");` +
    `const mk = () => m.trackTempDir(mkdtempSync(join(tmpdir(), "k-")));` + script],
  { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, TMPDIR: tmp } });
  const out = new Promise((resolve) => { let o = ""; p.stdout.on("data", (d) => { o += d; if (o.includes("\n")) resolve(o.trim()); }); });
  const end = new Promise((resolve) => p.on("exit", (code, signal) => resolve(signal ?? code)));
  return { p, out, end };
}
// A failed assertion must not leave the child running (and the test file waiting).
const stop = (c) => { if (c.p.exitCode === null && c.p.signalCode === null) c.p.kill("SIGKILL"); };

test("a process that exits without a signal (a crash) removes its tracked folder: the exit hook", async () => {
  const tmp = mkdtempSync(join(realpathSync(tmpdir()), "temp-dirs-exit-"));
  let c = { p: { exitCode: 0 } };
  try {
    c = child(`const d = mk(); console.log(d); setTimeout(() => process.exit(3), 100);`, tmp);
    const dir = await c.out;
    assert.equal(await c.end, 3);
    assert.equal(existsSync(dir), false, `${dir} left behind after exit`);
  } finally { stop(c); rmSync(tmp, { recursive: true, force: true }); }
});

test("removing one of two tracked folders keeps the handlers: a SIGTERM still removes the other", async () => {
  const tmp = mkdtempSync(join(realpathSync(tmpdir()), "temp-dirs-two-"));
  let c = { p: { exitCode: 0 } };
  try {
    c = child(`const a = mk(); const b = mk(); m.removeTempDir(a); console.log(b + " " + process.listenerCount("SIGTERM")); setInterval(() => {}, 1000);`, tmp);
    const [dir, listeners] = (await c.out).split(" ");
    assert.equal(listeners, "1", "the SIGTERM handler stays while a folder is tracked");
    assert.ok(existsSync(dir));
    c.p.kill("SIGTERM");
    assert.equal(await c.end, "SIGTERM");
    assert.equal(existsSync(dir), false, `${dir} left behind after SIGTERM`);
  } finally { stop(c); rmSync(tmp, { recursive: true, force: true }); }
});
