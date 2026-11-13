// fetch_source and the scope content gate, fully offline.
//
//   node --experimental-test-module-mocks --test spike/test/scope-fetch.test.mjs
//
// git (execFile) and DNS are mocked, and globalThis.fetch is stubbed, so no test
// here touches the network. A fake clone writes the files a test names.
//   B: only a scope member URL is fetched, only from GitHub hosts.
//   C: a Contracts run proves only once Solidity from the scope is on disk.
//   D: two members that share a name land in separate places.
//   E: a clone is filtered for secrets and held to the scope caps.
import { test, after, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as realChild from "node:child_process";
import * as realDns from "node:dns/promises";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ---- mocks: git clone, DNS, HTTP ---------------------------------------------

const clones = new Map(); // clone URL -> { "rel/path": content }
const gitCalls = [];
function execFile(cmd, args, opts, cb) {
  gitCalls.push({ cmd, args });
  const url = args.at(-2), dest = args.at(-1);
  const files = clones.get(url);
  setImmediate(() => {
    if (!files) return cb(Object.assign(new Error("fail"), { killed: false }), "", "fatal: repository not found");
    for (const [rel, content] of Object.entries({ ".git/config": "[core]\n", ".git/HEAD": "ref: refs/heads/main\n", ...files })) {
      mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
      if (typeof content === "object" && content?.link) symlinkSync(content.link, path.join(dest, rel)); // { link: target } plants a symlink
      else writeFileSync(path.join(dest, rel), content);
    }
    cb(null, "", "");
  });
}
mock.module("node:child_process", { exports: { ...realChild, default: { ...realChild, execFile }, execFile } });

let dnsAnswer = [{ address: "140.82.112.3", family: 4 }];
const dnsCalls = [];
const lookup = async (host) => { dnsCalls.push(host); return dnsAnswer; };
mock.module("node:dns/promises", { exports: { ...realDns, default: { ...realDns, lookup }, lookup } });

const blobs = new Map(); // raw URL -> body string, or { status }
const httpCalls = [];
globalThis.fetch = async (url) => {
  httpCalls.push(String(url));
  const b = blobs.get(String(url));
  if (b && typeof b === "object") return new Response(null, { status: b.status, headers: { location: "http://169.254.169.254/" } });
  return b == null ? new Response("nope", { status: 404 }) : new Response(b, { status: 200 });
};

const dir = mkdtempSync(path.join(tmpdir(), "scope-fetch-test-"));
process.env.TOUCHSTONE_SCOPES_FILE = path.join(dir, "scopes.json");
const cleanup = [dir];
after(() => { for (const d of cleanup) rmSync(d, { recursive: true, force: true }); });

const { fetchSource, memberDest, memberLinks, _internal } = await import("../lib/fetch.mjs");
const { addScope } = await import("../lib/scopes-store.mjs");
const { prepareWorkspace } = await import("../lib/targets.mjs");
const { planModules } = await import("../lib/modules.mjs");
const { readTouchstone } = await import("../lib/sandbox.mjs");
const { default: contracts, proofOpen } = await import("../packs/contracts/pack.mjs");

beforeEach(() => { clones.clear(); blobs.clear(); gitCalls.length = 0; httpCalls.length = 0; dnsCalls.length = 0; dnsAnswer = [{ address: "140.82.112.3", family: 4 }]; });

// A workspace whose .touchstone.json lists these member links.
function scopeWs(links) {
  const ws = mkdtempSync(path.join(tmpdir(), "scope-fetch-ws-"));
  cleanup.push(ws);
  mkdirSync(path.join(ws, "src"));
  mkdirSync(path.join(ws, "vendor"));
  writeFileSync(path.join(ws, ".touchstone.json"), JSON.stringify({ kind: "brief", links }));
  return ws;
}
const walk = (d, base = d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name), base) : [path.relative(base, path.join(d, e.name))])).sort();
const noNetwork = () => assert.deepEqual([gitCalls.length, httpCalls.length, dnsCalls.length], [0, 0, 0]);

