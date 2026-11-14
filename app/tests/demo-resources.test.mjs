import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("demo producers, separate daemon resources, and restart cleanup use private real OS roundtrips", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "demo-resource-suite-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = fileURLToPath(new URL("./helpers/demo-resources-fixture.mjs", import.meta.url));
  const output = execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--test", fixture], {
    cwd: dir, timeout: 90000, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, DEMO_TEST_ROOT: dir },
  });
  console.log(output.trim());
  assert.match(output, /# fail 0|ℹ fail 0/);
});
