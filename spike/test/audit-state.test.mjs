import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditState } from "../lib/audit-state.mjs";

test("proof attempts, passing sources and submitted findings survive a worker restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-state-"));
  try {
    const file = join(dir, "run.audit.json");
    const first = auditState(file);
    first.poc++;
    first.passed.set("test", { source: "real proof source" });
    first.found.push({ n: 1, title: "Finding", source: "real proof source" });
    const second = auditState(file);
    assert.equal(second.poc, 1);
    assert.deepEqual(second.passed.get("test"), { source: "real proof source" });
    assert.deepEqual([...second.found], [{ n: 1, title: "Finding", source: "real proof source" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
