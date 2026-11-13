// Capture mode in runTool(): the only path where a pack tool gets the network.
//
// The seam tests record the exact docker argv runTool hands to docker, with a
// stand-in boundary, so no network is built. The last test builds the real
// boundary and runs a real container in capture mode (no GitHub request).
//
//   node --test spike/test/capture-mode.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { runTool } from "../lib/wrap.mjs";
import { captureArgs, assertCaptureReach, egressSummary, scrub, runNamed, GITHUB_CAPTURE_HOSTS } from "../lib/capture.mjs";

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
  const r = await runTool({ image: "touchstone/scorecard:5.6.0", cmd: ["--repo=github.com/hemaaanth/touchstone", "--format=json"], user: "1000:1000",
    capture: { reach, targets, hosts: ["api.github.com"], secrets: { GITHUB_TOKEN: FAKE_TOKEN }, confine: s.confine, exec: s.exec } });
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

test("capture argv has no token flag when the tool needs no secret", async () => {
  const s = seams({ print: "{}" });
  await runTool({ image: "x:1", cmd: [], user: "1:1", capture: { reach, targets, hosts: ["api.github.com"], confine: s.confine, exec: s.exec } });
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
    const r = await runTool({ image: "x:1", cmd: [], user: "1:1", capture: { ...capture, confine: s.confine, exec: s.exec } });
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
  const r = await runTool({ image: "x:1", cmd: [], user: "1:1", capture: { reach, targets, hosts: ["api.github.com"], secrets: { GITHUB_TOKEN: FAKE_TOKEN }, confine: s.confine, exec: s.exec } });
  assert.ok(!JSON.stringify(r).includes(FAKE_TOKEN));
  assert.match(r.stdout, /\[REDACTED\]/);
  assert.match(r.stderr, /\[REDACTED\]/);
});

test("every capture removes its container by name, even one that ended on its own", async () => {
  const s = seams({ code: 1, timedOut: true });
  const r = await runTool({ image: "x:1", cmd: [], user: "1:1", capture: { reach, targets, hosts: ["api.github.com"], confine: s.confine, exec: s.exec } });
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