// ---- B: member binding and host allowlist ------------------------------------

test("fetch_source refuses a GitHub URL that is not a scope member, before any network call", async () => {
  const ws = scopeWs(["https://github.com/acme/vault"]);
  clones.set("https://github.com/attacker/evil.git", { "src/E.sol": "contract E {}" });
  await assert.rejects(fetchSource(ws, "https://github.com/attacker/evil"), /not one of this scope's members/);
  await assert.rejects(fetchSource(ws, "https://github.com/acme/vault/tree/other-branch"), /not one of this scope's members/);
  await assert.rejects(fetchSource(ws, "https://github.com/acme/vault/blob/main/src/V.sol"), /not one of this scope's members/);
  noNetwork();
});

test("fetch_source refuses a non-GitHub URL even when the scope lists it", async () => {
  const bad = ["https://evil.example/x.sol", "http://169.254.169.254/latest/meta-data", "https://127.0.0.1/a.sol", "https://raw.githubusercontent.com/acme/vault/main/V.sol", "file:///etc/passwd"];
  const ws = scopeWs(bad);
  for (const url of bad) await assert.rejects(fetchSource(ws, url), /refused/, url);
  noNetwork();
});

test("a member matches after normalization (trailing slash, .git)", async () => {
  const ws = scopeWs(["https://github.com/acme/vault"]);
  clones.set("https://github.com/acme/vault.git", { "src/V.sol": "pragma solidity ^0.8.20;\ncontract V {}\n" });
  const r = await fetchSource(ws, "https://github.com/acme/vault.git/");
  assert.equal(r.where, "vendor/acme__vault");
  assert.ok(existsSync(path.join(ws, "vendor/acme__vault/src/V.sol")));
});

test("assertPublicHost contacts only github hosts and refuses a private DNS answer", async () => {
  const { assertPublicHost } = _internal;
  await assert.rejects(assertPublicHost("evil.example"), /refused host evil\.example/);
  await assert.rejects(assertPublicHost("10.0.0.1"), /refused host/);
  assert.deepEqual(dnsCalls, []); // an off-list host is never even resolved
  await assertPublicHost("github.com");
  dnsAnswer = [{ address: "140.82.112.3", family: 4 }, { address: "127.0.0.1", family: 4 }];
  await assert.rejects(assertPublicHost("github.com"), /non-public address \(127\.0\.0\.1\)/);
  dnsAnswer = [{ address: "::ffff:192.168.1.5", family: 6 }];
  await assert.rejects(assertPublicHost("raw.githubusercontent.com"), /non-public/);
});

test("git clones with redirects, hooks, prompts and non-https protocols off", async () => {
  const ws = scopeWs(["https://github.com/acme/vault/tree/v1.2"]);
  clones.set("https://github.com/acme/vault.git", { "V.sol": "contract V {}" });
  const r = await fetchSource(ws, "https://github.com/acme/vault/tree/v1.2");
  assert.equal(r.where, "vendor/acme__vault@v1.2");
  const [{ cmd, args }] = gitCalls;
  assert.equal(cmd, "git");
  const flags = args.join(" ");
  for (const f of ["protocol.allow=never", "protocol.https.allow=always", "core.hooksPath=/dev/null", "http.followRedirects=false", "--depth 1", "--branch v1.2"]) assert.ok(flags.includes(f), f);
  assert.ok(!existsSync(path.join(ws, "vendor/acme__vault@v1.2/.git")), "history is dropped");
});

test("a blob fetch refuses a redirect", async () => {
  const ws = scopeWs(["https://github.com/acme/vault/blob/main/src/V.sol"]);
  blobs.set("https://raw.githubusercontent.com/acme/vault/main/src/V.sol", { status: 302 });
  await assert.rejects(fetchSource(ws, "https://github.com/acme/vault/blob/main/src/V.sol"), /refused a redirect/);
  assert.ok(!existsSync(path.join(ws, "vendor/files")));
});

test("a brief workspace records its links, so fetch_source has a member list", () => {
  const links = ["https://github.com/acme/vault", "https://github.com/acme/token/blob/main/T.sol"];
  const ws = prepareWorkspace({ kind: "brief", id: "brief-x", brief: "# x", links }, { modules: [] });
  cleanup.push(ws);
  assert.deepEqual(readTouchstone(ws).links, links);
  assert.deepEqual(memberLinks(ws), links);
});

test("memberLinks keeps at most 20 members", () => {
  const ws = scopeWs(Array.from({ length: 25 }, (_, i) => `https://github.com/acme/r${i}`));
  assert.equal(memberLinks(ws).length, 20);
});

// ---- D: collision-free member paths ------------------------------------------

test("two members with the same repo name (org-a/common, org-b/common) land in separate folders", async () => {
  const ws = scopeWs(["https://github.com/org-a/common", "https://github.com/org-b/common"]);
  clones.set("https://github.com/org-a/common.git", { "src/Lib.sol": "contract A {}\n" });
  clones.set("https://github.com/org-b/common.git", { "src/Lib.sol": "contract B {}\n" });
  const a = await fetchSource(ws, "https://github.com/org-a/common");
  const b = await fetchSource(ws, "https://github.com/org-b/common");
  assert.notEqual(a.where, b.where);
  assert.equal(readFileSync(path.join(ws, "vendor/org-a__common/src/Lib.sol"), "utf8"), "contract A {}\n");
  assert.equal(readFileSync(path.join(ws, "vendor/org-b__common/src/Lib.sol"), "utf8"), "contract B {}\n");
});

test("blobs that share a file name land in separate files", async () => {
  const urls = ["https://github.com/org-a/common/blob/main/src/Token.sol", "https://github.com/org-a/common/blob/main/lib/Token.sol", "https://github.com/org-b/common/blob/main/src/Token.sol"];
  const ws = scopeWs(urls);
  urls.forEach((u, i) => blobs.set(u.replace("https://github.com/", "https://raw.githubusercontent.com/").replace("/blob/", "/"), `contract T${i} {}\n`));
  const wheres = [];
  for (const u of urls) wheres.push((await fetchSource(ws, u)).where);
  assert.equal(new Set(wheres).size, 3);
  wheres.forEach((w, i) => assert.equal(readFileSync(path.join(ws, w), "utf8"), `contract T${i} {}\n`));
});

test("memberDest refuses unsafe names and paths", () => {
  assert.throws(() => memberDest({ kind: "repo", owner: "..", repo: "x", ref: null }), /unsafe/);
  assert.throws(() => memberDest({ kind: "repo", owner: "a", repo: "x", ref: "../../etc" }), /unsafe/);
  assert.throws(() => memberDest({ kind: "blob", owner: "a", repo: "x", ref: "main", filePath: "../../etc/x.sol" }), /unsafe/);
});

// ---- E: caps and secret filtering on clones ----------------------------------

test("a clone over 200 source files is refused and removed", async () => {
  const ws = scopeWs(["https://github.com/org/big"]);
  clones.set("https://github.com/org/big.git", Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`src/C${i}.sol`, `contract C${i} {}\n`])));
  await assert.rejects(fetchSource(ws, "https://github.com/org/big"), /201 source files \(the cap is 200\)/);
  assert.ok(!existsSync(path.join(ws, "vendor/org__big")));
});

