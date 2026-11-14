import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("real run checkpoint and HTTP records isolate two signed sessions across restart without workers resuming", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "demo-backend-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = fileURLToPath(new URL("./helpers/demo-backend-fixture.mjs", import.meta.url));
  for (const phase of ["write", "read", "missing"]) {
    const output = execFileSync(process.execPath, ["--experimental-test-module-mocks", "--disable-warning=ExperimentalWarning", fixture, phase, directory], {
      cwd: directory, timeout: 15000, encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory },
    });
    const result = JSON.parse(output.trim());
    assert.equal(result.phase, phase); assert.equal(result.ok, true);
    if (phase !== "write") { assert.equal(result.workerCalls, 0); assert.equal(result.workspaceCalls, 0); }
  }
});
