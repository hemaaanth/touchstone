import "./helpers/isolated-env.mjs";
import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Wallet as RealWallet, getAddress } from "ethers";
import { withAgent } from "../lib/event.mjs";

// Only this isolated fake creates test keys. Never connects to a provider or
// signs anything. Production must keep the real ethers Wallet on the host.
const generated = [];
let failWallet = false;
const signed = [];
const remote = [];
const ethersMock = mock.module("ethers", { namedExports: {
  getAddress,
  Wallet: { createRandom() {
    if (failWallet) throw new Error("fake private key must not be echoed");
    const real = RealWallet.createRandom();
    const wallet = { address: real.address, privateKey: real.privateKey, async signTransaction(transaction) { signed.push(transaction); return "0x" + "ab".repeat(100); } };
    generated.push(wallet);
    return wallet;
  } },
} });
after(() => ethersMock.restore());
const machineMock = mock.module("../lib/roam-wallet-machine.mjs", { namedExports: {
  async openWalletMachine(ws, agent) {
    const calls = [];
    remote.push({ ws, agent, calls });
    return Object.freeze({ id: `private-${agent}`, async request(input) {
      calls.push(input);
      if (input.op === "prepare") return { chain_id: 31337, nonce: "0x0", gas_price: "0x1", gas_limit: "0x5208" };
      if (input.op === "submit") return { hash: "0x" + "cd".repeat(32) };
      return { chain_id: 31337 };
    }, async close() {} });
  },
} });
after(() => machineMock.restore());
const { roamLoadoutTools } = await import("../lib/roam-loadout.mjs");

const mail = () => ({ to: "recipient@example.invalid", subject: "Test subject", body: "Private test message: alpha beta." });
const tx = () => ({ to: "0x1234567890123456789012345678901234567890", value_wei: "1", chain_id: 31337 });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function fixture(overrides = {}, ws = {}) {
  const calls = { asks: [], records: [], address: [], read: [], sent: [], machine: [] };
  const mailbox = {
    async address(input) { calls.address.push(input); return { address: `${input.agent}@mailbox.invalid`, token: "fake-provider-token" }; },
    async read(input) { calls.read.push(input); return [{ from: "sender@example.invalid", subject: "Inbox test", text: "Untrusted inbox text", credentials: "fake-provider-token" }]; },
    async send(input) { calls.sent.push(input); return { id: "mail-123", token: "fake-provider-token" }; },
  };
  const tools = roamLoadoutTools(ws, {
    options: async () => ["wallet", "email"],
    ask: async (input, config) => { calls.asks.push({ input, config }); return { done: true }; },
    record: async (input) => { calls.records.push(input); },
    machine: async (...input) => { calls.machine.push(input); throw new Error("No machine call is allowed."); },
    mailbox,
    ...overrides,
  });
  const invoke = (name, args = {}, agent = "a-1", ctx = {}, api = {}) => withAgent(agent, async () => {
    const result = await tools.find((t) => t.name === name).execute(args, api, ctx);
    return JSON.parse(result.output[0].text);
  });
  return { calls, tools, invoke, mailbox };
}

function noSecrets(value) {
  const serialized = JSON.stringify(value);
  for (const wallet of generated) assert.ok(!serialized.includes(wallet.privateKey), "private key escaped the host fake");
  assert.ok(!serialized.includes("fake-provider-token"));
}

test("construction is side-effect-free, including with no integrations", () => {
  const count = generated.length;
  const f = fixture();
  assert.equal(generated.length, count);
  assert.deepEqual(f.calls, { asks: [], records: [], address: [], read: [], sent: [], machine: [] });
  assert.equal(roamLoadoutTools({}).length, 7);
});

