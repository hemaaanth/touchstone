import { Wallet, getAddress } from "ethers";
import { createHash } from "node:crypto";
import { currentAgent } from "./event.mjs";
import { openWalletMachine } from "./roam-wallet-machine.mjs";

export const LOCAL_WALLET_CHAIN = 31337;
const failure = () => new Error("Managed offline wallet unavailable. No live chain, public testnet, fallback or replacement is permitted.");
const quantity = (v) => typeof v === "string" && /^0x(?:0|[1-9a-fA-F][a-fA-F0-9]{0,63})$/.test(v);

// open/makeSigner are host-only seams. Neither is model input. A dedicated
// offline IPC transport, not a chain ID or an RPC URL, is the signing boundary.
export function createLocalWallet(ws, { open = openWalletMachine, makeSigner = () => Wallet.createRandom() } = {}) {
  const agents = new Map();
  const consumed = new WeakSet();
  let disposed = false;

  function state(agent, signal) {
    signal?.throwIfAborted();
    if (disposed || typeof agent !== "string" || !agent || agent === "coordinator" || currentAgent() !== agent) throw failure();
    if (!agents.has(agent)) {
      let signer;
      try { signer = makeSigner(); getAddress(signer.address); }
      catch { throw failure(); }
      agents.set(agent, { signer, machine: null, starting: null, failed: false, pending: false });
    }
    const value = agents.get(agent);
    if (value.failed) throw failure();
    return value;
  }

  async function ready(agent, { signal } = {}) {
    const value = state(agent, signal);
    if (!value.starting) value.starting = (async () => {
      try {
        const machine = await open(ws, agent, { signal });
        value.machine = machine;
        if (disposed || value.failed) throw failure();
        const started = await machine.request({ op: "start" }, { signal });
        if (started?.chain_id !== LOCAL_WALLET_CHAIN) throw failure();
        return machine;
      } catch {
        value.failed = true;
        await value.machine?.close().catch(() => {});
        throw failure();
      }
    })();
    await value.starting;
    state(agent, signal);
    return { address: value.signer.address, chain_id: LOCAL_WALLET_CHAIN };
  }

  async function send(agent, input, { ask, signal, check = async () => {} } = {}) {
    const value = state(agent, signal);
    let to;
    try { to = typeof input?.to === "string" && /^0x[0-9a-fA-F]{40}$/.test(input.to) && getAddress(input.to); } catch { /* no name resolution */ }
    if (!to || to === "0x0000000000000000000000000000000000000000" || input.chain_id !== LOCAL_WALLET_CHAIN || typeof input.value_wei !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(input.value_wei) || BigInt(input.value_wei) >= 2n ** 256n || (input.data !== undefined && (typeof input.data !== "string" || !/^0x(?:[a-fA-F0-9]{2})*$/.test(input.data) || input.data.length > 131074)) || Object.keys(input).some((k) => !["to", "value_wei", "chain_id", "data"].includes(k))) throw failure();
    if (typeof ask !== "function" || value.pending) throw failure();
    const captured = Object.freeze({ to, value_wei: input.value_wei, data: input.data ?? "0x" });
    value.pending = true;
    try {
      await check();
      await ready(agent, { signal });
      await check();
      const machine = value.machine;
      const prepared = await machine.request({ op: "prepare", from: value.signer.address, ...captured }, { signal });
      if (prepared?.chain_id !== LOCAL_WALLET_CHAIN || !quantity(prepared.nonce) || !quantity(prepared.gas_price) || !quantity(prepared.gas_limit) || BigInt(prepared.gas_limit) === 0n || BigInt(prepared.nonce) > BigInt(Number.MAX_SAFE_INTEGER)) throw failure();
      const transaction = Object.freeze({ type: 0, chainId: LOCAL_WALLET_CHAIN, to: captured.to, value: BigInt(captured.value_wei), data: captured.data, nonce: Number(BigInt(prepared.nonce)), gasPrice: BigInt(prepared.gas_price), gasLimit: BigInt(prepared.gas_limit) });
      const detail = Object.freeze({ from: value.signer.address, to: captured.to, value_wei: captured.value_wei, chain_id: LOCAL_WALLET_CHAIN, data_sha256: createHash("sha256").update(captured.data).digest("hex"), gas_limit: transaction.gasLimit.toString(), gas_price_wei: transaction.gasPrice.toString(), max_fee_wei: (transaction.gasLimit * transaction.gasPrice).toString() });
      signal?.throwIfAborted();
      const answer = await ask(Object.freeze({ kind: "wallet-spend", question: "Send this exact transaction on the managed offline local chain only? The maximum gas fee is shown separately from the value.", detail }), { signal });
      await check();
      state(agent, signal);
      if (!answer || typeof answer !== "object" || Array.isArray(answer) || answer.done !== true || Object.keys(answer).length !== 1 || consumed.has(answer)) return { cancelled: true };
      consumed.add(answer);
      const status = await machine.request({ op: "status" }, { signal });
      if (status?.chain_id !== LOCAL_WALLET_CHAIN || machine !== value.machine) throw failure();
      await check();
      state(agent, signal);
      // The signer and signed bytes stay private. Only the trusted offline
      // transport receives raw bytes; no raw transaction is a tool result.
      const raw = await value.signer.signTransaction(transaction);
      state(agent, signal);
      const result = await machine.request({ op: "submit", raw }, { signal });
      if (typeof result?.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(result.hash)) throw failure();
      return { hash: result.hash };
    } catch {
      value.failed = true;
      await value.machine?.close().catch(() => {});
      throw failure();
    } finally { value.pending = false; }
  }

  return Object.freeze({
    address(agent, { signal } = {}) {
      const value = state(agent, signal);
      return { address: value.signer.address, chain_id: LOCAL_WALLET_CHAIN };
    },
    ready,
    send,
    async dispose() {
      disposed = true;
      const results = await Promise.allSettled([...agents.values()].map(async (value) => {
        value.failed = true;
        await value.starting?.catch(() => {});
        await value.machine?.close();
      }));
      agents.clear();
      if (results.some((r) => r.status === "rejected")) throw failure();
    },
  });
}
