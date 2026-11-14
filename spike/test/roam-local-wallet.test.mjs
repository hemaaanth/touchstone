import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { createLocalWallet, LOCAL_WALLET_CHAIN } from "../lib/roam-local-wallet.mjs";
import { withAgent } from "../lib/event.mjs";

const input = () => ({ to: "0x1234567890123456789012345678901234567890", value_wei: "7", data: "0x1234", chain_id: LOCAL_WALLET_CHAIN });
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function fake({ failOp, wrongChain, openFailure } = {}) {
  const calls = { opens: [], requests: [], signatures: [], closes: [], asks: [] };
  const keys = [];
  const manager = createLocalWallet("/fake/run", {
    makeSigner() {
      const wallet = Wallet.createRandom();
      keys.push(wallet.privateKey);
      return { address: wallet.address, async signTransaction(tx) { calls.signatures.push(tx); return "0x" + "a1".repeat(90); } };
    },
    async open(ws, agent) {
      calls.opens.push({ ws, agent });
      if (openFailure) throw new Error("fake secret transport detail");
      return Object.freeze({ id: `private-${agent}`, async request(request, config) {
        calls.requests.push({ request, config });
        if (request.op === failOp) throw new Error("fake secret RPC detail");
        const chain_id = wrongChain ?? LOCAL_WALLET_CHAIN;
        if (request.op === "prepare") return { chain_id, nonce: "0x1", gas_price: "0x2", gas_limit: "0x5208" };
        if (request.op === "submit") return { hash: "0x" + "b2".repeat(32) };
        return { chain_id };
      }, async close() { calls.closes.push(agent); } });
    },
  });
  const ask = async (request, config) => { calls.asks.push({ request, config }); return { done: true }; };
  const run = (fn, agent = "a-1") => withAgent(agent, fn);
  return { manager, calls, keys, ask, run };
}

test("constructing the capability does not create a wallet or provision a machine", async () => {
  const f = fake();
  assert.deepEqual(f.keys, []);
  assert.deepEqual(f.calls.opens, []);
  await f.manager.dispose();
});

test("address identity is trusted, per-agent and host-only", async () => {
  const f = fake();
  assert.throws(() => f.manager.address("a-1"), /unavailable/);
  assert.throws(() => f.run(() => f.manager.address("a-2")), /unavailable/);
  const first = f.run(() => f.manager.address("a-1"));
  assert.deepEqual(f.run(() => f.manager.address("a-1")), first);
  assert.notEqual(f.run(() => f.manager.address("a-2"), "a-2").address, first.address);
  assert.deepEqual(f.calls.opens, []);
  for (const key of f.keys) assert.ok(!JSON.stringify(first).includes(key));
  await f.manager.dispose();
});

for (const answer of [undefined, {}, { done: false }, { reply: "go" }, { done: "true" }, { done: true, stale: true }]) {
  test(`local signing refuses non-current done shape ${JSON.stringify(answer)}`, async () => {
    const f = fake();
    const result = await f.run(() => f.manager.send("a-1", input(), { ask: async () => answer }));
    assert.deepEqual(result, { cancelled: true });
    assert.deepEqual(f.calls.signatures, []);
    assert.ok(!f.calls.requests.some(({ request }) => request.op === "submit"));
    await f.manager.dispose();
  });
}

test("current done binds exact transaction and fees, then rechecks lifecycle before signing", async () => {
  const f = fake();
  const args = input();
  const ac = new AbortController();
  const result = await f.run(() => f.manager.send("a-1", args, { signal: ac.signal, ask: async (request, config) => {
    assert.equal(request.kind, "wallet-spend");
    assert.equal(request.detail.to, args.to);
    assert.equal(request.detail.value_wei, "7");
    assert.equal(request.detail.max_fee_wei, "42000");
    assert.equal(config.signal, ac.signal);
    args.to = "0x9999999999999999999999999999999999999999";
    args.value_wei = "900";
    return { done: true };
  } }));
  assert.deepEqual(result, { hash: "0x" + "b2".repeat(32) });
  assert.deepEqual(f.calls.requests.map(({ request }) => request.op), ["start", "prepare", "status", "submit"]);
  assert.equal(f.calls.signatures.length, 1);
  assert.equal(f.calls.signatures[0].to, input().to);
  assert.equal(f.calls.signatures[0].value, 7n);
  assert.equal(f.calls.signatures[0].chainId, LOCAL_WALLET_CHAIN);
  for (const { config } of f.calls.requests) assert.equal(config.signal, ac.signal);
  for (const key of f.keys) assert.ok(!JSON.stringify([result, f.calls.asks, f.calls.opens]).includes(key));
  assert.ok(!JSON.stringify(result).includes("a1".repeat(90)));
  await f.manager.dispose();
});