test("every tool rejects coordinator, absent selections and disabled agents before side effects", async () => {
  const count = generated.length;
  for (const overrides of [{ options: undefined }, { options: async () => [] }, { options: async () => ["unknown"] }, { options: async () => { throw new Error("private roster content"); } }]) {
    const f = fixture(overrides);
    for (const t of f.tools) await assert.rejects(() => f.invoke(t.name, {}), /selected|selection/);
    assert.deepEqual(f.calls, { asks: [], records: [], address: [], read: [], sent: [], machine: [] });
  }
  const f = fixture();
  for (const agent of [undefined, "", "coordinator", 1]) {
    for (const t of f.tools) await assert.rejects(() => withAgent(agent, () => t.execute({}, {}, {})), /agent/);
  }
  assert.equal(generated.length, count);
});

test("trusted options callback gets currentAgent, api and exact ctx; model identity is ignored", async () => {
  const api = { conversationId: "1" };
  const ctx = { abortSignal: new AbortController().signal };
  let seen;
  const f = fixture({ options: async (...args) => { seen = args; return args[0] === `a-${args[1].conversationId}` ? ["email"] : []; } });
  assert.deepEqual(await f.invoke("email_address", { agent: "a-2", options: ["wallet"] }, "a-1", ctx, api), { address: "a-1@mailbox.invalid" });
  assert.deepEqual(seen, ["a-1", api, ctx]);
  await assert.rejects(() => f.invoke("email_address", {}, "a-2", ctx, api), /not selected/);
  await assert.rejects(() => f.invoke("wallet_address", {}, "a-1", ctx, api), /not selected/);
  assert.deepEqual(f.calls.address, [{ agent: "a-1", signal: ctx.abortSignal }]);
});

test("wallet address is stable per agent and isolated across agents and factory instances", async () => {
  const f = fixture();
  const a = await f.invoke("wallet_address");
  assert.deepEqual(await f.invoke("wallet_address"), a);
  assert.notEqual((await f.invoke("wallet_address", {}, "a-2")).address, a.address);
  assert.notEqual((await fixture().invoke("wallet_address")).address, a.address);
  assert.equal(a.chain_id, 31337);
  assert.deepEqual(f.calls.machine, []);
  noSecrets([a, f.calls]);
});

test("wallet creation errors never echo key details", async () => {
  failWallet = true;
  try { await assert.rejects(() => fixture().invoke("wallet_address"), /Managed offline wallet unavailable/); }
  finally { failWallet = false; }
});

test("wallet signing refuses live chains and arbitrary local/nonlocal RPC before ask or wallet creation", async () => {
  const count = generated.length;
  for (const rpcUrl of ["http://127.0.0.1:8545", "http://localhost:8545", "http://[::1]:8545", "https://mainnet.example.invalid", "https://sepolia.example.invalid"]) {
    const f = fixture({}, { rpcUrl, chain_id: 31337, localFork: true });
    for (const chain_id of [1, 11155111, 1337]) {
      const result = await f.invoke("wallet_send", { ...tx(), chain_id });
      assert.equal(result.unavailable, true);
      assert.match(result.reason, /public testnets.*forbidden/);
    }
    await assert.rejects(() => f.invoke("wallet_send", { ...tx(), rpc_url: rpcUrl }), /Invalid wallet/);
    assert.deepEqual(f.calls, { asks: [], records: [], address: [], read: [], sent: [], machine: [] });
  }
  assert.equal(generated.length, count);
});

test("malformed wallet targets, values, data and chain IDs fail before any ask", async () => {
  const f = fixture();
  for (const change of [
    { to: "alice.eth" }, { to: "0x0000000000000000000000000000000000000000" }, { to: "https://rpc.example.invalid" },
    { to: "0x123" }, { value_wei: "-1" }, { value_wei: "1e18" }, { value_wei: 1 }, { value_wei: (2n ** 256n).toString() },
    { data: "0x0" }, { data: "hello" }, { data: "0x" + "00".repeat(65537) }, { chain_id: 0 }, { chain_id: "31337" }, { chain_id: 1.5 }, { chain_id: Number.MAX_SAFE_INTEGER + 1 },
  ]) await assert.rejects(() => f.invoke("wallet_send", { ...tx(), ...change }), /Invalid wallet/);
  assert.equal(f.calls.asks.length, 0);
});

