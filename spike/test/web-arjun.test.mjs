// Tests for the Web pack's Arjun hidden-parameter tool (packs/web/arjun.mjs).
// The parser is a pure function over Arjun's JSON, so most tests need no Docker.
// The runner is tested with a mock `run` (no Docker). The last test runs Arjun
// for real as part of the full prepass against the lab and shows it finds a
// hidden parameter the other four prepass tools (zap, nuclei, dalfox, ffuf)
// miss. It skips when an image is not built.
//
//   node --experimental-test-module-mocks --test test/web-arjun.test.mjs
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArjun, scanArjun, ARJUN_IMAGE, DEFAULT_ENDPOINTS } from "../packs/web/arjun.mjs";
import web from "../packs/web/pack.mjs";
import { makeWorkspace, cleanupWorkspace } from "../lib/sandbox.mjs";

// Shape of Arjun's -oJ output: an object keyed by the scanned URL, each value
// carrying the method and the undocumented parameter names it confirmed.
const arjunJson = (entries) => JSON.stringify(
  Object.fromEntries(entries.map(([url, method, params]) => [url, { headers: {}, method, params }])),
);

// ---- parser (pure) ---------------------------------------------------------

test("parseArjun: an undocumented param becomes a hidden-parameter lead, sensitive ones rank higher", () => {
  const leads = parseArjun(arjunJson([
    ["http://lab:8080/healthz", "GET", ["debug"]],      // sensitive name -> Medium
    ["http://lab:8080/search", "GET", ["sort"]],        // ordinary name -> Low
  ]));
  const byParam = Object.fromEntries(leads.map((l) => [l.param, l]));
  assert.equal(byParam.debug.impact, "Medium");
  assert.equal(byParam.debug.check, "hidden-parameter");
  assert.equal(byParam.debug.engine, "arjun");
  assert.equal(byParam.debug.path, "/healthz");
  assert.equal(byParam.debug.method, "GET");
  assert.equal(byParam.sort.impact, "Low");
  assert.equal(byParam.sort.path, "/search");
});

test("parseArjun: one lead per (method, path, param), duplicates dropped", () => {
  const leads = parseArjun(arjunJson([
    ["http://lab:8080/healthz", "GET", ["debug", "debug"]], // duplicate param -> one lead
  ]));
  assert.equal(leads.length, 1);
  assert.equal(leads[0].param, "debug");
});

test("parseArjun: no response body or value is ever copied into a lead (secrets stay out)", () => {
  // Even if a probed value leaked a key, the parser only ever keeps the NAME.
  const leads = parseArjun(JSON.stringify({
    "http://lab:8080/healthz": {
      method: "GET",
      params: ["debug"],
      signerPrivateKey: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    },
  }));
  assert.doesNotMatch(JSON.stringify(leads), /signerPrivateKey|0x[0-9a-f]{64}/i);
  assert.equal(leads.length, 1);
});

test("parseArjun: garbage, empty, or param-less input returns no leads, never throws", () => {
  assert.deepEqual(parseArjun(""), []);
  assert.deepEqual(parseArjun("{not json"), []);
  assert.deepEqual(parseArjun("{}"), []);
  assert.deepEqual(parseArjun("[]"), []);
  assert.deepEqual(parseArjun(arjunJson([["http://lab:8080/healthz", "GET", []]])), []);
});

// ---- runner (mock run, no Docker) ------------------------------------------

// A mock that writes a canned arjun.json into each scratch dir, like Arjun would.
const mockWrite = (jsonByEndpoint, code = 0) => async ({ ws, cmd }) => {
  // cmd is ["arjun","-u","http://lab:8080<ep>", ...]; pick the endpoint's canned output.
  const url = cmd[cmd.indexOf("-u") + 1];
  const ep = new URL(url).pathname;
  writeFileSync(join(ws, "arjun.json"), jsonByEndpoint[ep] ?? "{}");
  return { code, stdout: "", stderr: "" };
};

test("scanArjun: a clean run reports ran with its parsed leads", async () => {
  const r = await scanArjun({
    net: "netx", baseUrl: "http://lab:8080", endpoints: ["/healthz"],
    run: mockWrite({ "/healthz": arjunJson([["http://lab:8080/healthz", "GET", ["debug"]]]) }),
  });
  assert.equal(r.coverage.length, 1);
  assert.equal(r.coverage[0].engine, "arjun");
  assert.equal(r.coverage[0].status, "ran");
  assert.equal(r.coverage[0].leads, 1);
  assert.ok(r.leads.some((l) => l.param === "debug" && l.path === "/healthz"));
});