test("live chain IDs, RPC fields and malformed targets are refused without any machine or ask", async () => {
  const f = fake();
  for (const change of [{ chain_id: 1 }, { chain_id: 11155111 }, { to: "someone.eth" }, { rpc_url: "http://127.0.0.1:8545" }, { rpc_url: "https://live.example.invalid" }, { data: "0x0" }, { value_wei: "-1" }]) {
    await assert.rejects(() => f.run(() => f.manager.send("a-1", { ...input(), ...change }, { ask: f.ask })), /unavailable/);
  }
  assert.deepEqual(f.calls.opens, []);
  assert.deepEqual(f.calls.asks, []);
  assert.deepEqual(f.calls.signatures, []);
  await f.manager.dispose();
});

test("failed capability is terminal and is never replaced, including a missing image or provider", async () => {
  for (const config of [{ openFailure: true }, { failOp: "start" }, { failOp: "prepare" }, { wrongChain: 1 }, { failOp: "status" }]) {
    const f = fake(config);
    await assert.rejects(() => f.run(() => f.manager.send("a-1", input(), { ask: f.ask })), /unavailable/);
    await assert.rejects(() => f.run(() => f.manager.send("a-1", input(), { ask: f.ask })), /unavailable/);
    assert.equal(f.calls.opens.length, 1);
    assert.deepEqual(f.calls.signatures, []);
    if (config.failOp !== "status") assert.deepEqual(f.calls.asks, []);
    await f.manager.dispose();
  }
});

test("a failed submission never retries or exposes signed bytes", async () => {
  const f = fake({ failOp: "submit" });
  await assert.rejects(() => f.run(() => f.manager.send("a-1", input(), { ask: f.ask })), { message: "Managed offline wallet unavailable. No live chain, public testnet, fallback or replacement is permitted." });
  assert.equal(f.calls.signatures.length, 1);
  assert.equal(f.calls.requests.filter(({ request }) => request.op === "submit").length, 1);
  await assert.rejects(() => f.run(() => f.manager.send("a-1", input(), { ask: f.ask })), /unavailable/);
  assert.equal(f.calls.signatures.length, 1);
  await f.manager.dispose();
});

test("reused approvals, cancellation, revoked selection and disposal never sign", async () => {
  const f = fake();
  const answer = { done: true };
  await f.run(() => f.manager.send("a-1", input(), { ask: async () => answer }));
  const before = f.calls.signatures.length;
  assert.deepEqual(await f.run(() => f.manager.send("a-1", input(), { ask: async () => answer })), { cancelled: true });
  assert.equal(f.calls.signatures.length, before);
  await f.manager.dispose();
  for (const mode of ["abort", "dispose", "revoke"]) {
    const g = fake();
    const ac = new AbortController();
    let selected = true;
    await assert.rejects(() => g.run(() => g.manager.send("a-1", input(), {
      signal: ac.signal,
      check: async () => { if (!selected) throw new Error("not selected"); },
      ask: async () => {
        if (mode === "abort") ac.abort();
        if (mode === "dispose") await g.manager.dispose();
        if (mode === "revoke") selected = false;
        return { done: true };
      },
    })), /unavailable/);
    assert.deepEqual(g.calls.signatures, []);
    await g.manager.dispose();
  }
});

test("pending approval prevents overlap and late disposal prevents a stale approval", async () => {
  const f = fake();
  const waiting = defer(); const entered = defer();
  const first = f.run(() => f.manager.send("a-1", input(), { ask: async () => { entered.resolve(); return waiting.promise; } }));
  await entered.promise;
  await assert.rejects(() => f.run(() => f.manager.send("a-1", input(), { ask: f.ask })), /unavailable/);
  await f.manager.dispose();
  waiting.resolve({ done: true });
  await assert.rejects(() => first, /unavailable/);
  assert.deepEqual(f.calls.signatures, []);
});