for (const answer of [undefined, {}, { done: false }, { reply: "yes" }, { done: "true" }, { done: 1 }, { done: true, reply: "changed recipient" }, { done: true, stale: true }]) {
  test(`gated actions never approve ${JSON.stringify(answer)}`, async () => {
    const f = fixture({ ask: async () => answer });
    assert.deepEqual(await f.invoke("email_send", mail()), { cancelled: true });
    assert.deepEqual(await f.invoke("wallet_fund"), { cancelled: true });
    const count = signed.length;
    assert.deepEqual(await f.invoke("wallet_send", tx()), { cancelled: true });
    assert.equal(signed.length, count);
    assert.deepEqual(await f.invoke("test_account", { service: "service.example.invalid" }), { cancelled: true });
    assert.deepEqual(f.calls.sent, []);
    assert.ok(!f.calls.records.some((r) => ["sent", "human-reported"].includes(r.status)));
  });
}

test("wallet send uses only private offline transport and exact done; dispose is not a model tool", async () => {
  const f = fixture();
  const before = signed.length;
  const result = await f.invoke("wallet_send", tx());
  assert.deepEqual(result, { hash: "0x" + "cd".repeat(32) });
  assert.equal(signed.length, before + 1);
  assert.equal(f.calls.asks[0].input.kind, "wallet-spend");
  assert.equal(f.calls.asks[0].input.detail.to, tx().to);
  assert.equal(f.calls.asks[0].input.detail.value_wei, "1");
  assert.equal(f.calls.asks[0].input.detail.max_fee_wei, "21000");
  assert.deepEqual(f.calls.machine, []);
  assert.equal(f.tools.some((tool) => tool.name === "dispose"), false);
  noSecrets([result, f.calls]);
  assert.ok(!JSON.stringify([result, f.calls]).includes("0x" + "ab".repeat(100)));
  await f.tools.dispose();
  await assert.rejects(() => f.invoke("wallet_address"), /unavailable/);
});

test("email approval binds exact captured message and cannot be redirected by argument mutation", async () => {
  const args = mail();
  const original = { ...args };
  const ac = new AbortController();
  let request;
  let config;
  const f = fixture({ ask: async (input, options) => {
    request = input; config = options;
    args.to = "other@example.invalid"; args.subject = "Changed"; args.body = "Changed";
    assert.throws(() => { input.detail.to = "other@example.invalid"; }, TypeError);
    return { done: true };
  } });
  const result = await f.invoke("email_send", args, "a-1", { abortSignal: ac.signal }, { signal: AbortSignal.abort() });
  assert.deepEqual(result, { id: "mail-123" });
  assert.deepEqual(f.calls.sent, [{ agent: "a-1", from: "a-1@mailbox.invalid", ...original, signal: ac.signal }]);
  assert.equal(request.kind, "email-send");
  assert.deepEqual(request.detail, { from: "a-1@mailbox.invalid", to: original.to, subject: original.subject, message_sha256: hash({ from: "a-1@mailbox.invalid", ...original }) });
  assert.equal(config.signal, ac.signal);
  assert.ok(!JSON.stringify(request).includes(original.body));
  for (const fact of f.calls.records) assert.deepEqual(Object.keys(fact).sort(), ["action", "agent", "kind", "status", "t"]);
  assert.ok(!JSON.stringify(f.calls.records).includes(original.subject));
  assert.ok(!JSON.stringify(f.calls.records).includes(original.to));
  noSecrets([request, result, f.calls.records]);
});

test("a consumed done answer cannot approve a second or mutated message", async () => {
  const answer = { done: true };
  const f = fixture({ ask: async () => answer });
  assert.deepEqual(await f.invoke("email_send", mail()), { id: "mail-123" });
  assert.deepEqual(await f.invoke("email_send", { ...mail(), body: "A different message" }), { cancelled: true });
  assert.equal(f.calls.sent.length, 1);
});

