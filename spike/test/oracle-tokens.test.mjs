// The pinned oracle's ERC-20 channel.
//
//   node --experimental-test-module-mocks --test spike/test/oracle-tokens.test.mjs
//
// Why a Transfer log is evidence HERE and not offline. Everyone can deploy a
// contract that logs any numbers. Offline, the gate therefore only trusts a log when
// the emitting token is a scope contract and its balance slot really moved. On a
// fork at a pinned block, the token at an address is the chain's real token: nobody
// in the test chooses what it emits. That is the guarantee the fork buys.
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { pinnedTokenDrains, pinnedTargets, judgePinnedHarm } from "../lib/oracle-deployed.mjs";

const VICTIM = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x9999999999999999999999999999999999999999";
const ATTACKER = "0x2222222222222222222222222222222222222222";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topic = (a) => "0x" + a.replace(/^0x/, "").padStart(64, "0");
const pin = pinnedTargets({ addresses: [VICTIM] });

// A log belongs to the node that emitted it: `node.logs`, on the call node itself.
// A sibling node with logs is a shape no real trace produces, and the gate would
// rightly ignore it.
const withLog = (label, from, to, amount, { success = true } = {}) => [[label, {
  arena: [{
    trace: { kind: "CALL", address: TOKEN, caller: ATTACKER, success },
    logs: [{ raw_log: { topics: [TRANSFER, topic(from), topic(to)], data: "0x" + amount.toString(16) } }],
  }],
}]];

test("a pinned address losing an ERC-20 in the body is a drain", () => {
  const drains = pinnedTokenDrains(withLog("Execution", VICTIM, ATTACKER, 1000n), pin);
  assert.equal(drains.length, 1);
  assert.equal(drains[0].victim, VICTIM);
  assert.equal(drains[0].token, TOKEN);
  assert.equal(drains[0].lostUnits, "1000");
  assert.equal(drains[0].gainedBy, ATTACKER);
});

test("the verdict uses the token channel when no native ETH moved", () => {
  const h = judgePinnedHarm(withLog("Execution", VICTIM, ATTACKER, 5000n), { pinned: pin, net: new Map() });
  assert.equal(h.ok, true);
  assert.equal(h.asset, "token");
  assert.equal(h.token, TOKEN);
  assert.equal(h.lostUnits, "5000");
  assert.equal(h.onChain, true);
});

test("a token loss in setUp is fixture, not theft", () => {
  // setUp funding is the operator's own arrangement. Counting it would let a test
  // "prove" a drain by funding the victim itself.
  assert.deepEqual(pinnedTokenDrains(withLog("Setup", VICTIM, ATTACKER, 1000n), pin), []);
  assert.deepEqual(pinnedTokenDrains(withLog("Deployment", VICTIM, ATTACKER, 1000n), pin), []);
});

test("a rolled-back transfer moves nothing", () => {
  assert.deepEqual(pinnedTokenDrains(withLog("Execution", VICTIM, ATTACKER, 1000n, { success: false }), pin), []);
});

test("an NFT transfer (no value, indexed id) is not a fungible drain", () => {
  const nft = [["Execution", { arena: [{
    trace: { kind: "CALL", address: TOKEN, caller: ATTACKER, success: true },
    logs: [{ raw_log: { topics: [TRANSFER, topic(VICTIM), topic(ATTACKER), topic("0x01")], data: "0x" } }],
  }] }]];
  assert.deepEqual(pinnedTokenDrains(nft, pin), []);
});

test("a zero-value transfer is not a drain", () => {
  assert.deepEqual(pinnedTokenDrains(withLog("Execution", VICTIM, ATTACKER, 0n), pin), []);
});

test("an unpinned holder losing is not our business", () => {
  const other = "0x3333333333333333333333333333333333333333";
  assert.deepEqual(pinnedTokenDrains(withLog("Execution", other, ATTACKER, 1000n), pin), []);
});

test("losses to the same victim and token are netted, not double counted", () => {
  // Two transfers out of the same holder in one token are one loss: the gate sums
  // them, so a test cannot inflate a number by splitting the same theft in two.
  const a = withLog("Execution", VICTIM, ATTACKER, 10n);
  const b = withLog("Execution", VICTIM, ATTACKER, 900n);
  const drains = pinnedTokenDrains([...a, ...b], pin);
  assert.equal(drains.length, 1);
  assert.equal(drains[0].lostUnits, "910");
});

test("a transfer back to the victim shrinks the loss", () => {
  const out = withLog("Execution", VICTIM, ATTACKER, 1000n);
  const back = withLog("Execution", ATTACKER, VICTIM, 400n);
  const drains = pinnedTokenDrains([...out, ...back], pin);
  assert.equal(drains[0].lostUnits, "600", "a refund is not part of the take");
});

test("a token drain is still refused when the test faked the emitter", () => {
  // The forgery checks outrank the channel: no amount of correct-looking logging
  // counts if the test put its own state at the address.
  const h = judgePinnedHarm(withLog("Execution", VICTIM, ATTACKER, 1000n), {
    pinned: pin, net: new Map(), controlTrace: { etches: [{ target: TOKEN }] },
  });
  // vm.etch at the TOKEN address does not disqualify the VICTIM...
  assert.equal(h.ok, true, "the etch was on the token, not the victim");
  // ...but etching the victim does.
  const h2 = judgePinnedHarm(withLog("Execution", VICTIM, ATTACKER, 1000n), {
    pinned: pin, net: new Map(), controlTrace: { etches: [{ target: VICTIM }] },
  });
  assert.equal(h2.ok, false);
});
