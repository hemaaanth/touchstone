// The token through the whole supply-chain prepass (packs/supply-chain/pack.mjs).
//
// pack.prepass runs end to end with a synthetic token in GITHUB_TOKEN: the
// offline scanners, the Scorecard and Legitify captures, the coverage rows, the
// gaps, the record and the events. The capture gate is the real one, with
// throwaway scope and grant stores. Two things are fakes, so nothing reaches
// the network and no container starts:
//   - lib/reach-confine.mjs (the egress boundary) is a module mock;
//   - `docker` is a PATH shim that logs its argv. For a capture run it prints
//     the token it got by env name: whole, split across stdout and stderr, and
//     in base64. Every other call prints nothing.
// Then no argv, event, coverage row, gap, lead, record, saved file or error
// text holds the token or any part of it.
//
//   node --experimental-test-module-mocks --test spike/test/supply-chain-networked-record.test.mjs
import "./helpers/isolated-env.mjs";
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "supply-net-record-"));
after(() => rmSync(dir, { recursive: true, force: true }));
process.env.TOUCHSTONE_SCOPES_FILE = join(dir, "scopes.json");
process.env.TOUCHSTONE_GRANTS_FILE = join(dir, "grants.json");
process.env.TOUCHSTONE_GRANT_TOKEN = "test-token-not-real";
process.env.TOUCHSTONE_EXEC = "local";

const FAKE_TOKEN = "github_pat_FAKE0record0FAKE0record0FAKE0record0123";

// The docker shim. A capture run is the one whose argv names a secret by env
// name only (`-e GITHUB_TOKEN` or `-e SCM_TOKEN`).
const bin = join(dir, "bin");
const log = join(dir, "docker-argv.jsonl");
const shim = `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + "\\n");
if (a[0] === "run") {
  const name = ["GITHUB_TOKEN", "SCM_TOKEN"].find((k) => a.some((x, i) => x === k && a[i - 1] === "-e"));
  const t = name && process.env[name];
  if (t && name === "GITHUB_TOKEN") {
    process.stdout.write(JSON.stringify({ note: "token " + t, b64: Buffer.from("x:" + t).toString("base64") }));
    process.stderr.write("401 Bad credentials for " + t + "\\n");
    process.exit(0);
  }
  if (t) {
    process.stdout.write('{"a":"' + t.slice(0, 13));
    process.stderr.write(t.slice(13) + '"}\\n');
    process.exit(0);
  }
}
process.exit(0);
`;
mkdirSync(bin);
writeFileSync(join(bin, "docker"), shim);
chmodSync(join(bin, "docker"), 0o755);

mock.module("../lib/reach-confine.mjs", {
  namedExports: {
    confineReach: async ({ allowedHosts }) => {
      assert.deepEqual(allowedHosts, ["api.github.com"], "the boundary allows only api.github.com");
      return { netClient: "touchstone-reach-client-record", proxyName: null, gateUrl: "http://scope-gate:8080", stop: async () => {} };
    },
  },
});

const { addLiveScope } = await import("../lib/scopes-store.mjs");
const { holdsSecret } = await import("../lib/capture.mjs");
const pack = (await import("../packs/supply-chain/pack.mjs")).default;
const scopeId = addLiveScope({ hosts: ["hemaaanth/touchstone"], pack: "supply-chain", permission: true }).id;

// Every file under a folder, as text.
const allText = (root) => readdirSync(root, { recursive: true }).map((f) => join(root, String(f))).filter((p) => statSync(p).isFile()).map((p) => [p, readFileSync(p, "utf8")]);