test("a clone over 2 MB of source is refused and removed", async () => {
  const ws = scopeWs(["https://github.com/org/fat"]);
  const big = "// " + "a".repeat(800 * 1024) + "\n";
  clones.set("https://github.com/org/fat.git", { "src/A.sol": big, "src/B.sol": big, "src/C.sol": big });
  await assert.rejects(fetchSource(ws, "https://github.com/org/fat"), /MB of source \(the cap is 2 MB\)/);
  assert.ok(!existsSync(path.join(ws, "vendor/org__fat")));
});

test("the caps count the whole scope: a second member that crosses them is refused, the first stays", async () => {
  const ws = scopeWs(["https://github.com/org/one", "https://github.com/org/two"]);
  const n = (k, p) => Object.fromEntries(Array.from({ length: k }, (_, i) => [`src/${p}${i}.sol`, `contract ${p}${i} {}\n`]));
  clones.set("https://github.com/org/one.git", n(150, "A"));
  clones.set("https://github.com/org/two.git", n(60, "B"));
  await fetchSource(ws, "https://github.com/org/one");
  await assert.rejects(fetchSource(ws, "https://github.com/org/two"), /210 source files/);
  assert.equal(walk(path.join(ws, "vendor")).length, 150);
});

test("a clone loses planted key files and secret-looking content, and keeps clean source", async () => {
  const ws = scopeWs(["https://github.com/org/leaky"]);
  clones.set("https://github.com/org/leaky.git", {
    "src/Vault.sol": "contract Vault {}\n",
    "keys/id_rsa": "-----BEGIN OPENSSH PRIVATE KEY-----\nxx\n-----END OPENSSH PRIVATE KEY-----\n",
    "src/Config.sol": "// -----BEGIN EC PRIVATE KEY-----\ncontract Config {}\n",
    "script/deploy.ts": `const token = "ghp_${"A".repeat(36)}";\n`,
    "script/aws.ts": `const k = "AKIA${"B".repeat(16)}";\n`,
    "src/Blob.sol": "contract X {}\u0000",
    ".env": "PRIVATE_KEY=0x1\n",
    "node_modules/x/index.js": "module.exports = 1;\n",
  });
  const r = await fetchSource(ws, "https://github.com/org/leaky");
  assert.deepEqual(walk(path.join(ws, "vendor/org__leaky")), ["src/Vault.sol"]);
  assert.ok(r.dropped >= 7);
  assert.match(r.note, /dropped/);
});

