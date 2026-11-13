// Tests for the Web pack's Schemathesis schema-fuzz tool
// (packs/web/schemathesis.mjs). The report reader and parser are pure functions
// over Schemathesis's JSON run report, so most tests need no Docker. The runner
// is tested with a mock `run` (no Docker). The last test runs Schemathesis for
// real as part of the full prepass against the lab and shows it finds the HTTP
// 500 on GET /api/block/{height} that the other prepass tools (zap, nuclei,
// dalfox, ffuf, arjun) miss. It skips when an image is not built.
//
//   node --experimental-test-module-mocks --test test/web-schemathesis.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSchemathesis,
  schemathesisReport,
  scanSchemathesis,
  SCHEMATHESIS_IMAGE,
} from "../packs/web/schemathesis.mjs";
import web from "../packs/web/pack.mjs";
import { makeWorkspace, cleanupWorkspace } from "../lib/sandbox.mjs";

// Shape of Schemathesis's --report json file: a completed run that tested some
// operations and lists zero or more failures, each naming the operations it hit.
const serverError = (ops) => ({
  type: "ServerError", code: "ST101", title: "Server error",
  severity: "critical", count: ops.length, operations: ops,
});
const report = ({ complete = true, tested = 6, exit_code = 1, failures = [], errored = 0, errors = [], total, extra = {} } = {}) =>
  JSON.stringify({
    schemathesis_version: "4.33.4",
    complete, exit_code, stop_reason: "completed",
    operations: { total: total ?? tested + errored, selected: tested + errored, tested, errored, skipped: 0 },
    test_cases: { generated: 100, with_failures: failures.length, unique_failures: failures.length },
    failures, errors, ...extra,
  });

// ---- report reader (pure) --------------------------------------------------

test("schemathesisReport: a completed run that tested operations is accepted", () => {
  const j = schemathesisReport(report({ failures: [serverError(["GET /api/block/{height}"])] }));
  assert.ok(j, "a complete report with tested>0 is usable");
  assert.equal(j.failures.length, 1);
});

test("schemathesisReport: exit 0 with no failures is a usable (clean) report, not a gap", () => {
  const j = schemathesisReport(report({ exit_code: 0, failures: [] }));
  assert.ok(j, "a clean completed run is still a usable report");
  assert.deepEqual(j.failures, []);
});

test("schemathesisReport: not-complete, zero-tested, non-JSON or missing failures is unusable (null)", () => {
  assert.equal(schemathesisReport(""), null);
  assert.equal(schemathesisReport("{not json"), null);
  assert.equal(schemathesisReport(report({ complete: false })), null);
  assert.equal(schemathesisReport(report({ tested: 0 })), null);
  assert.equal(schemathesisReport(JSON.stringify({ complete: true, operations: { tested: 3 } })), null); // no failures array
});

// ---- parser (pure) ---------------------------------------------------------

test("parseSchemathesis: a ST101 server error becomes a Medium schema-fuzz lead", () => {
  const leads = parseSchemathesis(schemathesisReport(report({ failures: [serverError(["GET /api/block/{height}"])] })));
  assert.equal(leads.length, 1);
  const l = leads[0];
  assert.equal(l.engine, "schemathesis");
  assert.equal(l.check, "schema-fuzz:ST101");
  assert.equal(l.impact, "Medium");
  assert.equal(l.path, "/api/block/{height}");
  assert.match(l.where, /GET \/api\/block\/\{height\}/);
  assert.match(l.where, /ST101/);
});

test("parseSchemathesis: one lead per path even if several failures name it", () => {
  const leads = parseSchemathesis(schemathesisReport(report({
    failures: [serverError(["GET /api/block/{height}"]), serverError(["GET /api/block/{height}"])],
  })));
  assert.equal(leads.length, 1);
});

test("parseSchemathesis: a failure naming several operations yields one lead each", () => {
  const leads = parseSchemathesis(schemathesisReport(report({
    failures: [serverError(["GET /api/block/{height}", "GET /api/other"])],
  })));
  assert.deepEqual(leads.map((l) => l.path).sort(), ["/api/block/{height}", "/api/other"]);
});

test("parseSchemathesis: a clean report (no failures) yields no leads", () => {
  assert.deepEqual(parseSchemathesis(schemathesisReport(report({ exit_code: 0, failures: [] }))), []);
});

test("parseSchemathesis: null/garbage report never throws, returns no leads", () => {
  assert.deepEqual(parseSchemathesis(null), []);
  assert.deepEqual(parseSchemathesis(undefined), []);
  assert.deepEqual(parseSchemathesis({}), []);
});

