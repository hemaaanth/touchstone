// The deployed oracle: harm to a contract that already exists on a real chain.
//
//   node --experimental-test-module-mocks --test spike/test/oracle-deployed.test.mjs
//
// The premise this file protects. Every other harm channel only counts a victim the
// TEST deployed from source. That is what makes an offline proof unforgeable, and it
// is also why an offline gate scores zero on a corpus of real incidents (901 of 901
// fork a chain and attack a real address). This oracle widens the victim set, so it
// must close every way a test can fabricate one — each case below is one of those.
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createdByTest, judgePinnedHarm, pinnedTargets, pinnedTamperNote } from "../lib/oracle-deployed.mjs";

const VICTIM = "0x1111111111111111111111111111111111111111";
const ATTACKER = "0x2222222222222222222222222222222222222222";
const pin = pinnedTargets({ addresses: [VICTIM], label: "Vault" });
const drained = new Map([[VICTIM, -1000n], [ATTACKER, 1000n]]);
const trace = (kind, address, over = {}) => [["Execution", { arena: [{ trace: { kind, address, caller: ATTACKER, ...over } }] }]];

test("the pinned list is normalized and a malformed address is dropped, never guessed", () => {
  const p = pinnedTargets({ addresses: [VICTIM.toUpperCase().replace("0X", "0x"), "0xnope", ""], label: "V" });
  assert.deepEqual([...p.keys()], [VICTIM]);
  assert.equal(p.get(VICTIM), "V");
  assert.equal(pinnedTargets({ addresses: [] }), null, "no addresses is no pin");
  assert.equal(pinnedTargets(null), null);
  assert.equal(pinnedTargets({ addresses: ["0xnope"] }), null, "all malformed is no pin");
});

test("a pinned address that lost ETH to a gainer is proven", () => {
  const h = judgePinnedHarm([], { pinned: pin, net: drained });
  assert.equal(h.ok, true);
  assert.equal(h.kind, "funds");
  assert.equal(h.victim, VICTIM);
  assert.equal(h.lostWei, "1000");
  assert.equal(h.gainedBy, ATTACKER);
  assert.equal(h.onChain, true, "the verdict says it judged a real chain");
});

test("a burn is not a theft: a loss with no gainer is refused", () => {
  const h = judgePinnedHarm([], { pinned: pin, net: new Map([[VICTIM, -1000n]]) });
  assert.equal(h.ok, false);
  assert.match(h.reason, /burn is not a theft/);
});

test("a pinned address that GAINED is not a victim", () => {
  const h = judgePinnedHarm([], { pinned: pin, net: new Map([[VICTIM, 1000n], [ATTACKER, -1000n]]) });
  assert.equal(h.ok, false);
  assert.match(h.reason, /no pinned address lost native ETH/);
});

test("an unpinned address losing is not our business", () => {
  const other = "0x3333333333333333333333333333333333333333";
  const h = judgePinnedHarm([], { pinned: pin, net: new Map([[other, -1000n], [ATTACKER, 1000n]]) });
  assert.equal(h.ok, false);
});

// ---- the four forgeries, plus the one a fork adds ----------------------------

test("vm.etch at the pinned address disqualifies it: it is no longer the deployed contract", () => {
  const h = judgePinnedHarm([], { pinned: pin, net: drained, controlTrace: { etches: [{ target: VICTIM }] } });
  assert.equal(h.ok, false);
  assert.match(h.reason, /wrote code at pinned address/);
});

test("a prank AS the pinned address disqualifies it: the test cannot be its own victim", () => {
  const h = judgePinnedHarm([], { pinned: pin, net: drained, controlTrace: { pranks: [VICTIM] } });
  assert.equal(h.ok, false);
  assert.match(h.reason, /impersonated pinned address/);
});

test("a cheatcode write to the pinned address disqualifies it: the loss may be what it granted", () => {
  const h = judgePinnedHarm([], { pinned: pin, net: drained, controlTrace: { tampers: [{ target: VICTIM, how: "store" }] } });
  assert.equal(h.ok, false);
  assert.match(h.reason, /set the state of pinned address/);
});

