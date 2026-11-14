// Tests for the Web pack's ffuf content-discovery tool (packs/web/ffuf.mjs).
// The parser is a pure function over ffuf's JSON, so most tests need no Docker.
// The runner is tested with a mock `run` (no Docker). The last test runs ffuf
// for real against the lab and shows it finds a route the other three prepass
// tools (zap, nuclei, dalfox) miss. It skips when an image is not built.
//
//   node --experimental-test-module-mocks --test test/web-ffuf.test.mjs
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFfuf, ffufHasResults, scanFfuf, FFUF_IMAGE } from "../packs/web/ffuf.mjs";
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

// The shared runDocker() timeout fix (named container + `docker rm -f`) sets
// timedOut:true even when the killed client reports a 0 exit. The tool must
// honor the flag on its own, never read a killed run as a clean scan. (The
// "container is actually gone" half of checklist item 6 lives in that shared
// lib/wrap.mjs commit, not here; see this file's note and the final report.)
test("scanFfuf: timedOut:true alone is unavailable, even with a 0 exit code", async () => {
  const r = await scanFfuf({
    net: "netx", baseUrl: "http://lab:8080",
    run: mockWrite(ffufJson(row("internal/metrics", 200)), 0), // would-be-clean output...
    // ...but override to flag the timeout the shared kill sets:
  });
  assert.equal(r.coverage[0].status, "ran"); // sanity: without the flag it is ran
  const t = await scanFfuf({
    net: "netx", baseUrl: "http://lab:8080",
    run: async ({ ws }) => { writeFileSync(join(ws, "ffuf.json"), ffufJson(row("internal/metrics", 200))); return { code: 0, stdout: "", stderr: "", timedOut: true }; },
  });
  assert.equal(t.coverage[0].status, "unavailable");
  assert.equal(t.leads.length, 0, "a killed run yields no leads even if a partial report was written");
  assert.match(t.coverage[0].reason, /timed out/);
});

test("scanFfuf: exit 0 with no results array is a gap, not a clean scan (item 2)", async () => {
  // ffuf always writes a results array; a report without one, or no file at all,
  // must not be read as 'found nothing'.
  for (const body of ['{"success":true}', '{"results":null}', "{}"]) {
    const r = await scanFfuf({
      net: "netx", baseUrl: "http://lab:8080",
      run: mockWrite(body, 0),
    });
    assert.equal(r.coverage[0].status, "unavailable", `body ${body}`);
    assert.equal(r.leads.length, 0);
    assert.match(r.coverage[0].reason, /no parsable report|results array/);
  }
  // No file written at all, exit 0.
  const none = await scanFfuf({
    net: "netx", baseUrl: "http://lab:8080",
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  assert.equal(none.coverage[0].status, "unavailable");
});

test("scanFfuf: a non-zero exit is unavailable even if a stale report parses (item 1)", async () => {
  // A run that exits non-zero did not complete; its leftover report is not trusted.
  const r = await scanFfuf({
    net: "netx", baseUrl: "http://lab:8080",
    run: mockWrite(ffufJson(row("internal/metrics", 200)), 2),
  });
  assert.equal(r.coverage[0].status, "unavailable");
  assert.equal(r.coverage[0].code, 2);
  assert.equal(r.leads.length, 0);
});

test("ffufHasResults: only a report carrying a results array counts (item 2)", () => {
  assert.equal(ffufHasResults(ffufJson(row("x", 200))), true);
  assert.equal(ffufHasResults(JSON.stringify({ results: [] })), true);
  assert.equal(ffufHasResults('{"success":true}'), false);
  assert.equal(ffufHasResults('{"results":null}'), false);
  assert.equal(ffufHasResults(""), false);
  assert.equal(ffufHasResults("{not json"), false);
});

// Pin the EXACT Docker argv the runner produces (checklist item 5). scanFfuf
// picks the image and the network; the shared runTool turns them into the
// `docker run` argv, where --pull=never now lives. So this runs the REAL runTool
// (its default `run`) behind a docker PATH shim that records its argv and writes
// a minimal report, pinning: --pull=never right after `run --rm`, the pinned
// local image tag, the ffuf command after it, and the named INTERNAL lab network
// it was handed -- never "bridge"/"host"/"none". A rewire to the internet, a
// dropped --pull=never, or a changed tag fails this test.
test("scanFfuf: pins image, --pull=never and the internal lab network in the real docker argv (item 5)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ffuf-argv-"));
  const record = join(dir, "args");
  const path = process.env.PATH;
  try {
    // Record argv; find the `-v host:/work` mount and write a report there, so
    // scanFfuf sees an exit-0 run with a parsable (empty) results array.
    writeFileSync(join(dir, "docker"),
      '#!/bin/sh\n' +
      'printf "%s\\n" "$@" > "' + record + '"\n' +
      'prev=""\nfor a in "$@"; do\n' +
      '  if [ "$prev" = "-v" ]; then host="${a%%:*}"; printf \'{"results":[]}\' > "$host/ffuf.json"; fi\n' +
      '  prev="$a"\ndone\nexit 0\n',
      { mode: 0o755 });
    process.env.PATH = dir + ":" + path;
    const r = await scanFfuf({ net: "ts-internal-net", baseUrl: "http://lab:8080" });
    assert.equal(r.coverage[0].status, "ran");
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
    const ii = args.indexOf(FFUF_IMAGE);
    assert.ok(ii >= 0, `pinned image ${FFUF_IMAGE} in argv`);
    assert.equal(FFUF_IMAGE, "touchstone/web-ffuf:2.3.0"); // exact pinned tag
    assert.equal(args[ii + 1], "ffuf"); // the ffuf command follows the image
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    // prepass() starts a persisted lab; stop it (lab, proxy, networks) before
    // the workspace that holds its handle is removed.
    try { await web.teardown(ws); } finally { cleanupWorkspace(ws); }
  }
});
