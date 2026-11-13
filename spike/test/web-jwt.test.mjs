// Tests for the Web pack's jwt_tool JWT-key cracker (packs/web/jwt.mjs). The
// shape check (looksLikeJwt), the crack-output reader (parseJwtCrack) and the
// lead builder (jwtLeads) are pure functions, so most tests need no Docker. The
// runner is tested with a recording mock `run` that distinguishes the capture
// call from the crack call (no Docker). The last test runs jwt_tool for real as
// part of the full prepass against the lab and shows it recovers the weak HS256
// signing key behind GET /api/v2/token -- a lead no other prepass tool (zap,
// nuclei, dalfox, ffuf, arjun, schemathesis) produces. It skips when an image
// is not built.
//
//   node --experimental-test-module-mocks --test test/web-jwt.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  looksLikeJwt,
  parseJwtCrack,
  jwtLeads,
  scanJwt,
  JWT_TOOL_IMAGE,
  FETCH_IMAGE,
  TOKEN_PATH,
} from "../packs/web/jwt.mjs";
import web from "../packs/web/pack.mjs";
import { makeWorkspace, cleanupWorkspace } from "../lib/sandbox.mjs";

// A syntactically valid HS256 JWT (shape only; the mock never verifies it).
const SAMPLE_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJndWVzdCIsInJvbGUiOiJndWVzdCJ9.mzkB3lCKcVkg6nDLeU62oKT1wbcaENDcxYoo8fx7DVQ";
const CRACK_HIT = "[+] secret123 is the CORRECT key!";
const CRACK_MISS = "[-] Key not in dictionary";

// ---- shape check (pure) ----------------------------------------------------

test("looksLikeJwt: a three-segment base64url token is a JWT shape", () => {
  assert.equal(looksLikeJwt(SAMPLE_JWT), true);
  assert.equal(looksLikeJwt("aaa.bbb.ccc"), true);
});

test("looksLikeJwt: wrong segment count, empty, or illegal chars is not a JWT", () => {
  assert.equal(looksLikeJwt(""), false);
  assert.equal(looksLikeJwt("   "), false);
  assert.equal(looksLikeJwt("aaa.bbb"), false);         // two parts
  assert.equal(looksLikeJwt("aaa.bbb.ccc.ddd"), false); // four parts
  assert.equal(looksLikeJwt("<html>not a token</html>"), false);
  assert.equal(looksLikeJwt("aaa.b b.ccc"), false);     // space is not base64url
  assert.equal(looksLikeJwt(null), false);
  assert.equal(looksLikeJwt(undefined), false);
});

// ---- crack-output reader (pure) --------------------------------------------

test("parseJwtCrack: the short-key success line yields cracked + the secret", () => {
  const v = parseJwtCrack(`...banner...\n${CRACK_HIT}\nYou can tamper/fuzz ...`);
  assert.equal(v.analyzed, true);
  assert.equal(v.cracked, true);
  assert.equal(v.secret, "secret123");
});

test("parseJwtCrack: the long-key success form (key on next line) is read too", () => {
  const v = parseJwtCrack("[+] CORRECT key found:\n   this-is-a-very-long-passphrase-over-25\n");
  assert.equal(v.cracked, true);
  assert.equal(v.secret, "this-is-a-very-long-passphrase-over-25");
});

test("parseJwtCrack: 'Key not in dictionary' is a completed run with no crack", () => {
  const v = parseJwtCrack(`...banner...\n${CRACK_MISS}\n`);
  assert.equal(v.analyzed, true);
  assert.equal(v.cracked, false);
  assert.equal(v.secret, null);
});

test("parseJwtCrack: empty or markerless output is NOT analysed (a gap, fails closed)", () => {
  assert.deepEqual(parseJwtCrack(""), { analyzed: false, cracked: false, secret: null });
  assert.deepEqual(parseJwtCrack("Traceback (most recent call last): ..."), { analyzed: false, cracked: false, secret: null });
  assert.deepEqual(parseJwtCrack(null), { analyzed: false, cracked: false, secret: null });
});

// ---- lead builder (pure) ---------------------------------------------------

test("jwtLeads: a cracked key becomes one High-impact lead on the token endpoint", () => {
  const leads = jwtLeads({ analyzed: true, cracked: true, secret: "secret123" });
  assert.equal(leads.length, 1);
  const l = leads[0];
  assert.equal(l.engine, "jwt-tool");
  assert.equal(l.check, "jwt-weak-hmac-key");
  assert.equal(l.impact, "High");
  assert.equal(l.path, TOKEN_PATH);
  assert.match(l.where, /secret123/);
  assert.match(l.description, /forge/i);
});

test("jwtLeads: a run that did not crack the key yields no leads", () => {
  assert.deepEqual(jwtLeads({ analyzed: true, cracked: false, secret: null }), []);
});

// ---- runner (recording mock, no Docker) ------------------------------------

