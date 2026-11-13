// The run record keeps every recorded lead. The stream below is a small,
// hand-written Review run in the shape the server writes: a child records two
// leads, then the server stops before the run settles. Loading it must write a
// record whose result.leads holds both leads with their evidence, and no lead
// may read as proven.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ID = "faux-review-2611120000-1";
const dir = mkdtempSync(join(tmpdir(), "run-leads-"));
const t0 = 1794525839389;
const stream = [
  { t: t0, ev: "scope", scope: { id: "s-ens", title: "ens-metadata-service", kind: "repo", pack: "review", entry: "ensdomains/ens-metadata-service", proofSurface: { kind: "none" } } },
  { t: t0, ev: "mode", mode: "fleet" },
  { t: t0, ev: "status", status: "running", pending: null, decision: null },
  { t: t0 + 10, ev: "subagent-spawned", agent: "a-44", id: "a-44", name: "ssrf-egress" },
  { t: t0 + 20, ev: "lead", agent: "a-44", id: "lead-1a2b3c4d", severity: "high", file: "vendor/ens/src/avatar.ts", line: 88, title: "SSRF via avatar URL", reason: "the URL from the text record goes to fetch with no host check", proof: "point the record at 169.254.169.254" },
  { t: t0 + 30, ev: "lead", agent: "a-52", id: "lead-5e6f7a8b", severity: "medium", file: "vendor/ens/src/svg.ts", line: 12, title: "SVG script passes through", reason: "no sanitizer on the rendered SVG" },
];
writeFileSync(join(dir, `run-${ID}.stream.jsonl`), stream.map((e) => JSON.stringify(e)).join("\n") + "\n");
process.env.TOUCHSTONE_RESULTS_DIR = dir;
const { getRun } = await import("../../app/server/runs.mjs");

test("an interrupted Review run's record keeps its leads with file, line and reason", () => {
  const file = join(dir, `run-${ID}.json`);
  assert.ok(existsSync(file), "run-<id>.json was written");
  const { result } = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(result.outcome, "error");
  assert.deepEqual(result.findings, []);
  assert.equal(result.recorded, false);
  assert.ok(Array.isArray(result.leads), "result.leads is a list");
  assert.deepEqual(result.leads.map((l) => [l.id, l.severity, l.file, l.line, l.agent]), [
    ["lead-1a2b3c4d", "high", "vendor/ens/src/avatar.ts", 88, "a-44"],
    ["lead-5e6f7a8b", "medium", "vendor/ens/src/svg.ts", 12, "a-52"],
  ]);
  assert.equal(result.leads[0].reason, "the URL from the text record goes to fetch with no host check");
  assert.ok(result.leads.every((l) => !("proven" in l)), "no lead reads as proven");
});

test("the loaded run reads as an error with no finding; its stream still holds the leads", () => {
  const run = getRun(ID);
  assert.equal(run.status, "error");
  assert.equal(run.events.filter((e) => e.ev === "lead").length, 2);
  rmSync(dir, { recursive: true, force: true });
});