test("a blob with secret content, or a secret file name, is refused and not written", async () => {
  const ws = scopeWs(["https://github.com/org/x/blob/main/src/K.sol", "https://github.com/org/x/blob/main/.env"]);
  blobs.set("https://raw.githubusercontent.com/org/x/main/src/K.sol", "-----BEGIN RSA PRIVATE KEY-----\n");
  await assert.rejects(fetchSource(ws, "https://github.com/org/x/blob/main/src/K.sol"), /looks like a secret/);
  await assert.rejects(fetchSource(ws, "https://github.com/org/x/blob/main/.env"), /refused/);
  assert.ok(!existsSync(path.join(ws, "vendor/files")));
});

// ---- C: content routing, never the UI hint -----------------------------------

test("a repo-only scope added under Contracts keeps run_poc, submit_finding and prove closed until Solidity is fetched", async () => {
  const s = addScope({ title: "hinted", members: [{ kind: "repo", url: "https://github.com/acme/svc" }], pack: "contracts" });
  assert.equal(s.pack, "contracts"); // the hint breaks the tie: only a fetch can show what the repo holds
  const ws = prepareWorkspace(s, { modules: planModules(s) });
  cleanup.push(ws);
  const state = { poc: 0, passed: new Map(), found: [] };
  const tools = Object.fromEntries(contracts.tools(ws, state).map((t) => [t.name, t]));
  const closed = async () => {
    assert.equal(proofOpen(ws), false);
    const run = await tools.run_poc.execute({ test_source: "contract T {}", contract_name: "T" });
    assert.equal(run.isError, true);
    assert.match(run.output[0].text, /nothing can be proven/);
    assert.equal(state.poc, 0, "a closed run_poc spends no attempt");
    const sub = await tools.submit_finding.execute({ title: "t", severity: "critical", poc_contract: "T", explanation: "x" });
    assert.equal(sub.isError, true);
    const forged = [{ title: "x", severity: "critical", poc: "T", explanation: "x", source: "contract T {}" }];
    assert.deepEqual(await contracts.prove(ws, forged, [{ ev: "run_poc-done", passed: true, contract: "T" }], () => {}), []);
  };
  await closed();
  // The repo holds no Solidity: still closed.
  clones.set("https://github.com/acme/svc.git", { "main.go": "package main\n", "web/app.ts": "export {}\n" });
  await fetchSource(ws, "https://github.com/acme/svc");
  await closed();
  // It does hold Solidity: the proof surface opens.
  clones.set("https://github.com/acme/svc.git", { "src/V.sol": "contract V {}\n" });
  await fetchSource(ws, "https://github.com/acme/svc");
  assert.equal(proofOpen(ws), true);
});

