// The lab for the isolation proof: a REAL Anvil (foundry 1.9.0, baked into
// touchstone-chain-tools:wave1 — the same image the F1 keys lab uses), deliberately run in
// the R1-VULNERABLE posture so the proof shows the sandbox closes R1 even then: Anvil is
// PUBLISHED on host loopback (docker -p 127.0.0.1:PORT:8545), an un-authed cheat RPC. Any
// process on host loopback can call anvil_setBalance and forge a credited drain — that is
// R1. (In production the broker's upstream is instead `anvil --ipc` with no loopback publish
// at all; the broker code is upstream-agnostic, so only this file changes.)
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { request } from "node:http";

export const LAB_IMAGE = "touchstone-chain-tools:wave1";
const DEV_ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // Anvil account[0], prefunded.

function docker(args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    execFile("docker", args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A tiny JSON-RPC caller over node's http module, which supports BOTH a TCP endpoint
// (target.url = http://127.0.0.1:PORT) and an AF_UNIX pathname socket (target.socketPath =
// the broker). This is the exact surface an attacker uses, so the proof drives the real thing.
export function rpc(target, method, params = [], { timeoutMs = 8000 } = {}) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const opts = { method: "POST", path: "/", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: timeoutMs };
  if (target.socketPath) { opts.socketPath = target.socketPath; }
  else { const u = new URL(target.url); opts.host = u.hostname; opts.port = u.port; }
  return new Promise((resolve, reject) => {
    const req = request(opts, (res) => {
      let data = ""; res.on("data", (c) => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`bad rpc response: ${data.slice(0, 120)}`)); } });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("rpc timeout")));
    req.end(body);
  });
}

export async function labImagePresent() {
  const r = await docker(["image", "inspect", LAB_IMAGE], { timeoutMs: 10_000 });
  return r.code === 0;
}

// Start Anvil, published on an ephemeral host-loopback port. Returns a handle with the
// host-only `rpcUrl` (NEVER handed to the sandboxed worker), the labelled container name,
// a prefunded `victim` address, and stop().
export async function startAnvilLab({ image = LAB_IMAGE, readyTimeoutMs = 60_000 } = {}) {
  const tag = randomBytes(4).toString("hex");
  const name = `touchstone-r1lab-${tag}`;
  // -p 127.0.0.1:0:8545 asks docker for a random free HOST loopback port -> the R1 publish.
  const run = await docker(["run", "-d", "--rm", "--pull=never", "--name", name, "-p", "127.0.0.1:0:8545",
    "--entrypoint", "anvil", image, "--host", "0.0.0.0", "--accounts", "3", "--block-time", "100"]);
  if (run.code !== 0) throw new Error(`anvil start failed: ${run.stderr.trim()}`);
  const handle = { name, image, rpcUrl: null, victim: DEV_ACCOUNT, stop: async () => { await docker(["rm", "-f", name], { timeoutMs: 15_000 }); } };
  try {
    const portOut = await docker(["port", name, "8545/tcp"], { timeoutMs: 10_000 });
    const m = portOut.stdout.match(/127\.0\.0\.1:(\d+)/);
    if (!m) throw new Error(`could not read published port: ${portOut.stdout || portOut.stderr}`);
    handle.rpcUrl = `http://127.0.0.1:${m[1]}`;
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      try {
        const r = await rpc({ url: handle.rpcUrl }, "eth_chainId");
        if (r?.result) break;
      } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error("anvil did not become ready");
      await sleep(400);
    }
    return handle;
  } catch (e) {
    await handle.stop();
    throw e;
  }
}
