import "./helpers/isolated-env.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import * as child from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

test("every packaged demo prepares an editable workspace and cleans up", {
  skip: !process.env.TOUCHSTONE_TEST_RELEASE && "set TOUCHSTONE_TEST_RELEASE to a prepared immutable release",
}, async () => {
  const release = realpathSync(process.env.TOUCHSTONE_TEST_RELEASE);
  const scratch = mkdtempSync(join(tmpdir(), "packaged-workspaces-"));
  const previous = process.env.TMPDIR;
  const originalFetch = globalThis.fetch;
  const unexpected = () => { throw Error("Unexpected external tool or network call during workspace preparation"); };
  const context = mock.module("node:child_process", { exports: {
    ...child,
    execFileSync: (command, ...args) => command === "git" ? child.execFileSync(command, ...args) : unexpected(),
    execFile: unexpected, spawn: unexpected,
  } });
  function writable(path) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    chmodSync(path, stat.mode | 0o200);
    if (stat.isDirectory()) for (const name of readdirSync(path)) writable(join(path, name));
  }
  try {
    process.env.TMPDIR = scratch;
    globalThis.fetch = unexpected;
    const { listTargets, getTarget, prepareRunWorkspace } = await import(pathToFileURL(join(release, "spike/lib/targets.mjs")).href);
    const demos = listTargets().filter((target) => target.kind === "lab");
    assert.ok(demos.length >= 14, "the complete built-in demo catalog must be present");
    const failures = [];
    for (const demo of demos) {
      try {
        const ws = await prepareRunWorkspace(getTarget(demo.id));
        assert.equal(dirname(realpathSync(ws)), realpathSync(scratch), "workspace must stay in the private scratch folder");
        rmSync(ws, { recursive: true });
      } catch (error) {
        failures.push({ id: demo.id, code: error.code ?? error.name, syscall: error.syscall ?? null });
      }
    }
    assert.deepEqual(failures, []);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    context.restore();
    writable(scratch);
    rmSync(scratch, { recursive: true, force: true });
  }
});
