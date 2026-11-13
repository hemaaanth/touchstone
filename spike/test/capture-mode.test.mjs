// Capture mode in runTool(): the only path where a pack tool gets the network.
//
// The seam tests call runCapture with a stand-in boundary and docker, and
// record the exact docker argv, so no network is built. runTool passes only
// { reach, targets, hosts, secrets } on, so its seams cannot be set from there.
// The last tests build the real boundary and run a real container in capture
// mode (no GitHub request).
//
//   node --test spike/test/capture-mode.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTool } from "../lib/wrap.mjs";
import { captureArgs, assertCaptureReach, CAPTURE_TARGETS, egressSummary, scrub, runNamed, runCapture, holdsSecret, cleanOutput, LEAK_REASON, GITHUB_CAPTURE_HOSTS } from "../lib/capture.mjs";

const FAKE_TOKEN = "ghp_FAKEtokenFAKEtokenFAKEtokenFAKE1234";
const reach = { granted: true, scope: ["hemaaanth/touchstone"] };
const targets = [{ owner: "hemaaanth", repo: "touchstone" }];

// A stand-in boundary and docker. It records each docker argv and the env the
// docker CLI got, and returns what the "tool" printed.
function seams({ print = "", printErr = "", code = 0, timedOut = false } = {}) {
  const calls = [], built = [];
  return {
    calls, built,
    confine: async (opts) => { built.push(opts); return { netClient: "touchstone-reach-client-test", proxyName: "touchstone-reach-proxy-test", gateUrl: "http://scope-gate:8080", stop: async () => { built.push("stopped"); } }; },
    exec: async (args, { env }) => {
      calls.push({ args, env });
      if (args[0] === "logs") return { code: 0, stdout: "", stderr: '__TOUCHSTONE_SCOPE__ {"host":"api.github.com","decision":"allow"}\n__TOUCHSTONE_SCOPE__ {"host":"api.osv.dev","decision":"block"}\n' };
      if (args[0] === "rm") return { code: 0, stdout: "", stderr: "" };
      return { code, stdout: print.replace("$TOKEN", env.GITHUB_TOKEN ?? ""), stderr: printErr.replace("$TOKEN", env.GITHUB_TOKEN ?? ""), timedOut };
    },
  };
}

test("capture argv: network on only through the grant's boundary, --pull=never always, token by name only", async () => {
  const s = seams({ print: "{}" });
  const r = await runCapture({ image: "touchstone/scorecard:5.6.0", cmd: ["--repo=github.com/hemaaanth/touchstone", "--format=json"], user: "1000:1000",
    reach, targets, hosts: ["api.github.com"], secrets: { GITHUB_TOKEN: FAKE_TOKEN }, confine: s.confine, exec: s.exec });
  assert.equal(r.code, 0);
  assert.equal(r.refused, undefined);
  const { args, env } = s.calls[0];
  assert.equal(args[0], "run");
  assert.ok(args.includes("--pull=never"));
  assert.equal(args[args.indexOf("--network") + 1], "touchstone-reach-client-test");
  assert.equal(args.filter((a) => a === "--network").length, 1);
  assert.ok(!args.includes("none") && !args.includes("host") && !args.includes("bridge"));
  for (const flag of ["--cap-drop", "--security-opt", "--pids-limit", "--memory", "--user"]) assert.ok(args.includes(flag), flag);
  assert.ok(args.includes("HTTPS_PROXY=http://scope-gate:8080"));
  // The token is an env NAME in argv. Its value is only in the docker CLI env.
  assert.equal(args[args.indexOf("GITHUB_TOKEN") - 1], "-e");
  assert.ok(!args.join(" ").includes(FAKE_TOKEN), "token value is never in argv");
  assert.equal(env.GITHUB_TOKEN, FAKE_TOKEN);
  assert.deepEqual(s.built[0], { allowedHosts: ["api.github.com"] });
  assert.equal(s.built.at(-1), "stopped", "the boundary is torn down");
  assert.deepEqual(r.egress, { tunnels: { "api.github.com": 1 }, blocked: { "api.osv.dev": 1 } });
});

