// lib/lab-net.mjs: every lab network gets a small random subnet from a range the
// Docker default pools do not use, retries on overlap, and fails closed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createLabNetwork, removeLabNetwork, randomLabSubnet, trackedLabNetworks, LAB_PREFIX, MAX_ATTEMPTS } from "../lib/lab-net.mjs";

const inRange = (subnet) => {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(subnet);
  assert.ok(m, subnet);
  const [a, b, c, d, p] = m.slice(1).map(Number);
  assert.equal(p, LAB_PREFIX);
  assert.equal(a, 10);
  assert.ok(b >= 208 && b <= 223, `second octet ${b} outside 10.208.0.0/12`);
  assert.ok(c >= 0 && c <= 255);
  assert.equal(d % 16, 0, "aligned to /28");
};

test("subnets are /28 blocks inside 10.208.0.0/12, edges included", () => {
  assert.equal(randomLabSubnet(() => 0), "10.208.0.0/28");
  assert.equal(randomLabSubnet((n) => n - 1), "10.223.255.240/28");
  for (let i = 0; i < 2000; i++) inRange(randomLabSubnet());
});

const fakeDocker = (replies) => {
  const calls = [];
  const docker = async (args) => { calls.push(args); return replies.shift() ?? { code: 0, stdout: "id\n", stderr: "" }; };
  return { calls, docker };
};

test("passes --subnet and keeps the caller's isolation flags", async () => {
  const { calls, docker } = fakeDocker([]);
  const r = await createLabNetwork("touchstone-unit-a", ["--internal"], { docker });
  assert.equal(r.code, 0);
  inRange(r.subnet);
  assert.deepEqual(calls, [["network", "create", "--internal", "--subnet", r.subnet, "touchstone-unit-a"]]);
  const { calls: c2, docker: d2 } = fakeDocker([]);
  const r2 = await createLabNetwork("touchstone-unit-b", ["--opt", "com.docker.network.bridge.enable_icc=false"], { docker: d2 });
  assert.deepEqual(c2[0], ["network", "create", "--opt", "com.docker.network.bridge.enable_icc=false", "--subnet", r2.subnet, "touchstone-unit-b"]);
  await removeLabNetwork("touchstone-unit-a", { docker });
  await removeLabNetwork("touchstone-unit-b", { docker: d2 });
  assert.deepEqual(trackedLabNetworks(), []);
});

test("retries with a new subnet on overlap", async () => {
  const overlap = { code: 1, stdout: "", stderr: "Error response from daemon: invalid pool request: Pool overlaps with other one on this address space" };
  const { calls, docker } = fakeDocker([overlap, overlap]);
  let i = 0;
  const r = await createLabNetwork("touchstone-unit-c", ["--internal"], { docker, pick: () => i++ });
  assert.equal(r.code, 0);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c[4]), ["10.208.0.0/28", "10.208.0.16/28", "10.208.0.32/28"]);
  assert.equal(r.subnet, "10.208.0.32/28");
  await removeLabNetwork("touchstone-unit-c", { docker });
});

test("fails closed after a bounded number of overlaps", async () => {
  const overlap = { code: 1, stdout: "", stderr: "Pool overlaps with other one on this address space" };
  const { calls, docker } = fakeDocker(Array.from({ length: 50 }, () => ({ ...overlap })));
  const r = await createLabNetwork("touchstone-unit-d", ["--internal"], { docker });
  assert.notEqual(r.code, 0);
  assert.equal(calls.length, MAX_ATTEMPTS);
  assert.match(r.stderr, /createLabNetwork: no free \/28 in 10\.208\.0\.0\/12 for touchstone-unit-d/);
  assert.equal(r.subnet, undefined);
  assert.deepEqual(trackedLabNetworks(), []);
});

test("fails closed at once on a non-overlap error", async () => {
  const { calls, docker } = fakeDocker([{ code: 1, stdout: "", stderr: "Error response from daemon: network with name x already exists" }]);
  const r = await createLabNetwork("touchstone-unit-e", ["--internal"], { docker });
  assert.notEqual(r.code, 0);
  assert.equal(calls.length, 1);
  assert.match(r.stderr, /createLabNetwork: docker network create touchstone-unit-e failed: .*already exists/);
});

const dockerUp = (() => { try { execFileSync("docker", ["info"], { stdio: "ignore", timeout: 8000 }); return true; } catch { return false; } })();

test("real Docker: 40 lab networks at once, then removed", { skip: !dockerUp && "docker is not available", timeout: 180_000 }, async () => {
  const tag = randomBytes(4).toString("hex");
  const names = Array.from({ length: 40 }, (_, i) => `touchstone-labnet-test-${tag}-${i}`);
  try {
    const made = await Promise.all(names.map((n, i) => createLabNetwork(n, i % 2 ? ["--internal"] : ["--opt", "com.docker.network.bridge.enable_icc=false"])));
    for (const [i, r] of made.entries()) assert.equal(r.code, 0, `${names[i]}: ${r.stderr}`);
    const subnets = made.map((r) => r.subnet);
    assert.equal(new Set(subnets).size, 40);
    // Docker really used our subnet and kept the isolation flag.
    const out = execFileSync("docker", ["network", "inspect", "-f", "{{.Name}} {{.Internal}} {{range .IPAM.Config}}{{.Subnet}}{{end}}", ...names], { encoding: "utf8" });
    const rows = new Map(out.trim().split("\n").map((l) => { const [n, internal, s] = l.split(" "); return [n, { internal, s }]; }));
    names.forEach((n, i) => {
      assert.equal(rows.get(n).s, subnets[i]);
      inRange(rows.get(n).s);
      assert.equal(rows.get(n).internal, i % 2 ? "true" : "false");
    });
  } finally {
    const rm = await Promise.all(names.map((n) => removeLabNetwork(n)));
    rm.forEach((r, i) => assert.ok(r.code === 0 || /not found/i.test(r.stderr), `${names[i]}: ${r.stderr}`));
  }
  assert.deepEqual(trackedLabNetworks(), []);
});

test("real Docker: SIGTERM removes the networks this process created, and the process still dies", { skip: !dockerUp && "docker is not available", timeout: 60_000 }, async () => {
  const { spawn } = await import("node:child_process");
  const name = `touchstone-labnet-sig-${randomBytes(4).toString("hex")}`;
  const lib = new URL("../lib/lab-net.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    `const { createLabNetwork } = await import(${JSON.stringify(lib)});
     const r = await createLabNetwork(${JSON.stringify(name)}, ["--internal"]);
     console.log(r.code === 0 ? "READY" : "FAIL " + r.stderr);
     setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const first = await new Promise((resolve) => child.stdout.once("data", (d) => resolve(String(d).trim())));
    assert.equal(first, "READY");
    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    child.kill("SIGTERM");
    assert.deepEqual(await exited, { code: null, signal: "SIGTERM" });
    assert.throws(() => execFileSync("docker", ["network", "inspect", name], { stdio: "ignore" }));
  } finally {
    child.kill("SIGKILL");
    try { execFileSync("docker", ["network", "rm", name], { stdio: "ignore" }); } catch {}
  }
});
