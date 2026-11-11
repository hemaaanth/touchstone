// Tests for the out-of-process attacker sandbox (F1 R1). The boundary itself needs
// unprivileged user+net+mount namespaces; the full proof additionally needs the Anvil lab
// image. Each test skips HONESTLY when its prerequisite is absent rather than passing vacuously.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { sandboxCapabilities, enter } from "../lib/sandbox/netns.mjs";
import { startBroker } from "../lib/sandbox/broker.mjs";
import { rpc, labImagePresent } from "../lib/sandbox/lab.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const caps = await sandboxCapabilities();
const skipCaps = caps.ok ? false : `namespaces unavailable: ${caps.reason}`;

// A fake JSON-RPC upstream standing in for the lab, so the boundary tests need no docker.
function fakeLab() {
  const server = createServer((req, res) => {
    let b = ""; req.on("data", (c) => b += c);
    req.on("end", () => {
      const { id, method } = JSON.parse(b);
      res.writeHead(200, { "content-type": "application/json" });
      // Honor only chainId; anything reaching here would be a forwarded call.
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: method === "eth_chainId" ? "0x7a69" : "0xdead" }));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((x) => server.close(x)) })));
}

test("broker forwards read methods and rejects writes (read-only policy)", async () => {
  const lab = await fakeLab();
  const dir = mkdtempSync(join(tmpdir(), "brk-"));
  const broker = await startBroker({ upstreamUrl: lab.url, socketPath: join(dir, "lab.sock") });
  try {
    const ok = await rpc({ socketPath: broker.socketPath }, "eth_chainId");
    assert.equal(ok.result, "0x7a69", "read forwarded");
    const bad = await rpc({ socketPath: broker.socketPath }, "anvil_setBalance", ["0x0", "0x0"]);
    assert.ok(bad.error, "write rejected");
    assert.match(bad.error.message, /not allowed/);
  } finally {
    await broker.close(); await lab.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("sandbox blocks host loopback but reaches the brokered unix socket", { skip: skipCaps }, async () => {
  const lab = await fakeLab();
  const dir = mkdtempSync(join(tmpdir(), "brk-"));
  const broker = await startBroker({ upstreamUrl: lab.url, socketPath: join(dir, "lab.sock") });
  // A one-liner worker run INSIDE the sandbox: try the lab's loopback URL, then the broker.
  const worker = `
    import { rpc } from ${JSON.stringify(join(HERE, "../lib/sandbox/lab.mjs"))};
    const out = {};
    try { await rpc({ url: process.env.LOOP }, "eth_chainId"); out.loop = "REACHED"; }
    catch (e) { out.loop = e.code || String(e.message); }
    try { const r = await rpc({ socketPath: process.env.SOCK }, "eth_chainId"); out.broker = r.result; }
    catch (e) { out.broker = "ERR:" + (e.message || e); }
    process.stdout.write(JSON.stringify(out));`;
  try {
    const run = await enter(["node", "--input-type=module", "-e", worker], {
      env: { ...process.env, LOOP: lab.url, SOCK: broker.socketPath }, timeoutMs: 20_000,
    });
    const out = JSON.parse(run.stdout.trim());
    assert.equal(out.loop, "ENETUNREACH", "host loopback must be unreachable from the sandbox");
    assert.equal(out.broker, "0x7a69", "the brokered unix socket must still reach the lab");
  } finally {
    await broker.close(); await lab.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("the sandbox has no docker socket", { skip: skipCaps }, async () => {
  const run = await enter(["sh", "-c", '[ -e /run/docker.sock ] || [ -e /var/run/docker.sock ] && echo PRESENT || echo ABSENT'], { timeoutMs: 10_000 });
  assert.equal(run.stdout.trim(), "ABSENT");
});

const hasImage = await labImagePresent().catch(() => false);
test("full isolation proof passes against real Anvil (R1 closed)", { skip: skipCaps || (!hasImage && "lab image not present") }, async () => {
  const proof = join(HERE, "../lib/sandbox/proof.mjs");
  const { code, out } = await new Promise((resolve) => {
    execFile("node", [proof], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout) }));
  });
  assert.match(out, /ALL PASS — R1 CLOSED/);
  assert.equal(code, 0);
});
