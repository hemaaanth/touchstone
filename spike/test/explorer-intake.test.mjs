// Starting from a deployment address: the verified source is fetched and stored
// as an ordinary folder member, and a refusal is a sentence, not a guess.
import "./helpers/isolated-env.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { checkDeployment, verifiedSources } from "../lib/explorer.mjs";

const ADDR = "0x28B3a8fb53B741A8Fd78c0fb9A6B2393d896a43d";
const body = (sources) => JSON.stringify({ compilation: { name: "Vault" }, sources });
const serve = (payload) => async () => payload;

test("chain and address are checked before any fetch", () => {
  assert.deepEqual(checkDeployment(1, ADDR.toUpperCase()), { chainId: 1, address: ADDR.toLowerCase() }, "a mixed-case address is lowercased");
  for (const [c, a] of [[0, ADDR], ["x", ADDR], [1, "0x123"], [1, "deadbeef"]]) {
    assert.throws(() => checkDeployment(c, a));
  }
});

test("sources are kept, dependencies and secrets dropped, name carried", async () => {
  const raw = body({
    "src/Vault.sol": { content: "contract Vault {}" },
    "lib/oz/Context.sol": { content: "abstract contract Context {}" },
    "src/notes.txt": { content: "hello" },
    "logo.png": { content: "binary" },
    "src/Key.sol": { content: "// -----BEGIN PRIVATE KEY-----" },
  });
  const r = await verifiedSources(1, ADDR, { fetchText: serve(raw) });
  assert.deepEqual(r.files.map((f) => f.path), ["src/Vault.sol", "src/notes.txt"]);
  assert.equal(r.contractName, "Vault");
  assert.equal(r.dropped["dependency or build folder"], 1);
  assert.equal(r.dropped["secret file"], 1);
});

test("an unverified contract says so; a bad answer is not a crash", async () => {
  await assert.rejects(verifiedSources(1, ADDR, { fetchText: serve("{}") }), /No verified source/);
  await assert.rejects(verifiedSources(1, ADDR, { fetchText: serve("<html>") }), /not JSON/);
  await assert.rejects(verifiedSources(1, ADDR, { fetchText: async () => { throw new Error("ECONNRESET"); } }), /could not be reached/);
  await assert.rejects(verifiedSources(1, ADDR, { fetchText: serve(body({ "logo.png": { content: "x" } })) }), /would be empty/);
});
