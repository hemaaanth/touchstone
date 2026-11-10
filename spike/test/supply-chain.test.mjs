import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinSnapshot, loadSnapshot, replayEvidence, proveFindings, redactSecret, sha256 } from "../lib/proof-evidence.mjs";
import { cryptoLeads, cryptoDetectors } from "../packs/supply-chain/crypto.mjs";
import { makeLabWorkspace } from "../packs/supply-chain/lab.mjs";
import { captureSnapshot } from "../packs/supply-chain/snapshot.mjs";

const temp = () => mkdtempSync(join(tmpdir(), "evidence-test-"));
const remove = (ws) => rmSync(ws, { recursive: true, force: true });

test("evidence requires pinned bytes, an allowlisted detector, and the exact location", async () => {
  const ws = temp();
  try {
    const snapshotHash = pinSnapshot(ws, { headers: { server: "lab" } });
    const detectors = { header: (s, where) => ({ ok: where === "server" && s.headers.server === "lab", detail: "DO NOT ECHO THIS SECRET" }) };
    const evidence = { check: "header", where: "server", snapshotHash };
    const pass = await replayEvidence(ws, evidence, { detectors });
    assert.equal(pass.status, "pass");
    assert.ok(!JSON.stringify(pass).includes("DO NOT ECHO"));
    for (const changed of [{ where: "other" }, { check: "toString" }, { check: "unknown" }, { snapshotHash: "0".repeat(64) }]) {
      assert.equal((await replayEvidence(ws, { ...evidence, ...changed }, { detectors })).status, "fail");
    }
    assert.throws(() => pinSnapshot(ws, { headers: { server: "changed" } }), /already pinned/);
    writeFileSync(join(ws, "snapshot.json"), readFileSync(join(ws, "snapshot.json"), "utf8") + "\n");
    assert.equal((await replayEvidence(ws, evidence, { detectors })).status, "fail");
  } finally { remove(ws); }
});

test("evidence refuses symlink escapes and uses the domain snapshotHash config", () => {
  const ws = temp(), outside = temp();
  try {
    const content = JSON.stringify({ dns: [] });
    writeFileSync(join(outside, "snapshot.json"), content);
    symlinkSync(join(outside, "snapshot.json"), join(ws, "snapshot.json"));
    writeFileSync(join(ws, ".touchstone.json"), JSON.stringify({ snapshotHash: sha256(content) }));
    assert.throws(() => loadSnapshot(ws), /escapes/);
  } finally { remove(ws); remove(outside); }
});

test("batch replay rejects unsupported findings and ranks supported findings worst first", async () => {
  const ws = temp();
  try {
    const snapshotHash = pinSnapshot(ws, { dns: ["record"] });
    const good = { check: "dns", where: 0, snapshotHash };
    const found = [{ severity: "low", evidence: good }, { severity: "critical", evidence: { ...good, check: "missing" } }, { severity: "high", evidence: good }];
    const proven = await proveFindings(ws, found, [], () => {}, { detectors: { dns: (s, w) => ({ ok: s.dns[w] === "record" }) } });
    assert.deepEqual(proven.map((f) => [f.severity, f.proof.status]), [["high", "pass"], ["low", "pass"]]);
  } finally { remove(ws); }
});

test("crypto checks reject scalars and unlabeled bytes32, and derive a known mnemonic account", () => {
  const key = "1".padStart(64, "0"), invalid = "0".repeat(64);
  const phrase = "test test test test test test test test test test test junk";
  const snapshot = { files: { "wallet.env": `PRIVATE_KEY=0x${key}\nPRIVATE_KEY=0x${invalid}\nHASH=0x${key}\nMNEMONIC=${phrase}\nMNEMONIC=test test test test test test test test test test test test\n` } };
  const leads = cryptoLeads(snapshot);
  assert.deepEqual(leads.map((l) => [l.check, l.lines[0], l.address]), [
    ["evm-private-key", 1, "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"],
    ["bip39-mnemonic", 4, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"],
  ]);
  const publicText = JSON.stringify(leads);
  assert.ok(!publicText.includes(phrase));
  assert.ok(!publicText.includes(key));
  assert.deepEqual(redactSecret(`0x${key}`), redactSecret(key.toUpperCase()));
  assert.equal(cryptoDetectors["evm-private-key"](snapshot, { ...leads[0].where, line: 2 }).ok, false);
});

test("RPC provider matching uses hostname boundaries and package warnings bind to one name", () => {
  const token = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
  const snapshot = { files: {
    "rpc.js": `"https://eth-mainnet.g.alchemy.com/v2/${token}"\n"https://mainnet.infura.io/v3/${token}"\n"https://lab.quiknode.pro/${token}/"\n"https://eth-mainnet.g.alchemy.com.evil.invalid/v2/${token}"`,
    "package.json": JSON.stringify({ dependencies: { ethers: "6", ethres: "1", viem: "1", vieem: "1", "@solana/web3.j": "1", unrelated: "1" } }),
  } };
  const leads = cryptoLeads(snapshot);
  assert.deepEqual(leads.filter((l) => l.check === "rpc-provider-key").map((l) => l.provider), ["Alchemy", "Infura", "QuickNode"]);
  assert.deepEqual(leads.filter((l) => l.package).map((l) => l.package), ["ethres", "vieem", "@solana/web3.j"]);
  const where = leads.find((l) => l.package === "ethres").where;
  assert.equal(cryptoDetectors["crypto-package-lookalike"](snapshot, { ...where, package: "ethers" }).ok, false);
  assert.ok(!JSON.stringify(leads).includes(token));
});

test("lab snapshot binds source to a commit and treats keystore address as metadata", async () => {
  const ws = await makeLabWorkspace();
  try {
    const snapshot = captureSnapshot(ws);
    assert.match(snapshot.commit, /^[a-f0-9]{40,64}$/);
    const keystore = cryptoLeads(snapshot).find((l) => l.check === "evm-keystore");
    assert.equal(keystore.addressSource, "keystore-metadata");
    writeFileSync(join(ws, "hardhat.config.js"), "changed");
    assert.throws(() => captureSnapshot(ws), /differs from pinned commit/);
  } finally { remove(ws); }
});

test("non-object JSON and unrelated config hashes do not become crypto findings", () => {
  const key = "1".padStart(64, "0");
  assert.deepEqual(cryptoLeads({ files: { "null.json": "null", "array.json": "[]", "hardhat.config.js": `const buildHash = \"0x${key}\";` } }), []);
});