test("the UI hint cannot make non-Solidity folder content Contracts; known Solidity is Contracts without a hint", () => {
  const go = { kind: "folder", name: "api", files: [{ path: "main.go", content: "package main\n" }] };
  assert.equal(addScope({ title: "go", members: [go], pack: "contracts" }).pack, "review");
  assert.equal(addScope({ title: "sol", members: [{ kind: "repo", url: "https://github.com/acme/v/blob/main/src/V.sol" }] }).pack, "contracts");
  assert.equal(addScope({ title: "plain", members: [{ kind: "repo", url: "https://github.com/acme/v" }] }).pack, "review");
});

// ---- F: a large repo is audited in parts (folder URLs) -----------------------

const many = (k, dir) => Object.fromEntries(Array.from({ length: k }, (_, i) => [`${dir}/f${i}.go`, `package p${i}\n`]));

test("a folder URL fetches only that folder, and the cap counts only that folder", async () => {
  const url = "https://github.com/cosmos/sdk/tree/main/x/bank";
  const ws = scopeWs([url]);
  clones.set("https://github.com/cosmos/sdk.git", { ...many(300, "x/staking"), ...many(5, "x/bank/keeper"), "go.mod": "module sdk\n" });
  const r = await fetchSource(ws, url);
  assert.equal(r.where, "vendor/cosmos__sdk@main/x/bank");
  assert.deepEqual(walk(path.join(ws, "vendor")), Array.from({ length: 5 }, (_, i) => `cosmos__sdk@main/x/bank/keeper/f${i}.go`).sort());
  assert.deepEqual(readdirSync(ws).filter((n) => n.startsWith(".fetch")), [], "the temporary clone is removed");
});

test("two folder members of one repo land side by side", async () => {
  const bank = "https://github.com/cosmos/sdk/tree/main/x/bank", auth = "https://github.com/cosmos/sdk/tree/main/x/auth";
  const ws = scopeWs([bank, auth]);
  clones.set("https://github.com/cosmos/sdk.git", { ...many(3, "x/bank"), ...many(4, "x/auth"), ...many(2, "x/gov") });
  await fetchSource(ws, bank);
  await fetchSource(ws, auth);
  assert.equal(walk(path.join(ws, "vendor")).length, 7, "only the two folders land");
  assert.equal(walk(path.join(ws, "vendor/cosmos__sdk@main/x/bank")).length, 3);
  assert.equal(walk(path.join(ws, "vendor/cosmos__sdk@main/x/auth")).length, 4);
});

test("a folder URL that names a missing folder, or a symlink, is refused and nothing is kept", async () => {
  const gone = "https://github.com/cosmos/sdk/tree/main/x/nope";
  const ws = scopeWs([gone]);
  clones.set("https://github.com/cosmos/sdk.git", many(3, "x/bank"));
  await assert.rejects(fetchSource(ws, gone), /x\/nope.*(not a folder|does not exist)/);
  assert.deepEqual(walk(path.join(ws, "vendor")), []);
  assert.deepEqual(readdirSync(ws).filter((n) => n.startsWith(".fetch")), []);
  const link = "https://github.com/cosmos/sdk/tree/main/x/link";
  const ws2 = scopeWs([link]);
  clones.set("https://github.com/cosmos/sdk.git", { ...many(3, "x/bank"), "x/link": { link: "bank" } });
  await assert.rejects(fetchSource(ws2, link), /x\/link.*not a folder/);
  assert.deepEqual(walk(path.join(ws2, "vendor")), []);
});

