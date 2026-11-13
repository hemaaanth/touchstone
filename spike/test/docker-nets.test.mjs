// The harness may remove only networks it named. An unrelated network created
// in the same daemon must still be there after a prune of a harness prefix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createOwnedNetwork, isOwnedNetwork, pruneOwnedNetworks, removeOwnedNetwork } from "../lib/docker-nets.mjs";
import { skipUnlessDocker } from "./docker-skip.mjs";

const skip = skipUnlessDocker();
const tag = `${process.pid.toString(16)}${Date.now().toString(16)}`;

test("a name outside the harness prefixes is not owned", () => {
  assert.equal(isOwnedNetwork("bridge"), false);
  assert.equal(isOwnedNetwork("host"), false);
  assert.equal(isOwnedNetwork("none"), false);
  assert.equal(isOwnedNetwork("touchstone-reach-client-ab"), true);
  assert.equal(isOwnedNetwork("my-touchstone-reach-client-ab"), false);
  assert.equal(isOwnedNetwork(""), false);
});

test("removeOwnedNetwork refuses the default bridge", async () => {
  await assert.rejects(() => removeOwnedNetwork("bridge"), /not a harness network/);
});

test("prune refuses a prefix the harness does not own", async () => {
  await assert.rejects(() => pruneOwnedNetworks({ prefixes: ["bridge"] }), /not a harness prefix/);
});

test("createOwnedNetwork is gone after removeOwnedNetwork", { skip }, async () => {
  const name = `touchstone-reach-client-life${tag}`;
  const created = await createOwnedNetwork(name, ["--internal"]);
  assert.equal(created.code, 0, created.stderr);
  try {
    const removed = await removeOwnedNetwork(name);
    assert.equal(removed.code, 0, removed.stderr);
    assert.throws(() => execFileSync("docker", ["network", "inspect", name], { stdio: "ignore" }));
  } finally {
    try { execFileSync("docker", ["network", "rm", name], { stdio: "ignore" }); } catch { /* already gone */ }
  }
});

test("prune removes a leaked harness network and leaves an unrelated one", { skip }, async () => {
  const leak = `touchstone-reach-client-leak${tag}`;
  const keep = `cursor-unrelated-${tag}`;
  execFileSync("docker", ["network", "create", leak], { stdio: "ignore" });
  execFileSync("docker", ["network", "create", keep], { stdio: "ignore" });
  try {
    const result = await pruneOwnedNetworks({ prefixes: [leak], containers: false });
    assert.ok(result.removed.includes(leak), `pruned ${result.removed.join(" ")}`);
    execFileSync("docker", ["network", "inspect", keep], { stdio: "ignore" });
    assert.throws(() => execFileSync("docker", ["network", "inspect", leak], { stdio: "ignore" }));
  } finally {
    for (const name of [keep, leak]) {
      try { execFileSync("docker", ["network", "rm", name], { stdio: "ignore" }); } catch { /* already gone */ }
    }
  }
});
