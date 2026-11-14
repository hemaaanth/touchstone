// Tests for the shared tool wrapper. sarifLeads is pure. runTool needs Docker
// and the small debian image; it is skipped when Docker is not there.
//
//   node --test spike/test/wrap.test.mjs
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { entrypointFlag, hostPins, mountFlags, runTool, sarifLeads } from "../lib/wrap.mjs";
import { planRemote } from "../lib/daytona.mjs";
import { mergeStatic } from "../lib/ensemble.mjs";

const SPIKE = join(dirname(fileURLToPath(import.meta.url)), "..");

const SARIF = {
  version: "2.1.0",
  runs: [{
    tool: { driver: { name: "x", rules: [
      { id: "aws-key", properties: { "security-severity": "8.5", precision: "high" }, shortDescription: { text: "AWS key" } },
      { id: "unpinned-action", defaultConfiguration: { level: "note" } },
    ] } },
    results: [
      { ruleId: "aws-key", message: { text: "AWS key in config" }, locations: [{ physicalLocation: { artifactLocation: { uri: "file:///work/src/config.js" }, region: { startLine: 12 } } }] },
      { ruleId: "unpinned-action", message: { text: "uses: actions/checkout@main" }, locations: [{ physicalLocation: { artifactLocation: { uri: ".github/workflows/ci.yml" }, region: { startLine: 7 } } }] },
      { ruleId: "no-rule", level: "error", message: { text: "bare" } },
    ],
  }],
};

test("sarifLeads maps severity, level, path and line into the lead shape", () => {
  const leads = sarifLeads(JSON.stringify(SARIF), "Tool");
  assert.equal(leads.length, 3);
  assert.deepEqual(leads[0], {
    engine: "Tool", check: "aws-key", impact: "High", confidence: "high",
    file: "src/config.js", lines: [12], where: null, description: "AWS key in config",
  });
  assert.equal(leads[1].impact, "Low");
  assert.equal(leads[1].file, ".github/workflows/ci.yml");
  assert.equal(leads[2].impact, "High");
  assert.deepEqual(leads[2].lines, []);
});

test("SARIF leads from two engines merge and corroborate in the ensemble", () => {
  const a = sarifLeads(SARIF, "EngineA").slice(0, 1);
  const b = sarifLeads(SARIF, "EngineB").slice(0, 1).map((l) => ({ ...l, lines: [13] }));
  const merged = mergeStatic(a, b);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].corroborated, true);
});

const hasDocker = (() => {
  try { execFileSync("docker", ["image", "inspect", "debian:bookworm-slim"], { stdio: "ignore" }); return true; } catch { return false; }
})();

