import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("sealed templates do not discard successful scanner results during cleanup", async (t) => {
  if (process.getuid() === 0) return t.skip("requires non-root to detect read-only directory cleanup failures");
  const root = mkdtempSync(join(tmpdir(), "sealed-web-scan-"));
  const pack = join(root, "packs", "web");
  const templates = join(pack, "scan", "templates");
  let scratch;
  try {
    mkdirSync(join(root, "lib"), { recursive: true });
    mkdirSync(join(pack, "scan"), { recursive: true });
    // The real scanner module, with a hard failure if it bypasses the injected tool runner.
    writeFileSync(join(root, "lib", "wrap.mjs"), "export function runTool() { throw new Error('Unexpected Docker operation'); }\n");
    copyFileSync(new URL("../packs/web/scan.mjs", import.meta.url), join(pack, "scan.mjs"));
    cpSync(new URL("../packs/web/scan/templates", import.meta.url), templates, { recursive: true });
    for (const name of readdirSync(templates)) chmodSync(join(templates, name), 0o400);
    chmodSync(templates, 0o500);
    // The fixture is a separate sealed module location, as in a packaged release.
    const { scanWeb } = await import(pathToFileURL(join(pack, "scan.mjs")).href);
    const result = await scanWeb({
      net: "fixture-only-no-network", baseUrl: "https://allowed.test",
      run: async ({ image, ws }) => {
        scratch = ws;
        if (image.includes("zaproxy")) writeFileSync(join(ws, "zap.json"), JSON.stringify({ site: [] }));
        if (image.includes("nuclei")) writeFileSync(join(ws, "nuclei.jsonl"), JSON.stringify({ "template-id": "fixture-header", info: { name: "Fixture header", severity: "low" }, "matched-at": "https://allowed.test/" }) + "\n");
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    assert.equal(result.coverage.find((c) => c.engine === "nuclei").status, "ran");
    assert.ok(result.leads.some((lead) => lead.check === "fixture-header"));
    assert.equal(existsSync(scratch), false, "the completed scan removes its scratch directory");
    assert.equal(statSync(templates).mode & 0o777, 0o500, "sealed source permissions do not change");
  } finally {
    if (scratch && existsSync(scratch)) {
      if (existsSync(join(scratch, "templates"))) chmodSync(join(scratch, "templates"), 0o700);
      rmSync(scratch, { recursive: true, force: true });
    }
    if (existsSync(templates)) chmodSync(templates, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});