test("parseSchemathesis: no stray field from the report is copied into a lead (secrets stay out)", () => {
  // Even if a response body with a secret rode along in the report, the parser
  // only ever reads code/title/operations.
  const leads = parseSchemathesis(schemathesisReport(report({
    failures: [serverError(["GET /api/block/{height}"])],
    extra: { leaked: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" },
  })));
  assert.doesNotMatch(JSON.stringify(leads), /0x[0-9a-f]{64}/i);
});

// ---- runner (mock run, no Docker) ------------------------------------------

// A mock that writes a canned report.json into the scratch dir, like the tool.
const mockWrite = (reportJson, code = 1, extra = {}) => async ({ ws }) => {
  if (reportJson != null) writeFileSync(join(ws, "report.json"), reportJson);
  return { code, stdout: "", stderr: "", ...extra };
};

test("scanSchemathesis: a run that found a server error reports ran with the lead (exit 1 is NOT an error)", async () => {
  const r = await scanSchemathesis({
    net: "netx", baseUrl: "http://lab:8080",
    run: mockWrite(report({ exit_code: 1, failures: [serverError(["GET /api/block/{height}"])] }), 1),
  });
  assert.equal(r.coverage.length, 1);
  assert.equal(r.coverage[0].engine, "schemathesis");
  assert.equal(r.coverage[0].status, "ran");
  assert.equal(r.coverage[0].leads, 1);
  assert.ok(r.leads.some((l) => l.path === "/api/block/{height}" && l.check === "schema-fuzz:ST101"));
});

test("scanSchemathesis: a clean run (exit 0, no failures) is ran with zero leads", async () => {
  const r = await scanSchemathesis({
    net: "netx", baseUrl: "http://lab:8080",
    run: mockWrite(report({ exit_code: 0, failures: [] }), 0),
  });
  assert.equal(r.coverage[0].status, "ran");
  assert.equal(r.coverage[0].leads, 0);
  assert.equal(r.leads.length, 0);
  assert.equal(r.coverage[0].reason, undefined, "a clean run carries no caveat");
});

test("scanSchemathesis: a partly errored run (exit 1, tested 1, errored 7, no failures) is NOT a clean ran -- it carries a reason and keeps its leads", async () => {
  const r = await scanSchemathesis({
    net: "netx", baseUrl: "http://lab:8080",
    run: mockWrite(report({ exit_code: 1, tested: 1, errored: 7, total: 8, failures: [] }), 1),
  });
  // The run did exercise the API, so it is not "unavailable"...
  assert.equal(r.coverage[0].status, "ran");
  // ...but it is not a clean pass: the row carries a reason naming the errors,
  // which a clean ran never has. 7 of 8 operations never ran.
  assert.match(r.coverage[0].reason, /7 of 8 operations errored/);
  assert.equal(r.leads.length, 0, "no failures means no leads, but the row is still flagged");
});

test("scanSchemathesis: a partly errored run keeps the leads from the operations that did run", async () => {
  const r = await scanSchemathesis({
    net: "netx", baseUrl: "http://lab:8080",
    run: mockWrite(report({ exit_code: 1, tested: 1, errored: 7, total: 8, failures: [serverError(["GET /api/block/{height}"])] }), 1),
  });
  assert.equal(r.coverage[0].status, "ran");
  assert.match(r.coverage[0].reason, /7 of 8 operations errored/);
  assert.equal(r.coverage[0].leads, 1);
  assert.ok(r.leads.some((l) => l.path === "/api/block/{height}"));
});

// A report shaped by hand, for fields the `report()` helper always fills in.
const rawReport = (operations, { failures = [], errors = [] } = {}) =>
  JSON.stringify({ complete: true, operations, failures, errors });

test("scanSchemathesis: no errored field and tested < total is NOT a clean pass (1 of 8 operations tested)", async () => {
  const r = await scanSchemathesis({
    net: "netx", baseUrl: "http://lab:8080",
    run: mockWrite(rawReport({ total: 8, tested: 1 }), 0),
  });
  assert.equal(r.coverage[0].status, "ran");
  assert.match(r.coverage[0].reason, /1 of 8 operations tested/);
});

test("scanSchemathesis: a skipped operation (tested 7 of 8, errored 0) is NOT a clean pass", async () => {
  const r = await scanSchemathesis({
    net: "netx", baseUrl: "http://lab:8080",
    run: mockWrite(rawReport({ total: 8, selected: 8, tested: 7, errored: 0, skipped: 1 }), 0),
  });
  assert.equal(r.coverage[0].status, "ran");
  assert.match(r.coverage[0].reason, /7 of 8 operations tested/);
});

test("scanSchemathesis: an errors-only report (errored 0, one run error) says so, never '0 of 8 operations errored'", async () => {
  const r = await scanSchemathesis({
    net: "netx", baseUrl: "http://lab:8080",
    run: mockWrite(rawReport({ total: 8, selected: 8, tested: 8, errored: 0 }, { errors: [{ title: "schema load error" }] }), 1),
  });
  assert.equal(r.coverage[0].status, "ran");
  assert.match(r.coverage[0].reason, /1 run error in the report/);
  assert.doesNotMatch(r.coverage[0].reason, /0 of \d+ operations errored/);
});

test("scanSchemathesis: a mismatched pair (exit 0 while failures are present) is a gap, never a clean ran", async () => {
  const r = await scanSchemathesis({
    net: "netx", baseUrl: "http://lab:8080",
    run: mockWrite(report({ exit_code: 0, failures: [serverError(["GET /api/block/{height}"])] }), 0),
  });
  assert.equal(r.coverage[0].status, "unavailable");
  assert.equal(r.leads.length, 0);
  assert.match(r.coverage[0].reason, /disagrees with its report/);
});

test("scanSchemathesis: a mismatched pair (exit 1 with no failures and no errors) is a gap", async () => {
  const r = await scanSchemathesis({
    net: "netx", baseUrl: "http://lab:8080",
    run: mockWrite(report({ exit_code: 1, failures: [], errored: 0 }), 1),
  });
  assert.equal(r.coverage[0].status, "unavailable");
  assert.equal(r.leads.length, 0);
  assert.match(r.coverage[0].reason, /disagrees with its report/);
});

test("scanSchemathesis: a timeout is unavailable with timedOut set, never a clean result", async () => {
  const r = await scanSchemathesis({
    net: "netx", baseUrl: "http://lab:8080",
    run: mockWrite(null, 143, { timedOut: true }),
  });
  assert.equal(r.coverage[0].status, "unavailable");
  assert.equal(r.coverage[0].timedOut, true);
  assert.equal(r.leads.length, 0);
  assert.match(r.coverage[0].reason, /timed out/);
});

test("scanSchemathesis: no report file is a gap, not a clean run", async () => {
  const r = await scanSchemathesis({
    net: "netx", baseUrl: "http://lab:8080",
    run: mockWrite(null, 2, { stderr: "could not reach schema" }),
  });
  assert.equal(r.coverage[0].status, "unavailable");
  assert.equal(r.leads.length, 0);
  assert.match(r.coverage[0].reason, /no usable report/);
});

test("scanSchemathesis: an incomplete report (run cut short, complete:false) is a gap", async () => {
  const r = await scanSchemathesis({
    net: "netx", baseUrl: "http://lab:8080",
    run: mockWrite(report({ complete: false }), 1),
  });
  assert.equal(r.coverage[0].status, "unavailable");
  assert.equal(r.leads.length, 0);
});

test("scanSchemathesis: a report that tested zero operations is a gap (nothing was exercised)", async () => {
  const r = await scanSchemathesis({
    net: "netx", baseUrl: "http://lab:8080",
    run: mockWrite(report({ tested: 0 }), 1),
  });
  assert.equal(r.coverage[0].status, "unavailable");
  assert.equal(r.leads.length, 0);
});

// The shared runDocker() timeout fix sets timedOut:true even when the killed
// client reports exit 0 and a partial report was written. The tool honors the
// flag and never reads a killed run as complete.
test("scanSchemathesis: timedOut:true alone is a gap, even with a 0 exit and a written report", async () => {
  const r = await scanSchemathesis({
    net: "netx", baseUrl: "http://lab:8080",
    run: mockWrite(report({ exit_code: 0, failures: [serverError(["GET /api/block/{height}"])] }), 0, { timedOut: true }),
  });
  assert.equal(r.coverage[0].status, "unavailable");
  assert.equal(r.coverage[0].timedOut, true);
  assert.equal(r.leads.length, 0, "a killed run yields no leads even if a partial report was written");
  assert.match(r.coverage[0].reason, /timed out/);
});

// Pin the EXACT Docker argv (checklist item 5). scanSchemathesis picks the
// image and the network; the shared runTool turns them into the `docker run`
// argv, where --pull=never lives. This runs the REAL runTool (its default
// `run`) behind a docker PATH shim that records argv and drops a valid report
// into the -v mount, then exits 1 (failures found). It pins: --pull=never right
// after `run --rm`, the pinned local image tag with the schemathesis command
// after it, and the named INTERNAL lab network it was handed -- never
// "bridge"/"host"/"none".
test("scanSchemathesis: pins image, --pull=never and the internal lab network in the real docker argv (item 5)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "st-argv-"));
  const record = join(dir, "args");
  const src = join(dir, "report.json");
  writeFileSync(src, report({ exit_code: 1, failures: [serverError(["GET /api/block/{height}"])] }));
  const path = process.env.PATH;
  try {
    writeFileSync(join(dir, "docker"),
      '#!/bin/sh\n' +
      'printf "%s\\n" "$@" > "' + record + '"\n' +
      'prev=""\nfor a in "$@"; do\n' +
      '  if [ "$prev" = "-v" ]; then host="${a%%:*}"; cp "' + src + '" "$host/report.json"; fi\n' +
      '  prev="$a"\ndone\nexit 1\n',
      { mode: 0o755 });
    process.env.PATH = dir + ":" + path;
    // exit 1 == failures found == a completed run, so status is "ran".
    const r = await scanSchemathesis({ net: "ts-internal-net", baseUrl: "http://lab:8080" });
    assert.equal(r.coverage[0].status, "ran");
    assert.equal(r.coverage[0].leads, 1);
  } finally {
    process.env.PATH = path;
  }
  try {
    const args = readFileSync(record, "utf8").trim().split("\n");
    assert.deepEqual(args.slice(0, 3), ["run", "--rm", "--pull=never"]);
    const ni = args.indexOf("--network");
    assert.ok(ni >= 0, "argv carries --network");
    assert.equal(args[ni + 1], "ts-internal-net"); // the net it was given
    assert.notEqual(args[ni + 1], "bridge");
    assert.notEqual(args[ni + 1], "host");
    assert.notEqual(args[ni + 1], "none");
    const ii = args.indexOf(SCHEMATHESIS_IMAGE);
    assert.ok(ii >= 0, `pinned image ${SCHEMATHESIS_IMAGE} in argv`);
    assert.equal(SCHEMATHESIS_IMAGE, "touchstone/web-schemathesis:4.33.4"); // exact pinned tag
    assert.equal(args[ii + 1], "schemathesis"); // the schemathesis command follows the image
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- real run against the lab ----------------------------------------------

const hasImages = (() => {
  try {
    for (const img of ["touchstone/web-lab:dev", SCHEMATHESIS_IMAGE]) {
      execFileSync("docker", ["image", "inspect", img], { stdio: "ignore" });
    }
    return true;
  } catch { return false; }
})();
const LAB = new URL("../packs/web/lab/dapp", import.meta.url).pathname;

test("schemathesis real run: the full prepass finds the HTTP 500 on GET /api/block/{height}, which the other tools miss",
  { skip: !hasImages && "web-lab or web-schemathesis image not built", timeout: 600_000 }, async () => {
  const ws = makeWorkspace(LAB);
  try {
    const prep = await web.prepass(ws);

    // Schemathesis ran as part of the real prepass, through the real runTool and Docker.
    const cov = Object.fromEntries(prep.record.coverage.map((c) => [c.engine, c.status]));
    assert.equal(cov.schemathesis, "ran", JSON.stringify(prep.record.coverage));

    // The planted server-error bug is in the leads: a 500 on the typed path param.
    const bug = prep.record.leads.find((l) => l.engine === "schemathesis" && l.path === "/api/block/{height}");
    assert.ok(bug, "schemathesis should find the 500 on GET /api/block/{height}");
    assert.equal(bug.check, "schema-fuzz:ST101");
    assert.equal(bug.impact, "Medium");

    // ...and ONLY schemathesis produced that lead. No other prepass tool drives a
    // typed path parameter against the schema, so this is something the pack did
    // not find before schemathesis.
    assert.deepEqual(bug.engines, ["schemathesis"], `only schemathesis should find it; got ${JSON.stringify(bug.engines)}`);

    // No raw secret is ever carried in a lead.
    assert.doesNotMatch(JSON.stringify(prep), /signerPrivateKey"\s*:\s*"0x/);

    // Written leads file on disk matches (what the agent reads back).
    const onDisk = JSON.parse(readFileSync(join(ws, ".web-leads.json"), "utf8"));
    assert.ok(onDisk.leads.some((l) => l.engine === "schemathesis" && l.path === "/api/block/{height}"));
  } finally {
    // prepass() starts a persisted lab; stop it (lab, proxy, networks) before
    // the workspace that holds its handle is removed.
    try { await web.teardown(ws); } finally { cleanupWorkspace(ws); }
  }
});
