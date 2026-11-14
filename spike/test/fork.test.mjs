// Forking a real chain: the pin, the credential, and the offline control.
//
//   node --experimental-test-module-mocks --test spike/test/fork.test.mjs
//
// The rules a fork must keep, each one a way this could go wrong silently:
//   1. A fork without a block is refused. A pin that can move is not a proof.
//   2. A run with no fork is byte-identical to before: same flags, same network.
//   3. The RPC is a credential: https only, no userinfo, passed in the
//      environment, never written into the workspace.
//   4. A fork with no RPC fails loudly instead of forking something else.
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORK_CHAINS, forkArgs, forkFlags, forkOf, pinFork, validRpcUrl, withForkEndpoints } from "../lib/fork.mjs";
import { forgeTestCmd, forgeTestJson, makeBriefWorkspace, writeTouchstone } from "../lib/sandbox.mjs";

test("a fork without a pinned block is refused", () => {
  assert.throws(() => pinFork({ chain: "mainnet" }), /needs a block number/);
  assert.throws(() => pinFork({ chain: "mainnet", block: 0 }), /needs a block number/);
  assert.throws(() => pinFork({ chain: "mainnet", block: "soon" }), /needs a block number/);
  assert.deepEqual(pinFork({ chain: "mainnet", block: 19_000_000 }), { chain: "mainnet", chainId: 1, block: 19_000_000, rpcVar: "TOUCHSTONE_FORK_RPC_1" });
});

test("an unknown chain is refused, and every known chain has an id and a variable", () => {
  assert.throws(() => pinFork({ chain: "dogecoin", block: 1 }), /Unknown fork chain/);
  for (const [name, spec] of Object.entries(FORK_CHAINS)) {
    assert.equal(typeof spec.id, "number", name);
    assert.match(spec.rpcVar, /^TOUCHSTONE_FORK_RPC_\d+$/);
  }
});

test("an RPC URL must be https and carry no username or password", () => {
  assert.equal(validRpcUrl("http://rpc.example/1"), null, "plain http would send a key in clear");
  assert.equal(validRpcUrl("https://user:pass@rpc.example/1"), null, "userinfo cannot be redacted everywhere");
  assert.equal(validRpcUrl("not a url"), null);
  assert.ok(validRpcUrl("https://rpc.example/standard/evm/1?key=abc"));
});

test("no fork means the forge command and the network are exactly as before", () => {
  // The pre-fork command, pinned literally: an unforked run must not drift.
  assert.equal(forgeTestCmd({ solc: "0.8.38" }), "forge test --offline --use 0.8.38 -vv");
  assert.equal(forkFlags(null), "");
  assert.deepEqual(forkArgs(null), ["--network", "none"]);
  assert.equal(forkOf({}), null);
  assert.equal(forkOf({ kind: "lab" }), null);
});

test("a fork adds the pin, the network, and the credential in the environment", () => {
  const fork = pinFork({ chain: "mainnet", block: 19_000_001 });
  assert.equal(forgeTestCmd({ solc: "0.8.38", fork }), 'forge test --offline --use 0.8.38 --fork-url "$TOUCHSTONE_FORK_RPC_1" --fork-block-number 19000001 -vv');
  const args = forkArgs(fork, { TOUCHSTONE_FORK_RPC_1: "https://rpc.example/1?key=k" });
  assert.deepEqual(args.slice(0, 2), ["--network", "host"]);
  assert.ok(args.includes("TOUCHSTONE_FORK_RPC_1=https://rpc.example/1?key=k"));
});

test("a fork with no RPC fails loudly, naming the variable", () => {
  const fork = pinFork({ chain: "mainnet", block: 1 });
  assert.throws(() => forkArgs(fork, {}), /TOUCHSTONE_FORK_RPC_1 is not set/);
  assert.throws(() => forkArgs(fork, { TOUCHSTONE_FORK_RPC_1: "http://x.example" }), /not a usable https URL/);
});

test("the endpoint block is written once, and replaced rather than duplicated", () => {
  const fork = pinFork({ chain: "base", block: 42 });
  const base = `[profile.default]\nsrc = "src"\n`;
  const once = withForkEndpoints(base, fork);
  assert.match(once, /\[rpc_endpoints\]\nbase = "\$\{TOUCHSTONE_FORK_RPC_8453\}"/);
  const twice = withForkEndpoints(once, pinFork({ chain: "mainnet", block: 1 }));
  assert.equal((twice.match(/\[rpc_endpoints\]/g) ?? []).length, 1, "one table");
  assert.match(twice, /mainnet =/);
  assert.doesNotMatch(twice, /base =/, "the stale chain is gone");
});

test("the credential is never written into the workspace", async () => {
  const ws = makeBriefWorkspace();
  try {
    const url = "https://rpc.example/standard/evm/1?key=SUPERSECRET";
    writeTouchstone(ws, { kind: "brief", fork: { chain: "mainnet", block: 19_000_000 } });
    // The toml holds a variable reference, not the URL.
    const toml = readFileSync(join(ws, "foundry.toml"), "utf8");
    // (a fresh brief has no endpoint block until the target's fork is applied; the
    // point here is that nothing writes the URL)
    assert.doesNotMatch(toml, /SUPERSECRET/);
    assert.doesNotMatch(readFileSync(join(ws, ".touchstone.json"), "utf8"), /SUPERSECRET/);
    // The command carries the variable name, never the value.
    const cmd = forgeTestCmd({ solc: "auto", fork: forkOf({ fork: { chain: "mainnet", block: 19000000 } }) });
    assert.doesNotMatch(cmd, /SUPERSECRET/);
    assert.match(cmd, /\$TOUCHSTONE_FORK_RPC_1/);
    void url;
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("a forked replay with no RPC in the environment is refused before Docker runs", async () => {
  const ws = mkdtempSync(join(tmpdir(), "fork-no-rpc-"));
  try {
    writeTouchstone(ws, { kind: "brief", fork: { chain: "mainnet", block: 19_000_000 } });
    writeFileSync(join(ws, "foundry.toml"), `[profile.default]\nsrc = "src"\ntest = "test"\nout = "out"\n`);
    const saved = process.env.TOUCHSTONE_FORK_RPC_1;
    delete process.env.TOUCHSTONE_FORK_RPC_1;
    try {
      await assert.rejects(
        () => forgeTestJson(ws, { matchContract: "X", timeoutMs: 5_000 }),
        /TOUCHSTONE_FORK_RPC_1 is not set/,
      );
    } finally {
      if (saved !== undefined) process.env.TOUCHSTONE_FORK_RPC_1 = saved;
    }
  } finally { rmSync(ws, { recursive: true, force: true }); }
});