// A mock `run` that answers the two calls scanJwt makes -- the capture (on the
// lab net) and the crack (offline) -- by which image is requested, and records
// every call so a test can assert the capture ran on the net and the crack ran
// with no network.
function recordingRun({ token = SAMPLE_JWT, fetch = {}, crack = {} } = {}) {
  const calls = [];
  const run = async ({ image, network }) => {
    calls.push({ image, network });
    if (image === FETCH_IMAGE) {
      return { code: 0, stdout: token, stderr: "", timedOut: false, ...fetch };
    }
    return { code: 1, stdout: "", stderr: "", timedOut: false, ...crack };
  };
  return { run, calls };
}

test("scanJwt: a cracked key reports ran with one High lead; crack runs OFFLINE, capture on the net", async () => {
  const { run, calls } = recordingRun({ crack: { stdout: CRACK_HIT, code: 1 } });
  const r = await scanJwt({ net: "lab-net", baseUrl: "http://lab:8080", run });
  assert.equal(r.coverage[0].engine, "jwt-tool");
  assert.equal(r.coverage[0].status, "ran");
  assert.equal(r.coverage[0].leads, 1);
  assert.equal(r.leads[0].path, TOKEN_PATH);
  assert.equal(r.leads[0].impact, "High");
  // Two calls: capture on the given net, crack with network "none".
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { image: FETCH_IMAGE, network: "lab-net" });
  assert.deepEqual(calls[1], { image: JWT_TOOL_IMAGE, network: "none" });
});

test("scanJwt: a completed crack that did not find the key is ran with zero leads", async () => {
  const { run } = recordingRun({ crack: { stdout: CRACK_MISS, code: 1 } });
  const r = await scanJwt({ net: "lab-net", baseUrl: "http://lab:8080", run });
  assert.equal(r.coverage[0].status, "ran");
  assert.equal(r.coverage[0].leads, 0);
  assert.equal(r.leads.length, 0);
});

test("scanJwt: a crack timeout is unavailable with timedOut set, never a clean result", async () => {
  const { run } = recordingRun({ crack: { stdout: "", code: 137, timedOut: true } });
  const r = await scanJwt({ net: "lab-net", baseUrl: "http://lab:8080", run });
  assert.equal(r.coverage[0].status, "unavailable");
  assert.equal(r.coverage[0].timedOut, true);
  assert.match(r.coverage[0].reason, /timed out/);
  assert.equal(r.leads.length, 0);
});

test("scanJwt: a crack with no usable verdict (no markers) is a gap, not a clean run", async () => {
  const { run } = recordingRun({ crack: { stdout: "garbage with no marker", code: 1 } });
  const r = await scanJwt({ net: "lab-net", baseUrl: "http://lab:8080", run });
  assert.equal(r.coverage[0].status, "unavailable");
  assert.match(r.coverage[0].reason, /no usable verdict/);
  assert.equal(r.leads.length, 0);
});

test("scanJwt: no token captured is unavailable, and the crack never runs", async () => {
  const { run, calls } = recordingRun({ token: "" }); // capture yields nothing
  const r = await scanJwt({ net: "lab-net", baseUrl: "http://lab:8080", run });
  assert.equal(r.coverage[0].status, "unavailable");
  assert.match(r.coverage[0].reason, /could not capture a JWT/);
  assert.equal(r.leads.length, 0);
  assert.equal(calls.length, 1, "crack must not run when capture produced no token");
});

test("scanJwt: a non-JWT capture (e.g. an HTML error page) is unavailable, crack skipped", async () => {
  const { run, calls } = recordingRun({ token: "<html>503</html>" });
  const r = await scanJwt({ net: "lab-net", baseUrl: "http://lab:8080", run });
  assert.equal(r.coverage[0].status, "unavailable");
  assert.equal(r.leads.length, 0);
  assert.equal(calls.length, 1);
});

test("scanJwt: a capture timeout is unavailable with timedOut set, crack skipped", async () => {
  const { run, calls } = recordingRun({ token: "", fetch: { code: 124, timedOut: true } });
  const r = await scanJwt({ net: "lab-net", baseUrl: "http://lab:8080", run });
  assert.equal(r.coverage[0].status, "unavailable");
  assert.equal(r.coverage[0].timedOut, true);
  assert.match(r.coverage[0].reason, /timed out/);
  assert.equal(calls.length, 1);
});