test("each new message needs its own current ask and fresh done answer", async () => {
  const f = fixture();
  await f.invoke("email_send", mail());
  await f.invoke("email_send", { ...mail(), to: "second@example.invalid", body: "Different body" });
  assert.equal(f.calls.asks.length, 2);
  assert.equal(f.calls.sent.length, 2);
  assert.notEqual(f.calls.asks[0].input.detail.message_sha256, f.calls.asks[1].input.detail.message_sha256);
});

test("only one loadout action waits for an agent; other agents stay isolated", async () => {
  const waiting = deferred();
  const entered = deferred();
  const f = fixture({ ask: async () => { entered.resolve(); return waiting.promise; } });
  const first = f.invoke("email_send", mail());
  await entered.promise;
  await assert.rejects(() => f.invoke("email_send", mail()), /pending loadout/);
  waiting.resolve({ done: false });
  assert.deepEqual(await first, { cancelled: true });
  assert.deepEqual(f.calls.sent, []);
});

test("cancellation at ctx.abortSignal prevents provider access or action after an approval", async () => {
  const ac = new AbortController(); ac.abort();
  const f = fixture();
  await assert.rejects(() => f.invoke("email_send", mail(), "a-1", { abortSignal: ac.signal }), /abort/i);
  assert.deepEqual(f.calls.address, []);
  assert.deepEqual(f.calls.asks, []);
  const afterAsk = new AbortController();
  const g = fixture({ ask: async (_request, { signal }) => { assert.equal(signal, afterAsk.signal); afterAsk.abort(); return { done: true }; } });
  await assert.rejects(() => g.invoke("email_send", mail(), "a-1", { abortSignal: afterAsk.signal }), /abort/i);
  assert.deepEqual(g.calls.sent, []);
});

test("revoking selection during approval or provider lookup prevents a send and another ask", async () => {
  let enabled = true;
  const f = fixture({ options: async () => enabled ? ["email"] : [], ask: async () => { enabled = false; return { done: true }; } });
  await assert.rejects(() => f.invoke("email_send", mail()), /not selected/);
  assert.deepEqual(f.calls.sent, []);
  enabled = true;
  const g = fixture({ options: async () => enabled ? ["email"] : [], mailbox: {
    address: async () => { enabled = false; return { address: "sender@example.invalid" }; },
    send: async () => { assert.fail("send after revoke"); },
  } });
  await assert.rejects(() => g.invoke("email_send", mail()), /not selected/);
  assert.deepEqual(g.calls.asks, []);
});

test("missing mailbox, ask or recorder is explicit and never sends", async () => {
  const f = fixture({ mailbox: undefined });
  for (const [name, args] of [["email_address", {}], ["email_read", {}], ["email_send", mail()]]) {
    const result = await f.invoke(name, args);
    assert.equal(result.unavailable, true);
    assert.match(result.reason, /provider.*host-only credentials/);
  }
  for (const missing of [{ ask: undefined }, { record: undefined }]) {
    const g = fixture(missing);
    assert.equal((await g.invoke("email_send", mail())).unavailable, true);
    assert.deepEqual(g.calls.sent, []);
    assert.deepEqual(g.calls.asks, []);
  }
});

test("mailbox reads use the calling agent, bounded limit and an allowlisted result", async () => {
  const f = fixture();
  const ac = new AbortController();
  const result = await f.invoke("email_read", { limit: 1, agent: "a-9" }, "a-2", { abortSignal: ac.signal });
  assert.deepEqual(f.calls.read, [{ agent: "a-2", limit: 1, signal: ac.signal }]);
  assert.deepEqual(result, { messages: [{ from: "sender@example.invalid", subject: "Inbox test", text: "Untrusted inbox text" }], untrusted: true });
  assert.deepEqual(f.calls.asks, []);
  assert.deepEqual(f.calls.records, []);
  noSecrets(result);
  for (const limit of [0, -1, 51, 1.5, "1"]) await assert.rejects(() => f.invoke("email_read", { limit }), /limit/);
});