test("a scope still over the cap is refused with the file count, the cap, the largest folders, and what to do", async () => {
  const url = "https://github.com/cosmos/sdk";
  const ws = scopeWs([url]);
  clones.set("https://github.com/cosmos/sdk.git", { ...many(250, "x/staking"), ...many(40, "x/bank"), ...many(10, "types") });
  const err = await fetchSource(ws, url).then(() => null, (e) => e);
  assert.ok(err, "the fetch is refused");
  assert.match(err.message, /300 source files/);
  assert.match(err.message, /cap is 200/);
  assert.match(err.message, /x\/staking \(250\)/);
  assert.match(err.message, /https:\/\/github\.com\/cosmos\/sdk\/tree\/[\w.-]+\/x\/bank/);
  assert.ok(!existsSync(path.join(ws, "vendor/cosmos__sdk")));
});

test("fetchSource emits one source-fetch event for a fetch that lands and one for a refusal", async () => {
  const ok = "https://github.com/acme/vault", big = "https://github.com/org/big";
  const ws = scopeWs([ok, big]);
  clones.set("https://github.com/acme/vault.git", { "src/V.sol": "contract V {}\n" });
  clones.set("https://github.com/org/big.git", many(201, "src"));
  const file = path.join(ws, "..", `events-${path.basename(ws)}.jsonl`);
  cleanup.push(file);
  process.env.EVENTS_FILE = file;
  try {
    await fetchSource(ws, ok);
    await assert.rejects(fetchSource(ws, big));
  } finally { delete process.env.EVENTS_FILE; }
  const evs = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.ev === "source-fetch");
  assert.equal(evs.length, 2);
  assert.deepEqual([evs[0].url, evs[0].ok, evs[0].where, evs[0].files], [ok, true, "vendor/acme__vault", 1]);
  assert.deepEqual([evs[1].url, evs[1].ok], [big, false]);
  assert.match(evs[1].error, /201 source files/);
});

test("a refused refetch keeps what an earlier folder member already fetched", async () => {
  const folder = "https://github.com/cosmos/sdk/tree/main/x/bank";
  const whole = "https://github.com/cosmos/sdk/tree/main";
  const ws = scopeWs([folder, whole]);
  clones.set("https://github.com/cosmos/sdk.git", { ...many(250, "x/staking"), ...many(4, "x/bank") });
  await fetchSource(ws, folder);
  await assert.rejects(fetchSource(ws, whole), /254 source files/);
  assert.deepEqual(walk(path.join(ws, "vendor")), Object.keys(many(4, "cosmos__sdk@main/x/bank")).sort());
  assert.deepEqual(readdirSync(ws).filter((n) => n.startsWith(".fetch")), []);
});

test("a refused folder member leaves no empty parent folders, but keeps a sibling member", async () => {
  const deep = "https://github.com/o/r/tree/main/a/b";
  const ws = scopeWs([deep]);
  clones.set("https://github.com/o/r.git", many(250, "a/b"));
  await assert.rejects(fetchSource(ws, deep), /250 source files/);
  assert.deepEqual(readdirSync(path.join(ws, "vendor")), [], "no empty o__r@main/a/ is left");
  const keep = "https://github.com/o/r/tree/main/a/c";
  const ws2 = scopeWs([keep, deep]);
  clones.set("https://github.com/o/r.git", { ...many(250, "a/b"), ...many(2, "a/c") });
  await fetchSource(ws2, keep);
  await assert.rejects(fetchSource(ws2, deep), /252 source files/);
  assert.deepEqual(walk(path.join(ws2, "vendor")), Object.keys(many(2, "o__r@main/a/c")).sort());
});
