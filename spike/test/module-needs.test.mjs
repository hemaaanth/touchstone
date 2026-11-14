// What a module needs before it can run on a target.
//
//   node --experimental-test-module-mocks --test spike/test/module-needs.test.mjs
//
// The rule this file protects: a module that cannot work is refused, in the
// console AND at run start, from ONE table. A lab never forks, so a lab never
// needs an RPC and every existing run keeps working; that is the first test.
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { providersFile } from "../lib/providers.mjs";
import { targetNeeds, targetsWithNeeds } from "../lib/module-needs.mjs";

// A test must not depend on the ambient shell: a developer (or a live test) may have
// TOUCHSTONE_FORK_RPC_<id> exported, which would make "no RPC configured" true only
// by accident. Each test states the whole world it needs.
const savedEnv = {};
for (const name of Object.keys(process.env)) if (/^TOUCHSTONE_FORK_RPC_\d+$/.test(name)) { savedEnv[name] = process.env[name]; delete process.env[name]; }
process.on("exit", () => { for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v; });
const saveRpc = (rpc) => writeFileSync(providersFile(), JSON.stringify({ rpc }, null, 2));

test("a target that does not fork needs nothing, so every existing run is unchanged", () => {
  for (const kind of ["lab", "local-source", "brief", "scope"]) {
    const r = targetNeeds({ kind, pack: "contracts" }, "contracts");
    assert.equal(r.ok, true, kind);
    assert.deepEqual(r.needs, [], kind);
  }
  // Every other module is likewise unaffected.
  for (const id of ["web", "supply-chain", "domains", "keys", "review", "ai-mcp"]) {
    assert.equal(targetNeeds({ kind: "lab", pack: id }, id).ok, true, id);
  }
});

test("a forked target with no RPC is refused, and says which variable to set", () => {
  saveRpc({});
  const r = targetNeeds({ kind: "scope", pack: "contracts", fork: { chain: "mainnet", block: 19_000_000 } }, "contracts");
  assert.equal(r.ok, false);
  const rpc = r.needs.find((n) => n.id === "fork-rpc");
  assert.equal(rpc.met, false);
  assert.equal(rpc.kind, "settings");
  assert.match(rpc.detail, /TOUCHSTONE_FORK_RPC_1/);
});

test("a forked target with no block is refused, even when the RPC is present", () => {
  saveRpc({ mainnet: { url: "https://rpc.example/1?key=abcd" } });
  const r = targetNeeds({ kind: "scope", pack: "contracts", fork: { chain: "mainnet" } }, "contracts");
  assert.equal(r.ok, false);
  assert.equal(r.needs.find((n) => n.id === "fork-block").met, false);
  assert.equal(r.needs.find((n) => n.id === "fork-rpc").met, true);
});

test("a forked target becomes ready once the chain has an RPC and a block", () => {
  saveRpc({ mainnet: { url: "https://rpc.example/1?key=abcd" } });
  const r = targetNeeds({ kind: "scope", pack: "contracts", fork: { chain: "mainnet", block: 19_000_000 } }, "contracts");
  assert.equal(r.ok, true, JSON.stringify(r.needs));
  assert.ok(r.needs.every((n) => n.met));
  // The detail names where the URL came from, without the URL itself.
  const rpc = r.needs.find((n) => n.id === "fork-rpc");
  assert.match(rpc.detail, /Saved in Settings, ending abcd/);
  assert.doesNotMatch(rpc.detail, /key=/);
});

test("a module that never forks is ready on a forked target: the pin cannot apply to it", () => {
  saveRpc({});
  // Review reads code and never reads a chain, so a scope's fork is not a reason
  // to block it. Refusing here would grey out a module for a need it cannot act on.
  const r = targetNeeds({ kind: "scope", pack: "review", fork: { chain: "mainnet", block: 1 } }, "review");
  assert.equal(r.ok, true);
  assert.deepEqual(r.needs, []);
  // Contracts on the same target IS blocked, because it does use the chain.
  const c = targetNeeds({ kind: "scope", pack: "contracts", fork: { chain: "mainnet", block: 1 } }, "contracts");
  assert.equal(c.ok, false, "no RPC for the chain, so Contracts cannot run");
  assert.equal(c.needs.find((n) => n.id === "fork-block").met, true);
  assert.equal(c.needs.find((n) => n.id === "fork-rpc").met, false);
});

test("an unknown chain is refused with the list of chains this build can fork", () => {
  const r = targetNeeds({ kind: "scope", pack: "contracts", fork: { chain: "dogecoin", block: 1 } }, "contracts");
  assert.equal(r.ok, false);
  assert.match(r.needs[0].detail, /is not a chain this build can fork/);
});

test("a target list is marked unrunnable by its unmet needs, and ready ones are untouched", () => {
  saveRpc({});
  const rows = targetsWithNeeds([
    { id: "lab", title: "Lab", runnable: true, packs: ["contracts"] },
    { id: "f", title: "Forked", runnable: true, packs: ["contracts"], fork: { chain: "mainnet", block: 5 } },
  ]);
  const lab = rows.find((t) => t.id === "lab");
  const f = rows.find((t) => t.id === "f");
  assert.equal(lab.runnable, true);
  assert.deepEqual(lab.needs, []);
  assert.equal(f.runnable, false, "a fork with no RPC cannot start");
  assert.equal(f.needs.length, 1);
});

test("a forked scope that also allows Review still runs, because Review never forks", () => {
  saveRpc({});
  // The scope's declared module is Contracts, and Review is also allowed. Review
  // reads code and never touches a chain, so it needs no RPC: the target is
  // startable under Review even while Contracts is blocked.
  const rows = targetsWithNeeds([
    { id: "f", title: "Forked", runnable: true, pack: "contracts", packs: ["contracts", "review"], fork: { chain: "mainnet", block: 5 } },
  ]);
  assert.equal(rows[0].runnable, true);
  assert.deepEqual(rows[0].needs, []);
});