async function prepass(cfg) {
  const src = mkdtempSync(join(dir, "src-"));
  writeFileSync(join(src, "Dockerfile"), "FROM node:20\n");
  const ws = mkdtempSync(join(dir, "ws-"));
  writeFileSync(join(ws, ".touchstone.json"), JSON.stringify({ pack: "supply-chain", kind: "folder", source: src, ...cfg }));
  const events = [];
  const path = process.env.PATH, had = process.env.GITHUB_TOKEN;
  process.env.PATH = `${bin}:${path}`;
  process.env.GITHUB_TOKEN = FAKE_TOKEN;
  let out, error = null;
  try { out = await pack.prepass(ws, { emit: (e) => events.push(e) }); }
  catch (err) { error = err; }
  finally {
    process.env.PATH = path;
    if (had === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = had;
  }
  return { ws, out, events, error };
}

test("full prepass with a synthetic token: no argv, event, row, gap, lead, record, file or error holds any part of it", async () => {
  rmSync(log, { force: true });
  const { ws, out, events, error } = await prepass({ networkTools: ["scorecard", "legitify"], networkTarget: "hemaaanth/touchstone", scopeId });
  assert.equal(error, null, error?.message);
  const argv = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  // The captures ran (behind the stand-in boundary), each with the token by name only.
  const caps = argv.filter((a) => a[0] === "run" && a.includes("--network") && a[a.indexOf("--network") + 1] === "touchstone-reach-client-record");
  assert.equal(caps.length, 2, "Scorecard and Legitify each ran one capture");
  for (const a of argv.filter((x) => x[0] === "run" && !caps.includes(x))) assert.equal(a[a.indexOf("--network") + 1], "none", "every other tool run has no network");
  const r = out.record;
  for (const [what, value] of [["argv", argv], ["events", events], ["record", r], ["coverage", r.coverage], ["gaps", r.gaps], ["leads", r.leads], ["env", out.env]]) {
    assert.ok(!holdsSecret(JSON.stringify(value), [FAKE_TOKEN]), `${what} holds part of the token`);
    assert.ok(!JSON.stringify(value).includes(FAKE_TOKEN.slice(0, 12)), `${what} holds the token prefix`);
  }
  for (const [file, text] of allText(ws)) assert.ok(!holdsSecret(text, [FAKE_TOKEN]), `${file} holds part of the token`);
  // Both captures fail closed: the base64 copy and the split copy are dropped.
  const row = (e) => r.coverage.find((c) => c.engine === e);
  assert.equal(row("scorecard-api").status, "unavailable");
  assert.equal(row("scorecard-api").reason, "output contained part of the token");
  assert.equal(row("legitify").status, "unavailable");
  assert.equal(row("legitify").reason, "output contained part of the token");
});

test("full prepass refused at the gate: no scope id means no capture run, and the row says why", async () => {
  rmSync(log, { force: true });
  const { out, error } = await prepass({ networkTools: ["scorecard"], networkTarget: "hemaaanth/touchstone", reach: { granted: true, scope: ["hemaaanth/touchstone"] } });
  assert.equal(error, null, error?.message);
  const argv = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(!argv.some((a) => a.includes("GITHUB_TOKEN")), "no capture container was started");
  const row = out.record.coverage.find((c) => c.engine === "scorecard-api");
  assert.equal(row.status, "unavailable");
  assert.match(row.reason, /^not covered: capture refused: A capture needs the run's own saved scope/);
  assert.ok(out.record.gaps.some((g) => g.kind === "not-covered-capture-refused"));
});

test("no opt-in: a config with a scope id but no networkTools makes no capture and no networked row", async () => {
  rmSync(log, { force: true });
  const { out, error } = await prepass({ scopeId, networkTarget: "hemaaanth/touchstone" });
  assert.equal(error, null, error?.message);
  const argv = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(!argv.some((a) => a.includes("GITHUB_TOKEN") || a.includes("SCM_TOKEN")), "no capture container was started");
  assert.ok(!argv.some((a) => a[0] === "run" && a[a.indexOf("--network") + 1] !== "none"), "every run has no network");
  assert.ok(!out.record.coverage.some((c) => /^scorecard|^legitify/.test(c.engine)));
});