// runTool passes on only the grant, targets, hosts and secrets. A caller's own
// confine or exec is dropped, so it cannot pick its own open network. Every
// docker call here goes to a PATH shim that logs it and does nothing, so the
// real boundary fails to start and the capture is refused.
test("runTool drops a caller's confine and exec: only { reach, targets, hosts, secrets } reach runCapture", async () => {
  const dir = mkdtempSync(join(tmpdir(), "touchstone-cap-shim-"));
  const log = join(dir, "argv.jsonl");
  writeFileSync(join(dir, "docker"), `#!/usr/bin/env node\nrequire("fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
  chmodSync(join(dir, "docker"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  let used = 0;
  try {
    const confine = async () => { used++; return { netClient: "my-own-open-net", proxyName: null, gateUrl: "http://scope-gate:8080", stop: async () => {} }; };
    const exec = async () => { used++; return { code: 0, stdout: "{}", stderr: "" }; };
    const r = await runTool({ image: "x:1", cmd: [], user: "1:1", capture: { reach, targets, hosts: ["api.github.com"], confine, exec } });
    assert.equal(used, 0, "the caller's seams were not used");
    assert.match(r.refused ?? "", /could not build the egress boundary/);
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
    assert.ok(calls.some((a) => a[0] === "network"), "the real boundary was tried (against the shim)");
    assert.ok(!JSON.stringify(calls).includes("my-own-open-net"));
  } finally { process.env.PATH = path; rmSync(dir, { recursive: true, force: true }); }
});

test("capture argv has no token flag when the tool needs no secret", async () => {
  const s = seams({ print: "{}" });
  await runCapture({ image: "x:1", cmd: [], user: "1:1", reach, targets, hosts: ["api.github.com"], confine: s.confine, exec: s.exec });
  assert.ok(!s.calls[0].args.includes("GITHUB_TOKEN"));
});

test("no grant, wrong scope, a non-GitHub host or a missing token: refused before any container or network", async () => {
  const bad = [
    { reach: undefined, targets, hosts: ["api.github.com"] },
    { reach: { granted: "yes", scope: ["hemaaanth/touchstone"] }, targets, hosts: ["api.github.com"] },
    { reach: { granted: true, scope: ["hemaaanth/other"] }, targets, hosts: ["api.github.com"] },
    { reach, targets: [{ owner: "hemaaanth", repo: null }], hosts: ["api.github.com"] },
    { reach, targets: [], hosts: ["api.github.com"] },
    { reach, targets, hosts: [] },
    { reach, targets, hosts: ["api.github.com", "example.com"] },
    { reach, targets, hosts: ["api.github.com"], secrets: { GITHUB_TOKEN: "" } },
    { reach, targets, hosts: ["api.github.com"], secrets: { GITHUB_TOKEN: undefined } },
  ];
  for (const capture of bad) {
    const s = seams();
    const r = await runCapture({ image: "x:1", cmd: [], user: "1:1", ...capture, confine: s.confine, exec: s.exec });
    assert.equal(r.code, -1);
    assert.ok(r.refused, JSON.stringify(capture.reach));
    assert.equal(s.built.length, 0, "no boundary built");
    assert.equal(s.calls.length, 0, "no docker call");
  }
  // capture: true or {} is not a grant either.
  for (const capture of [true, {}]) assert.ok((await runTool({ image: "x:1", cmd: [], user: "1:1", capture })).refused);
});

test("the token value never appears in what a capture returns, even when the tool prints it", async () => {
  const s = seams({ print: 'token is $TOKEN {"ok":1}', printErr: "auth $TOKEN failed" });
  const r = await runCapture({ image: "x:1", cmd: [], user: "1:1", reach, targets, hosts: ["api.github.com"], secrets: { GITHUB_TOKEN: FAKE_TOKEN }, confine: s.confine, exec: s.exec });
  assert.ok(!JSON.stringify(r).includes(FAKE_TOKEN));
  assert.match(r.stdout, /\[REDACTED\]/);
  assert.match(r.stderr, /\[REDACTED\]/);
});

test("every capture removes its container by name, even one that ended on its own", async () => {
  const s = seams({ code: 1, timedOut: true });
  const r = await runCapture({ image: "x:1", cmd: [], user: "1:1", reach, targets, hosts: ["api.github.com"], confine: s.confine, exec: s.exec });
  assert.equal(r.timedOut, true);
  const name = s.calls[0].args[s.calls[0].args.indexOf("--name") + 1];
  assert.deepEqual(s.calls.find((c) => c.args[0] === "rm").args, ["rm", "-f", name]);
});

// A docker CLI that never returns until its container is removed: the real
// shape when PID 1 ignores SIGTERM. Our own timer must remove it.
test("runNamed: at timeoutMs the container is removed by name and the call reports timedOut", async () => {
  let release;
  const calls = [];
  const exec = async (args) => {
    calls.push(args);
    if (args[0] === "rm") { release?.(); return { code: 0, stdout: "", stderr: "" }; }
    return new Promise((r) => { release = () => r({ code: 137, stdout: "", stderr: "", timedOut: false }); });
  };
  const t0 = Date.now();
  const r = await runNamed(["run", "--name", "n1", "x:1"], "n1", { timeoutMs: 200, exec });
  assert.ok(Date.now() - t0 < 2_000);
  assert.equal(r.timedOut, true);
  assert.deepEqual(calls.filter((a) => a[0] === "rm")[0], ["rm", "-f", "n1"]);
});

// On a busy host the container can appear after the first rm. The rm repeats
// until the docker CLI returns.
test("runNamed: a container created after the first rm is still removed", async () => {
  let rms = 0, release;
  const exec = async (args) => {
    if (args[0] === "rm") { rms++; if (rms >= 3) release?.(); return { code: 1, stdout: "", stderr: "No such container" }; }
    return new Promise((r) => { release = () => r({ code: 137, stdout: "", stderr: "" }); });
  };
  const r = await runNamed(["run", "--name", "n2", "x:1"], "n2", { timeoutMs: 100, exec });
  assert.equal(r.timedOut, true);
  assert.ok(rms >= 3);
});

test("captureArgs refuses an open network and a secret passed as a plain env value", () => {
  const base = { name: "n", image: "i", cmd: [], network: "touchstone-reach-client-x", gate: "http://scope-gate:8080", user: "1:1" };
  for (const network of ["none", "host", "bridge", "default", "container:abc", ""]) assert.throws(() => captureArgs({ ...base, network }));
  assert.throws(() => captureArgs({ ...base, env: { GITHUB_TOKEN: "x" }, secretNames: ["GITHUB_TOKEN"] }), /secret/);
  assert.throws(() => captureArgs({ ...base, env: { "A=B": "x" } }));
  assert.ok(captureArgs(base).includes("--pull=never"));
});

test("grant check, egress parse and scrub", () => {
  assert.doesNotThrow(() => assertCaptureReach({ granted: true, scope: ["Hemaaanth"] }, targets));
  assert.throws(() => assertCaptureReach({ granted: true, scope: ["hemaaanth/touchstone"] }, [{ owner: "hemaaanth", repo: null }]));
  assert.throws(() => assertCaptureReach(reach, [{ owner: "../x", repo: "y" }]));
  assert.deepEqual(GITHUB_CAPTURE_HOSTS, ["api.github.com", "codeload.github.com"]);
  assert.deepEqual(egressSummary("junk\n__TOUCHSTONE_SCOPE__ {bad\n"), { tunnels: {}, blocked: {} });
  assert.equal(scrub("a SECRETVALUE b SECRETVALUE", ["SECRETVALUE"]), "a [REDACTED] b [REDACTED]");
});

// A scrub only replaces the whole value. Encoded or split copies must still be
// caught, and then the whole output is dropped.
// A grant the caller wrote for itself is not enough: the token goes only to
// a capture of hemaaanth/touchstone.
test("capture targets: a self-granted repo outside CAPTURE_TARGETS is refused before any boundary exists", async () => {
  assert.deepEqual(CAPTURE_TARGETS, ["hemaaanth/touchstone"]);
  const s = seams({ print: "{}" });
  for (const [scope, t] of [[["torvalds/linux"], { owner: "torvalds", repo: "linux" }], [["hemaaanth"], { owner: "hemaaanth", repo: "other" }], [["hemaaanth"], { owner: "hemaaanth", repo: null }]]) {
    const r = await runCapture({ image: "i:1", cmd: [], user: "1:1", reach: { granted: true, scope }, targets: [t], hosts: ["api.github.com"], secrets: { GITHUB_TOKEN: FAKE_TOKEN }, confine: s.confine, exec: s.exec });
    assert.match(r.refused ?? "", /not a capture target/, JSON.stringify(t));
  }
  assert.equal(s.built.length, 0, "no boundary was built");
  assert.equal(s.calls.length, 0, "docker was never called");
  assert.doesNotThrow(() => assertCaptureReach({ granted: true, scope: ["HEMAAANTH/Touchstone"] }, [{ owner: "Hemaaanth", repo: "TouchStone" }]));
});

test("leak check: base64, base64url, split and URL-encoded copies of the token are caught", () => {
  const b64 = (s) => Buffer.from(s).toString("base64");
  const half = FAKE_TOKEN.length >> 1;
  const leaks = [
    b64(FAKE_TOKEN),
    Buffer.from(FAKE_TOKEN).toString("base64url"),
    b64(`x-access-token:${FAKE_TOKEN}`), b64(`a:${FAKE_TOKEN}`), b64(`ab:${FAKE_TOKEN}`),
    `${FAKE_TOKEN.slice(0, half)}\n${FAKE_TOKEN.slice(half)}`,
    FAKE_TOKEN.slice(5, 17),
  ];
  for (const l of leaks) assert.equal(holdsSecret(`out ${l} end`, [FAKE_TOKEN]), true, l);
  const odd = "tok/en+with=chars&more";
  assert.equal(holdsSecret(`?t=${encodeURIComponent(odd)}`, [odd]), true);
  assert.equal(holdsSecret('{"ok":true,"score":7} [REDACTED]', [FAKE_TOKEN]), false);
  assert.equal(holdsSecret(FAKE_TOKEN.slice(0, 11), [FAKE_TOKEN]), false, "an 11-character piece is too short to be sure");
  const c = cleanOutput({ stdout: `fine\n${b64(FAKE_TOKEN)}`, stderr: "x" }, [FAKE_TOKEN]);
  assert.deepEqual(c, { stdout: "", stderr: "", leaked: LEAK_REASON });
  assert.deepEqual(cleanOutput({ stdout: `a ${FAKE_TOKEN}`, stderr: "" }, [FAKE_TOKEN]), { stdout: "a [REDACTED]", stderr: "" });
});

test("runCapture drops all output when a part of the token is left after the scrub", async () => {
  const half = FAKE_TOKEN.length >> 1;
  for (const print of [Buffer.from("$TOKEN").toString("base64"), `ok ${FAKE_TOKEN.slice(0, half)}\n${FAKE_TOKEN.slice(half)}`]) {
    const s = seams({ printErr: "" });
    const exec = async (args, o) => (args[0] === "run" ? { code: 0, stdout: print === Buffer.from("$TOKEN").toString("base64") ? Buffer.from(o.env.GITHUB_TOKEN).toString("base64") : print, stderr: "", timedOut: false } : s.exec(args, o));
    const r = await runCapture({ image: "i:1", cmd: [], user: "1:1", reach, targets, hosts: ["api.github.com"], secrets: { GITHUB_TOKEN: FAKE_TOKEN }, confine: s.confine, exec });
    assert.equal(r.leaked, LEAK_REASON);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
    assert.ok(!holdsSecret(JSON.stringify(r), [FAKE_TOKEN]));
  }
});

const hasDocker = (() => {
  try { for (const i of ["alpine:3.20", "node:20-slim"]) execFileSync("docker", ["image", "inspect", i], { stdio: "ignore" }); return true; } catch { return false; }
})();

// Real boundary, real container, no GitHub request. The container gets the
// token by env name, prints it (scrubbed), and finds no raw route off its network.
test("real capture container: token arrives by env name, output is scrubbed, a raw socket has no route", { skip: !hasDocker && "docker or images missing", timeout: 90_000 }, async () => {
  const script = 'echo "len=${#GITHUB_TOKEN}"; echo "$GITHUB_TOKEN"; if nc -w 3 1.1.1.1 443 </dev/null; then echo raw-open; else echo raw-blocked; fi';
  const r = await runTool({ image: "alpine:3.20", cmd: ["sh", "-c", script], timeoutMs: 60_000,
    capture: { reach, targets, hosts: ["api.github.com"], secrets: { GITHUB_TOKEN: FAKE_TOKEN } } });
  assert.equal(r.refused, undefined, r.refused);
  assert.match(r.stdout, new RegExp(`len=${FAKE_TOKEN.length}`));
  assert.match(r.stdout, /\[REDACTED\]/);
  assert.match(r.stdout, /raw-blocked/);
  assert.ok(!JSON.stringify(r).includes(FAKE_TOKEN));
});

// The real fault: `docker run` of a PID 1 that ignores SIGTERM. A plain
// execFile timeout leaves the CLI and the container running for a minute.
// Capture mode must return near timeoutMs and leave no container behind.
test("real capture timeout: returns near timeoutMs and leaves no container", { skip: !hasDocker && "docker or images missing", timeout: 90_000 }, async () => {
  const before = execFileSync("docker", ["ps", "-aq", "--filter", "name=touchstone-capture-"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const t0 = Date.now();
  const r = await runTool({ image: "alpine:3.20", cmd: ["sleep", "60"], timeoutMs: 3_000,
    capture: { reach, targets, hosts: ["api.github.com"] } });
  const took = Date.now() - t0;
  assert.equal(r.refused, undefined, r.refused);
  assert.equal(r.timedOut, true);
  assert.ok(took < 20_000, `took ${took} ms`);
  const after = execFileSync("docker", ["ps", "-aq", "--filter", "name=touchstone-capture-"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  assert.deepEqual(after.filter((id) => !before.includes(id)), []);
});
