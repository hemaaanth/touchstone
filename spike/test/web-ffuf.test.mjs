// Tests for the Web pack's ffuf content-discovery tool (packs/web/ffuf.mjs).
// The parser is a pure function over ffuf's JSON, so most tests need no Docker.
// The runner is tested with a mock `run` (no Docker). The last test runs ffuf
// for real against the lab and shows it finds a route the other three prepass
// tools (zap, nuclei, dalfox) miss. It skips when an image is not built.
//
//   node --experimental-test-module-mocks --test test/web-ffuf.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFfuf, scanFfuf, FFUF_IMAGE } from "../packs/web/ffuf.mjs";
import web from "../packs/web/pack.mjs";
import { makeWorkspace, cleanupWorkspace } from "../lib/sandbox.mjs";

// A ffuf result row. ffuf's default matcher already drops 404, but we assert the
// parser drops 404 too so a mis-run that captures everything stays honest.
const row = (fuzz, status, length = 100) => ({
  input: { FUZZ: fuzz }, position: 1, status, length, words: 1, lines: 1,
  "content-type": "application/json", url: `http://lab:8080/${fuzz}`, host: "lab:8080",
});
const ffufJson = (...rows) => JSON.stringify({ commandline: "ffuf", time: "now", results: rows });

// ---- parser (pure) ---------------------------------------------------------

test("parseFfuf: a served path becomes a content-discovery lead, sensitive ones rank higher", () => {
  const leads = parseFfuf(ffufJson(
    row("internal/metrics", 200, 180),   // sensitive + reachable -> Medium
    row("healthz", 200, 15),             // reachable, not sensitive -> Low
    row("api/me", 401, 20),              // gated -> Informational
  ));
  const byPath = Object.fromEntries(leads.map((l) => [l.path, l]));
  assert.equal(byPath["/internal/metrics"].impact, "Medium");
  assert.equal(byPath["/internal/metrics"].check, "content-discovery");
  assert.equal(byPath["/internal/metrics"].engine, "ffuf");
  assert.equal(byPath["/internal/metrics"].status, 200);
  assert.equal(byPath["/healthz"].impact, "Low");
  assert.equal(byPath["/api/me"].impact, "Informational");
});

test("parseFfuf: 404s are dropped and each path yields at most one lead", () => {
  const leads = parseFfuf(ffufJson(
    row("admin", 404),                   // not there -> dropped
    row("internal/metrics", 200),
    row("internal/metrics", 200),        // duplicate path -> one lead
  ));
  assert.equal(leads.length, 1);
  assert.equal(leads[0].path, "/internal/metrics");
});

test("parseFfuf: no body field is ever copied into a lead (secrets stay out)", () => {
  const leads = parseFfuf(ffufJson(row("internal/debug/config", 200, 220)));
  assert.doesNotMatch(JSON.stringify(leads), /signerPrivateKey|0x[0-9a-f]{64}/i);
});

test("parseFfuf: garbage or empty input returns no leads, never throws", () => {
  assert.deepEqual(parseFfuf(""), []);
  assert.deepEqual(parseFfuf("{not json"), []);
  assert.deepEqual(parseFfuf("{}"), []);
  assert.deepEqual(parseFfuf(JSON.stringify({ results: null })), []);
});

// ---- runner (mock run, no Docker) ------------------------------------------

// A mock that writes a canned ffuf.json into the scratch dir, like ffuf would.
const mockWrite = (json, code = 0) => async ({ ws }) => {
  writeFileSync(join(ws, "ffuf.json"), json);
  return { code, stdout: "", stderr: "" };
};

test("scanFfuf: a clean run reports ran with its parsed leads", async () => {
  const r = await scanFfuf({
    net: "netx", baseUrl: "http://lab:8080",
    run: mockWrite(ffufJson(row("internal/metrics", 200), row("healthz", 200))),
  });
  assert.equal(r.coverage.length, 1);
  assert.equal(r.coverage[0].engine, "ffuf");
  assert.equal(r.coverage[0].status, "ran");
  assert.equal(r.coverage[0].leads, 2);
  assert.ok(r.leads.some((l) => l.path === "/internal/metrics"));
});

test("scanFfuf: a failed run with no output is unavailable, not a clean result", async () => {
  const r = await scanFfuf({
    net: "netx", baseUrl: "http://lab:8080",
    run: async () => ({ code: 1, stdout: "", stderr: "connection refused" }),
  });
  assert.equal(r.coverage[0].status, "unavailable");
  assert.equal(r.coverage[0].code, 1);
  assert.equal(r.leads.length, 0);
  assert.match(r.coverage[0].reason, /connection refused/);
});

test("scanFfuf: a timeout is reported unavailable with timedOut set", async () => {
  const r = await scanFfuf({
    net: "netx", baseUrl: "http://lab:8080",
    run: async () => ({ code: 143, stdout: "", stderr: "", timedOut: true }),
  });
  assert.equal(r.coverage[0].status, "unavailable");
  assert.equal(r.coverage[0].timedOut, true);
  assert.match(r.coverage[0].reason, /timed out/);
});

// ---- real run against the lab ----------------------------------------------

const hasImages = (() => {
  try {
    for (const img of ["touchstone/web-lab:dev", FFUF_IMAGE]) {
      execFileSync("docker", ["image", "inspect", img], { stdio: "ignore" });
    }
    return true;
  } catch { return false; }
})();
const LAB = new URL("../packs/web/lab/dapp", import.meta.url).pathname;

test("ffuf real run: the full prepass finds /internal/metrics, a route the other three tools miss",
  { skip: !hasImages && "web-lab or web-ffuf image not built", timeout: 600_000 }, async () => {
  const ws = makeWorkspace(LAB);
  try {
    const prep = await web.prepass(ws);

    // ffuf ran as part of the real prepass, through the real runTool and Docker.
    const cov = Object.fromEntries(prep.record.coverage.map((c) => [c.engine, c.status]));
    assert.equal(cov.ffuf, "ran", JSON.stringify(prep.record.coverage));

    // The planted undocumented, unlinked route is in the leads...
    const metrics = prep.record.leads.find((l) => l.path === "/internal/metrics");
    assert.ok(metrics, "ffuf should discover /internal/metrics");
    assert.equal(metrics.status, 200);
    assert.equal(metrics.check, "content-discovery");

    // ...and ONLY ffuf found it. The three scanners in scan.mjs (zap spider,
    // nuclei templates, dalfox) never reach an unlinked, untemplated path with
    // no query, so this is something the pack did not find before ffuf.
    assert.deepEqual(metrics.engines, ["ffuf"], `only ffuf should find it; got ${JSON.stringify(metrics.engines)}`);

    // No raw secret is ever carried in a lead.
    assert.doesNotMatch(JSON.stringify(prep), /signerPrivateKey"\s*:\s*"0x/);

    // Written leads file on disk matches (what the agent reads back).
    const onDisk = JSON.parse(readFileSync(join(ws, ".web-leads.json"), "utf8"));
    assert.ok(onDisk.leads.some((l) => l.path === "/internal/metrics"));
  } finally {
    cleanupWorkspace(ws);
  }
});