// Pin the EXACT Docker argv for BOTH calls (checklist item 5). scanJwt picks the
// images and the networks; the shared runTool turns them into `docker run`
// argv, where --pull=never lives. This runs the REAL runTool (its default
// `run`) behind a docker PATH shim: the shim answers the capture call with a
// valid-shaped JWT on stdout, and the crack call with the CORRECT-key line
// (exit 1, as jwt_tool really does). It pins, for the CRACK call: --pull=never
// right after `run --rm`, --network none (jwt_tool is OFFLINE), the pinned
// local image tag with `python3` after it; and for the CAPTURE call: the named
// INTERNAL lab network it was handed -- never "bridge"/"host"/"none".
test("scanJwt: pins both argvs -- capture on the internal net, crack with --pull=never and --network none (item 5)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jwt-argv-"));
  const fetchRec = join(dir, "fetch.args");
  const crackRec = join(dir, "crack.args");
  const path = process.env.PATH;
  try {
    writeFileSync(join(dir, "docker"),
      '#!/bin/sh\n' +
      'is_crack=0\n' +
      'for a in "$@"; do\n' +
      '  if [ "$a" = "' + JWT_TOOL_IMAGE + '" ]; then is_crack=1; fi\n' +
      'done\n' +
      'if [ "$is_crack" = 1 ]; then\n' +
      '  printf "%s\\n" "$@" > "' + crackRec + '"\n' +
      '  echo "' + CRACK_HIT + '"\n' +
      '  exit 1\n' +
      'else\n' +
      '  printf "%s\\n" "$@" > "' + fetchRec + '"\n' +
      '  printf "%s" "' + SAMPLE_JWT + '"\n' +
      '  exit 0\n' +
      'fi\n',
      { mode: 0o755 });
    process.env.PATH = dir + ":" + path;
    const r = await scanJwt({ net: "ts-internal-net", baseUrl: "http://lab:8080" });
    assert.equal(r.coverage[0].status, "ran");
    assert.equal(r.coverage[0].leads, 1);
    assert.equal(r.leads[0].path, TOKEN_PATH);
  } finally {
    process.env.PATH = path;
  }
  try {
    const crack = readFileSync(crackRec, "utf8").trim().split("\n");
    assert.deepEqual(crack.slice(0, 3), ["run", "--rm", "--pull=never"]);
    const cn = crack.indexOf("--network");
    assert.ok(cn >= 0, "crack argv carries --network");
    assert.equal(crack[cn + 1], "none", "jwt_tool must run with NO network");
    const ci = crack.indexOf(JWT_TOOL_IMAGE);
    assert.ok(ci >= 0, `pinned image ${JWT_TOOL_IMAGE} in crack argv`);
    assert.equal(JWT_TOOL_IMAGE, "touchstone/web-jwt-tool:2.3.0"); // exact pinned tag
    assert.equal(crack[ci + 1], "python3"); // the jwt_tool command follows the image

    const fetch = readFileSync(fetchRec, "utf8").trim().split("\n");
    assert.deepEqual(fetch.slice(0, 3), ["run", "--rm", "--pull=never"]);
    const fn = fetch.indexOf("--network");
    assert.ok(fn >= 0, "capture argv carries --network");
    assert.equal(fetch[fn + 1], "ts-internal-net"); // the net it was given
    assert.notEqual(fetch[fn + 1], "bridge");
    assert.notEqual(fetch[fn + 1], "host");
    assert.notEqual(fetch[fn + 1], "none");
    assert.ok(fetch.indexOf(FETCH_IMAGE) >= 0, `capture uses ${FETCH_IMAGE}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- real run against the lab ----------------------------------------------

const hasImages = (() => {
  try {
    for (const img of ["touchstone/web-lab:dev", JWT_TOOL_IMAGE, FETCH_IMAGE]) {
      execFileSync("docker", ["image", "inspect", img], { stdio: "ignore" });
    }
    return true;
  } catch { return false; }
})();
const LAB = new URL("../packs/web/lab/dapp", import.meta.url).pathname;

test("jwt_tool real run: the full prepass cracks the weak HS256 key behind GET /api/v2/token, which no other tool finds",
  { skip: !hasImages && "web-lab, web-jwt-tool or node:20-slim image not built", timeout: 600_000 }, async () => {
  const ws = makeWorkspace(LAB);
  try {
    const prep = await web.prepass(ws);

    // jwt_tool ran as part of the real prepass, through the real runTool and Docker.
    const cov = Object.fromEntries(prep.record.coverage.map((c) => [c.engine, c.status]));
    assert.equal(cov["jwt-tool"], "ran", JSON.stringify(prep.record.coverage));

    // The planted weak-key bug is in the leads: a crackable HS256 signing key.
    const bug = prep.record.leads.find((l) => l.engine === "jwt-tool" && l.path === TOKEN_PATH);
    assert.ok(bug, "jwt_tool should crack the key behind GET /api/v2/token");
    assert.equal(bug.check, "jwt-weak-hmac-key");
    assert.equal(bug.impact, "High");
    assert.match(bug.where, /secret123/, "the recovered key is the lab's planted secret");

    // ...and ONLY jwt_tool produced a lead on that path. No other prepass tool
    // cracks a signing key, so this is something the pack did not find before.
    assert.deepEqual(bug.engines, ["jwt-tool"], `only jwt_tool should find it; got ${JSON.stringify(bug.engines)}`);

    // No raw signer private key is ever carried in a lead.
    assert.doesNotMatch(JSON.stringify(prep), /signerPrivateKey"\s*:\s*"0x/);

    // Written leads file on disk matches (what the agent reads back).
    const onDisk = JSON.parse(readFileSync(join(ws, ".web-leads.json"), "utf8"));
    assert.ok(onDisk.leads.some((l) => l.engine === "jwt-tool" && l.path === TOKEN_PATH));
  } finally {
    cleanupWorkspace(ws);
  }
});
