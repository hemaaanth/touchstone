// Tests for the shared tool wrapper. sarifLeads is pure. runTool needs Docker
// and the small debian image; it is skipped when Docker is not there.
//
//   node --test spike/test/wrap.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTool, sarifLeads } from "../lib/wrap.mjs";
import { mergeStatic } from "../lib/ensemble.mjs";

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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing image fails without a registry pull", { skip: !hasDocker && "no docker" }, async () => {
  const result = await runTool({ image: "touchstone-missing@sha256:" + "1".repeat(64), cmd: ["true"] });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Unable to find image|No such image|not found/i);
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

test("runTool names its container and planRemote drops that name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wrap-name-"));
  const record = join(dir, "args");
  const path = process.env.PATH;
  try {
    writeFileSync(join(dir, "docker"), '#!/bin/sh\nprintf "%s\\n" "$@" > "' + record + '"\nexit 0\n', { mode: 0o755 });
    process.env.PATH = dir + ":" + path;
    await runTool({ image: "img:1", cmd: ["true"] });
  } finally {
    process.env.PATH = path;
  }
  try {
    const args = readFileSync(record, "utf8").trim().split("\n");
    const at = args.indexOf("--name");
    assert.ok(at > 0);
    assert.match(args[at + 1], /^touchstone-tool-[0-9a-f]{12}$/);
    const { planRemote } = await import("../lib/daytona.mjs");
    const plan = planRemote(args, null, null);
    assert.equal(plan.local, null);
    assert.ok(!plan.args.includes("--name"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a runTool timeout stops a PID 1 that ignores SIGTERM and leaves no container", { skip: !hasDocker && "no docker", timeout: 60_000 }, async () => {
  const mark = `TS_MARK=${process.pid}-${Date.now()}`;
  const mine = () => {
    const ids = execFileSync("docker", ["ps", "-aq", "--filter", "name=touchstone-tool-"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    if (!ids.length) return [];
    let out = "";
    try { out = execFileSync("docker", ["inspect", "--format", "{{.Name}} {{json .Config.Env}}", ...ids], { encoding: "utf8" }); } catch (e) { out = String(e.stdout ?? ""); }
    return out.split("\n").filter((l) => l.includes(mark));
  };
  const t0 = Date.now();
  const r = await runTool({ image: "debian:bookworm-slim", cmd: ["sh", "-c", "trap '' TERM; while :; do sleep 1; done"], env: { TS_MARK: mark.slice(8) }, timeoutMs: 3000 });
  const took = Date.now() - t0;
  assert.equal(r.timedOut, true);
  assert.ok(took < 3000 + 6000, `returned after ${took} ms`);
  assert.deepEqual(mine(), []);
});