test("a wildcard tamper disqualifies every pinned address", () => {
  const notes = pinnedTamperNote({ tampers: [{ target: "*", how: "store" }] }, pin);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /pinned address/);
});

test("code the test CREATED at a pinned address is a forgery: a fork's addresses already exist", () => {
  // This is the forgery the offline gate never had to consider. On a fork, a test
  // can deploy its own contract at a chosen address; the address then looks real.
  assert.deepEqual(createdByTest(trace("CREATE", VICTIM), pin), [VICTIM]);
  const h = judgePinnedHarm(trace("CREATE", VICTIM), { pinned: pin, net: drained });
  assert.equal(h.ok, false);
  assert.match(h.reason, /deployed its own code at pinned address/);
  // CREATE2 with a salt is still the test's contract.
  assert.deepEqual(createdByTest(trace("CREATE2", VICTIM), pin), [VICTIM]);
  // Creating something ELSE at another address is normal and irrelevant.
  assert.deepEqual(createdByTest(trace("CREATE", ATTACKER), pin), []);
});

test("a clean call into the pinned address is not a forgery", () => {
  assert.deepEqual(createdByTest(trace("CALL", VICTIM), pin), []);
  const h = judgePinnedHarm(trace("CALL", VICTIM), { pinned: pin, net: drained });
  assert.equal(h.ok, true);
});

test("no pin means no deployed oracle: the offline path is untouched", () => {
  const h = judgePinnedHarm([], { pinned: null, net: drained });
  assert.equal(h.ok, false);
  assert.match(h.reason, /no pinned address was given/);
});

test("the biggest loss wins when several pinned addresses are hit", () => {
  const second = "0x4444444444444444444444444444444444444444";
  const two = pinnedTargets({ addresses: [VICTIM, second] });
  const net = new Map([[VICTIM, -500n], [second, -9000n], [ATTACKER, 9500n]]);
  const h = judgePinnedHarm([], { pinned: two, net });
  assert.equal(h.ok, true);
  assert.equal(h.victim, second);
  assert.equal(h.lostWei, "9000");
});

// ---- live: a real incident, through the real gate ---------------------------
//
// Opt-in, because it needs two things a checkout does not carry: an RPC and the
// DeFiHackLabs corpus. The measurement it encodes (2026-11-14): Euler, $197M,
// 2023-03, block 16817995 — the replay drains real DAI from a real address, and the
// deployed oracle credits it. An offline gate scores zero on this PoC by
// construction, because the victim is not a contract the test deployed.
const RPC = process.env.RPC_URL ?? process.env.MAINNET_RPC_URL ?? "";
const CORPUS = process.env.HACK_CORPUS ?? "";
const skipLive = RPC && CORPUS ? false : "set RPC_URL and HACK_CORPUS to run a live incident";