test("malformed recipients, header injection and excessive mail fail before mailbox or ask", async () => {
  const f = fixture();
  for (const to of ["x", "a@b", "a@example.invalid,b@example.invalid", "Name <a@example.invalid>", "a@example.invalid\r\nBcc:b@example.invalid", ".a@example.invalid", "a..b@example.invalid", "a.@example.invalid", "a@bad-.invalid"]) await assert.rejects(() => f.invoke("email_send", { ...mail(), to }), /Invalid email/);
  for (const change of [{ subject: "x\nBcc:x" }, { subject: "x".repeat(999) }, { body: "" }, { body: " " }, { body: "\0" }, { body: "x".repeat(64001) }, { agent: "a-2" }]) await assert.rejects(() => f.invoke("email_send", { ...mail(), ...change }), /Invalid email/);
  assert.deepEqual(f.calls.address, []);
  assert.deepEqual(f.calls.asks, []);
});

test("provider failures and malformed payloads never leak provider errors or credentials", async () => {
  const secret = generated[0]?.privateKey ?? "fake-provider-token";
  for (const operation of ["address", "read", "send"]) {
    const f = fixture();
    f.mailbox[operation] = async () => { throw new Error(secret + " fake-provider-token"); };
    const name = operation === "address" ? "email_address" : operation === "read" ? "email_read" : "email_send";
    const result = await f.invoke(name, name === "email_send" ? mail() : {});
    assert.equal(result.unavailable, true);
    noSecrets([result, f.calls.records, f.calls.asks]);
    if (operation === "send") assert.match(result.reason, /Delivery is unknown/);
  }
  for (const messages of [null, [{}], [{ from: "bad", subject: "subject", text: "text" }], [{ from: "ok@example.invalid", subject: "a\nb", text: "text" }], [{ from: "ok@example.invalid", subject: "subject", text: "x".repeat(64001) }]]) {
    const f = fixture({ mailbox: { read: async () => messages } });
    assert.equal((await f.invoke("email_read")).unavailable, true);
  }
  for (const id of [undefined, "raw\nmail", "fake token with spaces", secret]) {
    const f = fixture(); f.mailbox.send = async () => ({ id });
    assert.equal((await f.invoke("email_send", mail())).unavailable, true);
  }
});

test("human funding and test-account asks cannot automate funding, account creation or login", async () => {
  const f = fixture();
  const funded = await f.invoke("wallet_fund");
  assert.equal(funded.funding, "human-reported");
  assert.equal(funded.verified, false);
  assert.match(f.calls.asks[0].input.question, /isolated local fork only/);
  const account = await f.invoke("test_account", { service: "service.example.invalid" });
  assert.deepEqual(account, { access: "human-reported", verified: false });
  assert.match(f.calls.asks[1].input.question, /passwords and codes out of chat/);
  assert.deepEqual(f.calls.address, []);
  assert.deepEqual(f.calls.sent, []);
  assert.deepEqual(f.calls.machine, []);
  for (const service of ["https://service.example.invalid", "a@service.invalid", "service.invalid/login?password=secret", "localhost"]) await assert.rejects(() => f.invoke("test_account", { service }), /hostname/);
  noSecrets([funded, account, f.calls]);
});

test("ask or record failure cannot invoke a send or echo private details", async () => {
  const bad = "fake-provider-token";
  const f = fixture({ ask: async () => { throw new Error(bad); } });
  await assert.rejects(() => f.invoke("email_send", mail()), { message: "Human approval failed; no action was taken." });
  assert.deepEqual(f.calls.sent, []);
  const g = fixture({ record: async () => { throw new Error(bad); } });
  await assert.rejects(() => g.invoke("email_send", mail()), /recording failed/);
  assert.deepEqual(g.calls.sent, []);
  assert.deepEqual(g.calls.asks, []);
});