test("runTool passes --pull=never directly after run --rm", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wrap-args-"));
  const record = join(dir, "args");
  const path = process.env.PATH;
  try {
    writeFileSync(join(dir, "docker"), '#!/bin/sh\nprintf "%s\\n" "$@" > "' + record + '"\nexit 0\n', { mode: 0o755 });
    process.env.PATH = dir + ":" + path;
    const result = await runTool({ image: "example.invalid/tool@sha256:" + "0".repeat(64), cmd: ["true"] });
    assert.equal(result.code, 0);
  } finally {
    process.env.PATH = path;
  }
  try {
    const args = readFileSync(record, "utf8").trim().split("\n");
    assert.deepEqual(args.slice(0, 3), ["run", "--rm", "--pull=never"]);
    assert.match(args[args.indexOf("--name") + 1], /^touchstone-tool-[0-9a-f]{12}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing image fails without a registry pull", { skip: !hasDocker && "no docker" }, async () => {
  const result = await runTool({ image: "touchstone-missing@sha256:" + "1".repeat(64), cmd: ["true"] });
  assert.notEqual(result.code, 0);
  // A failed pull also says "not found", so match the no-pull error exactly.
  assert.match(result.stderr, /No such image: touchstone-missing@sha256:1{64}/);
  assert.doesNotMatch(result.stderr, /Pulling|pull access denied/);
});

// The tool's PID 1 ignores SIGTERM. A timeout must still stop it and say so.
test("a timeout removes the container and returns near timeoutMs", { skip: !hasDocker && "no docker" }, async () => {
  const mark = "touchstone-timeout-" + process.pid;
  const started = Date.now();
  const result = await runTool({ image: "debian:bookworm-slim", cmd: ["sh", "-c", "trap '' TERM; sleep 40 # " + mark], timeoutMs: 2000 });
  const took = Date.now() - started;
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
  // Without the fix this took 25 s. A loaded host has taken 6 s with it.
  assert(took < 20000, "returned after " + took + " ms");
  const left = execFileSync("docker", ["ps", "-a", "--no-trunc", "--format", "{{.Command}}"], { encoding: "utf8" });
  assert.equal(left.includes(mark), false, "the container is still there");
});

// A timeout can fire before Docker created the container. No "Created"
// container may stay behind. The mark is in the command, so ps -a shows it.
test("a 50 ms timeout leaves no container behind", { skip: !hasDocker && "no docker" }, async () => {
  const mark = "touchstone-timeout50-" + process.pid;
  const result = await runTool({ image: "debian:bookworm-slim", cmd: ["sh", "-c", "trap '' TERM; sleep 40 # " + mark], timeoutMs: 50 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
  const left = () => execFileSync("docker", ["ps", "-a", "--no-trunc", "--format", "{{.Names}} {{.Status}} {{.Command}}"], { encoding: "utf8" }).split("\n").filter((l) => l.includes(mark));
  assert.deepEqual(left(), [], "a container is left at return");
  await new Promise((r) => setTimeout(r, 3000));
  assert.deepEqual(left(), [], "a container appeared after return");
});

test("runTool mounts the workspace and has no network", { skip: !hasDocker && "no docker" }, async () => {
  const ws = mkdtempSync(join(tmpdir(), "wrap-"));
  try {
    writeFileSync(join(ws, "hello.txt"), "hi");
    const read = await runTool({ image: "debian:bookworm-slim", cmd: ["cat", "hello.txt"], ws });
    assert.equal(read.code, 0);
    assert.equal(read.stdout, "hi");
    const net = await runTool({ image: "debian:bookworm-slim", cmd: ["sh", "-c", "cat /sys/class/net/*/operstate 2>/dev/null; ls /sys/class/net"] });
    assert.deepEqual(net.stdout.trim().split(/\s+/).filter((x) => x !== "unknown"), ["lo"]);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// addHosts pins a name to a checked address inside the container, and the
// container gets a resolver where nothing listens, so no other name resolves.
test("addHosts adds one --add-host per pair and a dead resolver, and checks its input", async () => {
  assert.deepEqual(hostPins([]), []);
  assert.deepEqual(hostPins([["www.example.com", "93.184.216.34"], ["v6.example.com", "2001:db8::7"]]),
    ["--add-host", "www.example.com:93.184.216.34", "--add-host", "v6.example.com:2001:db8::7", "--dns", "127.0.0.1"]);
  for (const bad of [[["", "1.2.3.4"]], [["a b", "1.2.3.4"]], [["x.com:1.1.1.1", "1.2.3.4"]], [["--privileged", "1.2.3.4"]], [["1.2.3.4", "1.2.3.4"]],
    [["x.com", "not-an-ip"]], [["x.com", "1.2.3.4 --privileged"]], [["x.com"]], ["x.com"], "x.com:1.2.3.4"]) {
    assert.throws(() => hostPins(bad), /addHosts/, JSON.stringify(bad));
  }
  // A zone id parses as an IP (isIP accepts it) but is refused with a clear message.
  assert.throws(() => hostPins([["x.com", "fe80::1%eth0"]]), /IPv6 zone id is not allowed/);
  // runTool puts the flags in the argv it runs.
  const dir = mkdtempSync(join(tmpdir(), "wrap-pins-"));
  const record = join(dir, "args");
  const path = process.env.PATH;
  try {
    writeFileSync(join(dir, "docker"), '#!/bin/sh\nprintf "%s\\n" "$@" > "' + record + '"\nexit 0\n', { mode: 0o755 });
    process.env.PATH = dir + ":" + path;
    await runTool({ image: "example.invalid/tool@sha256:" + "0".repeat(64), cmd: ["true"], addHosts: [["www.example.com", "93.184.216.34"]] });
    const args = readFileSync(record, "utf8").trim().split("\n");
    const image = args.indexOf("example.invalid/tool@sha256:" + "0".repeat(64));
    const at = args.indexOf("--add-host");
    assert(at > 0 && at < image, "the pin comes before the image");
    assert.deepEqual(args.slice(at, at + 4), ["--add-host", "www.example.com:93.184.216.34", "--dns", "127.0.0.1"]);
    await assert.rejects(runTool({ image: "x", cmd: [], addHosts: [["x.com", "nope"]] }), /addHosts/);
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a call with addHosts never goes to Daytona: the planner keeps it local", () => {
  const args = ["run", "--rm", "--pull=never", "--network", "none", ...hostPins([["www.example.com", "93.184.216.34"]]), "img@sha256:" + "0".repeat(64), "true"];
  assert.ok(planRemote(args, null, "/remote").local, "a flag the planner does not know keeps the call on this host");
});

test("entrypoint adds --entrypoint before the image, checks its input, and no option means the old argv", async () => {
  assert.deepEqual(entrypointFlag(null), []);
  assert.deepEqual(entrypointFlag("drill"), ["--entrypoint", "drill"]);
  assert.deepEqual(entrypointFlag("/usr/bin/drill"), ["--entrypoint", "/usr/bin/drill"]);
  for (const bad of ["drill x", "a;b", "a|b", "$(x)", "`x`", "a&b", "drill\n", "", "../drill", "-x", "--privileged", ".", "..", "/a/../b", "/", "//x", 7, {}]) {
    assert.throws(() => entrypointFlag(bad), /entrypoint/, JSON.stringify(bad));
  }
  const dir = mkdtempSync(join(tmpdir(), "wrap-entry-"));
  const record = join(dir, "args");
  const path = process.env.PATH;
  try {
    writeFileSync(join(dir, "docker"), '#!/bin/sh\nprintf "%s\\n" "$@" > "' + record + '"\nexit 0\n', { mode: 0o755 });
    process.env.PATH = dir + ":" + path;
    const image = "example.invalid/tool@sha256:" + "0".repeat(64);
    await runTool({ image, cmd: ["CAA", "x"], entrypoint: "drill" });
    const args = readFileSync(record, "utf8").trim().split("\n");
    const at = args.indexOf("--entrypoint"), img = args.indexOf(image);
    assert(at > 0 && at < img, "the entrypoint comes before the image");
    assert.deepEqual(args.slice(at, at + 2), ["--entrypoint", "drill"]);
    assert.deepEqual(args.slice(0, 3), ["run", "--rm", "--pull=never"]);
    // A bad entrypoint throws before any docker call.
    await assert.rejects(runTool({ image, cmd: [], entrypoint: "a;b" }), /entrypoint/);
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mounts: a host path under a caller root is read-only, an allowed volume may be rw, and every other source is refused", () => {
  const base = mkdtempSync(join(tmpdir(), "wrap-mounts-"));
  const outside = mkdtempSync(join(tmpdir(), "wrap-outside-"));
  try {
    const std = join(base, "std");
    mkdirSync(std);
    const real = realpathSync(std);
    assert.deepEqual(mountFlags([]), []);
    // The two allowed forms. No mode means read-only.
    assert.deepEqual(mountFlags([[std, "/forge-std/src"]], [base]), ["-v", `${real}:/forge-std/src:ro`]);
    assert.deepEqual(mountFlags([[std, "/s", "ro"]], [base]), ["-v", `${real}:/s:ro`]);
    assert.deepEqual(mountFlags([["foundry-svm", "/home/foundry/.svm", "rw"]]), ["-v", "foundry-svm:/home/foundry/.svm"]);
    assert.deepEqual(mountFlags([["touchstone_svm_cache", "/svm"]]), ["-v", "touchstone_svm_cache:/svm:ro"]);
    // A symlink under the root that points outside it is resolved first, then refused.
    symlinkSync(outside, join(base, "link"));
    const refusals = [
      [[["/var/run/docker.sock", "/s"]], [base], /docker socket|outside the allowed roots/],
      [[["/run/docker.sock", "/s"]], ["/run"], /docker socket/],
      [[["/", "/s"]], [base], /source must be|refused/],
      [[[homedir(), "/s"]], [base], /refused/],
      [[[join(SPIKE, "data"), "/s"]], [base], /refused/],
      [[[join(SPIKE, "data", "grants.json"), "/s"]], [base], /refused/],
      [[[outside, "/s"]], [base], /outside the allowed roots/],
      [[[join(base, "link"), "/s"]], [base], /outside the allowed roots/],
      [[[std, "/s"]], [], /outside the allowed roots/],
      [[[join(base, "missing"), "/s"]], [base], /does not exist/],
      [[[std, "/s", "rw"]], [base], /read-only; rw is only for/],
      [[["other-volume", "/s", "rw"]], [], /allowed volume/],
      [[["other-volume", "/s"]], [], /allowed volume/],
      [[[std, "/s"]], ["/"], /bad root|root is too wide/],
      [[[std, "/s"]], [homedir()], /root is too wide/],
      [[["/a:/b", "/c"]], [base], /source must be/],
      [[[std, "/c,ro"]], [base], /bad target/],
      [[[std, "c"]], [base], /bad target/],
      [[[std, "/c", "x"]], [base], /mode must be/],
      [[[std, "/c", "ro", "x"]], [base], /mode must be/],
      [[[std]], [base], /bad target/],
      [["/a:/c"], [base], /bad target/],
      ["x", [base], /mounts must be a list/],
    ];
    for (const [mounts, roots, why] of refusals) assert.throws(() => mountFlags(mounts, roots), why, JSON.stringify([mounts, roots]));
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("runTool: no mounts option gives the old argv word for word; mounts follow the workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wrap-argv-"));
  const record = join(dir, "args");
  const path = process.env.PATH;
  try {
    writeFileSync(join(dir, "docker"), '#!/bin/sh\nprintf "%s\\n" "$@" > "' + record + '"\nexit 0\n', { mode: 0o755 });
    process.env.PATH = dir + ":" + path;
    const image = "example.invalid/tool@sha256:" + "0".repeat(64);
    const user = `${process.getuid()}:${process.getgid()}`;
    await runTool({ image, cmd: ["x", "y"], ws: dir, env: { A: "1" } });
    const old = readFileSync(record, "utf8").trim().split("\n");
    const name = old[old.indexOf("--name") + 1];
    assert.deepEqual(old, ["run", "--rm", "--pull=never", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--pids-limit", "512", "--memory", "2g", "--user", user, "--name", name, "-v", `${dir}:/work`, "-w", "/work", "-e", "A=1", image, "x", "y"]);
    mkdirSync(join(dir, "std"));
    await runTool({ image, cmd: ["x", "y"], ws: dir, env: { A: "1" }, mounts: [[join(dir, "std"), "/std"]] });
    const args = readFileSync(record, "utf8").trim().split("\n");
    const at = args.indexOf(`${dir}:/work`) + 3;
    assert.deepEqual(args.slice(at, at + 2), ["-v", `${realpathSync(join(dir, "std"))}:/std:ro`]);
    await assert.rejects(runTool({ image, cmd: [], ws: dir, mounts: [["/var/run/docker.sock", "/s"]] }), /mounts/);
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
});
