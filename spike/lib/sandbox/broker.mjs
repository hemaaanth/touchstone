// The brokered lab socket — the ONE channel from the sandbox to the lab. It is an HTTP
// JSON-RPC server bound to an AF_UNIX pathname socket in a 0700 directory, NOT a TCP port.
// The sandbox (its own empty netns) can reach this pathname socket but cannot reach the
// lab's real endpoint on host loopback. The broker runs on the HOST side of the boundary,
// so it (and only it) forwards to the lab's Anvil.
//
// It also enforces the signed-tx-only / read-only policy at the boundary, so even the one
// permitted channel cannot be used to forge a drain: a read allowlist is forwarded; anvil_*,
// evm_*, eth_sendTransaction and friends are rejected with a JSON-RPC error. The allowlist
// is adapted from this repo's F1 txreplay-proof read-only HTTP proxy (spike/lib/
// txreplay-proof.mjs, startReadOnlyProxy) — same project, moved from a TCP proxy to a unix
// socket so the policy and the namespace boundary are one object, not two.
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

// Read-only JSON-RPC methods the broker forwards. Anything else — anvil_setBalance and the
// rest of anvil_*/evm_*/hardhat_*, eth_sendTransaction, eth_sendRawTransaction, personal_*,
// debug_*, txpool_* — is rejected, so a worker that reaches the lab through the broker can
// observe and sign but can NEVER mutate it. (A signed raw tx, the sound F1 model, is
// submitted by the HARNESS after measuring the baseline, never through this socket.)
export const READ_METHODS = new Set([
  "eth_chainId", "eth_blockNumber", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory",
  "eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_getTransactionCount",
  "eth_call", "eth_estimateGas", "eth_createAccessList",
  "eth_getBlockByNumber", "eth_getBlockByHash",
  "eth_getBlockTransactionCountByNumber", "eth_getBlockTransactionCountByHash",
  "eth_getTransactionByHash", "eth_getTransactionReceipt",
  "eth_getTransactionByBlockNumberAndIndex", "eth_getTransactionByBlockHashAndIndex",
  "eth_getLogs", "eth_getProof", "net_version", "net_listening", "web3_clientVersion",
]);

// Start the broker on `socketPath`, forwarding allowed calls to `upstreamUrl` (the lab's
// Anvil HTTP endpoint on the host side). The parent directory is created 0700 and the
// socket removed first if stale. Returns { socketPath, close }.
export function startBroker({ upstreamUrl, socketPath, allow = READ_METHODS }) {
  const dir = dirname(socketPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  if (existsSync(socketPath)) rmSync(socketPath);

  const rpcError = (reqId, method) => ({
    jsonrpc: "2.0", id: reqId ?? null,
    error: { code: -32601, message: `lab broker: method not allowed: ${method ?? "(none)"}` },
  });

  const server = createServer((req, res) => {
    if (req.method !== "POST") { res.writeHead(405); return res.end(); }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 4_000_000) req.destroy(); });
    req.on("end", async () => {
      let payload;
      try { payload = JSON.parse(body); } catch {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
      }
      const items = Array.isArray(payload) ? payload : [payload];
      const bad = items.some((it) => !it || typeof it.method !== "string" || !allow.has(it.method));
      if (bad) {
        const rejection = Array.isArray(payload)
          ? items.map((it) => rpcError(it?.id, it?.method))
          : rpcError(payload?.id, payload?.method);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(rejection));
      }
      try {
        const up = await fetch(upstreamUrl, {
          method: "POST", headers: { "content-type": "application/json" }, body,
        });
        const text = await up.text();
        res.writeHead(up.status, { "content-type": "application/json" });
        res.end(text);
      } catch (e) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: `broker upstream error: ${String(e).slice(0, 120)}` } }));
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      chmodSync(socketPath, 0o600);
      resolve({
        socketPath,
        close: () => new Promise((r) => server.close(() => { try { rmSync(socketPath); } catch {} r(); })),
      });
    });
  });
}