test("a real $197M incident is proven against the real address, on a fork", { skip: skipLive, timeout: 900_000 }, async () => {
  const { cpSync, mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { makeBriefWorkspace, writeTouchstone } = await import("../lib/sandbox.mjs");
  const { applyForkToWorkspace } = await import("../lib/fork.mjs");
  const { proofDelta } = await import("../lib/proof.mjs");
  const rel = "2023-03/Euler_exp.sol";
  const src = readFileSync(join(CORPUS, rel), "utf8");
  const ws = makeBriefWorkspace();
  process.env.TOUCHSTONE_FORK_RPC_1 = RPC;
  try {
    writeTouchstone(ws, { kind: "brief", solc: "auto" });
    cpSync(join(CORPUS, "interface.sol"), join(ws, "test", "interface.sol"));
    for (const h of ["basetest.sol", "tokenhelper.sol"]) { try { cpSync(join(CORPUS, h), join(ws, "test", h)); } catch { /* not needed by this PoC */ } }
    mkdirSync(join(ws, "test", dirname(rel)), { recursive: true });
    cpSync(join(CORPUS, rel), join(ws, "test", rel));
    const fm = src.match(/createSelectFork\(\s*"([a-z_]+)"\s*,\s*([0-9_]+)/);
    const addrs = [...new Set([...src.matchAll(/0x[0-9a-fA-F]{40}/g)].map((m) => m[0].toLowerCase()))];
    applyForkToWorkspace(ws, { fork: { chain: fm[1], block: Number(fm[2].replace(/_/g, "")), addresses: addrs } }, {
      readCfg: () => JSON.parse(readFileSync(join(ws, ".touchstone.json"), "utf8")),
      writeCfg: (c) => writeFileSync(join(ws, ".touchstone.json"), JSON.stringify(c)),
    });
    const d = await proofDelta(ws, { contract: "ContractTest", timeoutMs: 600_000 });
    assert.equal(d?.pass, true, "the corpus PoC replays green");
    assert.equal(d?.harm?.ok, true, JSON.stringify(d?.harm));
    assert.equal(d.harm.onChain, true);
    assert.equal(d.harm.asset, "token");
    // DAI, from Euler's contract. The PoC's own addresses, not one we chose.
    assert.equal(d.harm.token, "0x6b175474e89094c44da98b954eedeac495271d0f");
    assert.ok(BigInt(d.harm.lostUnits) > 10n ** 18n, "a real, large loss");
  } finally {
    delete process.env.TOUCHSTONE_FORK_RPC_1;
  }
});

// The pin must survive the path a human's scope takes: created by addScope, listed,
// prepared into a run workspace, then read by the gate from that workspace's config.
// A break anywhere in that chain leaves the oracle with no victim, and the run would
// silently fall back to the offline rules — the exact failure this whole feature
// exists to remove.
test("a pinned scope carries its addresses from creation to the gate's config", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { writeFileSync } = await import("node:fs");
  const { providersFile } = await import("../lib/providers.mjs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pin-scope-"));
  const prevScopes = process.env.TOUCHSTONE_SCOPES_FILE;
  const prevProviders = process.env.TOUCHSTONE_PROVIDERS_FILE;
  process.env.TOUCHSTONE_SCOPES_FILE = join(dir, "scopes.json");
  process.env.TOUCHSTONE_PROVIDERS_FILE = join(dir, "providers.json");
  // An RPC in the store, so the scope is ready and the run would really start.
  writeFileSync(providersFile(), JSON.stringify({ rpc: { mainnet: { url: "https://rpc.example/1?key=abcd" } } }));
  try {
    const { addScope } = await import("../lib/scopes-store.mjs");
    const { prepareRunWorkspace } = await import("../lib/targets.mjs");
    const { readTouchstone } = await import("../lib/sandbox.mjs");
    const ADDR = "0x27182842e098f60e3d576794a5bffb0777e025d3";
    const scope = addScope({
      title: "Pin survives",
      members: [{ kind: "folder", name: "euler", files: [{ path: "V.sol", content: "contract V {}" }] }],
      pack: "contracts",
      // Upper case on the way in: the store normalizes it, and every later step
      // compares lower case.
      fork: { chain: "mainnet", block: 16_817_995, addresses: [ADDR.toUpperCase().replace("0X", "0x")] },
    });
    assert.deepEqual(scope.fork.addresses, [ADDR], "the scope keeps the addresses, normalized");
    const ws = await prepareRunWorkspace(scope, {});
    const cfg = readTouchstone(ws);
    assert.equal(cfg.fork.chain, "mainnet");
    assert.equal(cfg.fork.block, 16_817_995);
    // This is what the gate reads: the run's own record, not an argument.
    assert.deepEqual(cfg.forkTargets.addresses, [ADDR]);
  } finally {
    if (prevScopes === undefined) delete process.env.TOUCHSTONE_SCOPES_FILE; else process.env.TOUCHSTONE_SCOPES_FILE = prevScopes;
    if (prevProviders === undefined) delete process.env.TOUCHSTONE_PROVIDERS_FILE; else process.env.TOUCHSTONE_PROVIDERS_FILE = prevProviders;
  }
});