test("scanArjun: a failed run with no output is unavailable, not a clean result", async () => {
  const r = await scanArjun({
    net: "netx", baseUrl: "http://lab:8080", endpoints: ["/healthz"],
    run: async () => ({ code: 1, stdout: "", stderr: "connection refused" }),
  });
  assert.equal(r.coverage[0].status, "unavailable");
  assert.equal(r.coverage[0].code, 1);
  assert.equal(r.leads.length, 0);
  assert.match(r.coverage[0].reason, /connection refused/);
});

test("scanArjun: a timeout is reported unavailable with timedOut set", async () => {
  const r = await scanArjun({
    net: "netx", baseUrl: "http://lab:8080", endpoints: ["/healthz"],
    run: async () => ({ code: 143, stdout: "", stderr: "", timedOut: true }),
  });
  assert.equal(r.coverage[0].status, "unavailable");
  assert.equal(r.coverage[0].timedOut, true);
  assert.match(r.coverage[0].reason, /timed out/);
});

test("scanArjun: one broken endpoint does not sink a good one (still ran, with a gap reason)", async () => {
  // First endpoint writes nothing and exits non-zero; second finds the param.
  let call = 0;
  const r = await scanArjun({
    net: "netx", baseUrl: "http://lab:8080", endpoints: ["/down", "/healthz"],
    run: async ({ ws }) => {
      call += 1;
      if (call === 1) return { code: 1, stdout: "", stderr: "refused" };
      writeFileSync(join(ws, "arjun.json"), arjunJson([["http://lab:8080/healthz", "GET", ["debug"]]]));
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(r.coverage[0].status, "ran");
  assert.equal(r.coverage[0].checked, 1);
  assert.ok(r.leads.some((l) => l.param === "debug"));
  // The gap is never hidden: a partial run still carries a reason naming it.
  assert.match(r.coverage[0].reason, /\/down/);
  assert.match(r.coverage[0].reason, /not checked/);
});

test("scanArjun: exit 0 with NO file is a checked-clean endpoint (ran, zero leads)", async () => {
  // Arjun writes its -oJ file ONLY when it finds parameters; a no-parameter
  // endpoint exits 0 and writes nothing. That is 'checked, found nothing',
  // not a gap -- the run is 'ran' with zero leads.
  const r = await scanArjun({
    net: "netx", baseUrl: "http://lab:8080", endpoints: ["/"],
    run: async () => ({ code: 0, stdout: "No parameters were discovered.", stderr: "" }),
  });
  assert.equal(r.coverage[0].status, "ran");
  assert.equal(r.coverage[0].checked, 1);
  assert.equal(r.coverage[0].leads, 0);
  assert.equal(r.leads.length, 0);
});

test("scanArjun: exit 0 but an unparsable report is a gap, not clean (item 2)", async () => {
  const r = await scanArjun({
    net: "netx", baseUrl: "http://lab:8080", endpoints: ["/healthz"],
    run: async ({ ws }) => { writeFileSync(join(ws, "arjun.json"), "{not json"); return { code: 0, stdout: "", stderr: "" }; },
  });
  assert.equal(r.coverage[0].status, "unavailable"); // the only endpoint was a gap
  assert.equal(r.coverage[0].checked, 0);
  assert.equal(r.leads.length, 0);
  assert.match(r.coverage[0].reason, /did not parse/);
});

// The shared runDocker() timeout fix sets timedOut:true even when the killed
// client reports exit 0. The tool honors the flag on its own and never reads a
// killed endpoint as checked. (The "container is actually gone" half of item 6
// lives in that shared lib/wrap.mjs commit, not here; see the final report.)
test("scanArjun: timedOut:true alone is a gap, even with a 0 exit code", async () => {
  const r = await scanArjun({
    net: "netx", baseUrl: "http://lab:8080", endpoints: ["/healthz"],
    run: async ({ ws }) => { writeFileSync(join(ws, "arjun.json"), arjunJson([["http://lab:8080/healthz", "GET", ["debug"]]])); return { code: 0, stdout: "", stderr: "", timedOut: true }; },
  });
  assert.equal(r.coverage[0].status, "unavailable");
  assert.equal(r.coverage[0].timedOut, true);
  assert.equal(r.leads.length, 0, "a killed endpoint yields no leads even if a partial report was written");
  assert.match(r.coverage[0].reason, /timed out/);
});

// Pin the EXACT Docker argv (checklist item 5). scanArjun picks the image and
// the network; the shared runTool turns them into the `docker run` argv, where
// --pull=never now lives. So this runs the REAL runTool (its default `run`)
// behind a docker PATH shim that records its argv and exits 0 (a checked-clean
// endpoint). It pins: --pull=never right after `run --rm`, the pinned local
// image tag with the arjun command after it, and the named INTERNAL lab network
// it was handed -- never "bridge"/"host"/"none".
test("scanArjun: pins image, --pull=never and the internal lab network in the real docker argv (item 5)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arjun-argv-"));
  const record = join(dir, "args");
  const path = process.env.PATH;
  try {
    writeFileSync(join(dir, "docker"),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "' + record + '"\nexit 0\n', { mode: 0o755 });
    process.env.PATH = dir + ":" + path;
    // Exit 0 with no report file == a checked-clean endpoint, so status is "ran".
    const r = await scanArjun({ net: "ts-internal-net", baseUrl: "http://lab:8080", endpoints: ["/healthz"] });
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
    const ii = args.indexOf(ARJUN_IMAGE);
    assert.ok(ii >= 0, `pinned image ${ARJUN_IMAGE} in argv`);
    assert.equal(ARJUN_IMAGE, "touchstone/web-arjun:2.2.7"); // exact pinned tag
    assert.equal(args[ii + 1], "arjun"); // the arjun command follows the image
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- real run against the lab ----------------------------------------------

const hasImages = (() => {
  try {
    for (const img of ["touchstone/web-lab:dev", ARJUN_IMAGE]) {
      execFileSync("docker", ["image", "inspect", img], { stdio: "ignore" });
    }
    return true;
  } catch { return false; }
})();
const LAB = new URL("../packs/web/lab/dapp", import.meta.url).pathname;

test("arjun real run: the full prepass finds the hidden ?debug= param on /healthz, which the other four tools miss",
  { skip: !hasImages && "web-lab or web-arjun image not built", timeout: 600_000 }, async () => {
  const ws = makeWorkspace(LAB);
  try {
    const prep = await web.prepass(ws);

    // Arjun ran as part of the real prepass, through the real runTool and Docker.
    const cov = Object.fromEntries(prep.record.coverage.map((c) => [c.engine, c.status]));
    assert.equal(cov.arjun, "ran", JSON.stringify(prep.record.coverage));

    // The planted undocumented parameter is in the leads...
    const hidden = prep.record.leads.find((l) => l.check === "hidden-parameter" && l.param === "debug");
    assert.ok(hidden, "arjun should discover the ?debug= parameter on /healthz");
    assert.equal(hidden.path, "/healthz");
    assert.equal(hidden.method, "GET");

    // ...and ONLY arjun produced that lead. ffuf finds the /healthz PATH, but no
    // scanner guesses the undocumented parameter NAME, so this is something the
    // pack did not find before arjun.
    assert.deepEqual(hidden.engines, ["arjun"], `only arjun should find it; got ${JSON.stringify(hidden.engines)}`);

    // No raw secret is ever carried in a lead (the param reflects the signer
    // address when probed, but the lead keeps only the name).
    assert.doesNotMatch(JSON.stringify(prep), /signerPrivateKey"\s*:\s*"0x/);

    // Written leads file on disk matches (what the agent reads back).
    const onDisk = JSON.parse(readFileSync(join(ws, ".web-leads.json"), "utf8"));
    assert.ok(onDisk.leads.some((l) => l.check === "hidden-parameter" && l.param === "debug"));
  } finally {
    // prepass() starts a persisted lab; stop it (lab, proxy, networks) before
    // the workspace that holds its handle is removed.
    try { await web.teardown(ws); } finally { cleanupWorkspace(ws); }
  }
});

// Guard the default endpoint list so a later edit cannot silently stop mining
// the route that carries the planted bug.
test("DEFAULT_ENDPOINTS includes /healthz, the route with the hidden param", () => {
  assert.ok(DEFAULT_ENDPOINTS.includes("/healthz"));
});
