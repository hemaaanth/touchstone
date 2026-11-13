// Supply-chain live path: read a GitHub repo through the read-only API.
//
// The fixture is a real no-token capture of octokit/request-error.js, recorded
// from api.github.com and raw.githubusercontent.com. Tests replay it by URL, so
// no test sends a network request. An unrecorded URL is a 404.
import "./helpers/isolated-env.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "sc-github-test-"));
process.env.TOUCHSTONE_SCOPES_FILE = path.join(dir, "scopes.json");
process.env.TOUCHSTONE_GRANTS_FILE = path.join(dir, "grants.json");
after(() => rmSync(dir, { recursive: true, force: true }));

const { captureGithub, prepareGithubSnapshot, githubTarget, assertGithubReach, GITHUB_LIMITS } = await import("../packs/supply-chain/github.mjs");
const { githubGet } = await import("../lib/fetch.mjs");
const { addLiveScope, removeScope } = await import("../lib/scopes-store.mjs");
const { readGrants } = await import("../lib/grant-store.mjs");
const { enforceReach } = await import("../lib/reach.mjs");
const { listTargets, prepareWorkspace, getTarget, scopeEnv } = await import("../lib/targets.mjs");
const { cryptoLeads } = await import("../packs/supply-chain/crypto.mjs");
const { scanSnapshot } = await import("../packs/supply-chain/scanners.mjs");
const pack = (await import("../packs/supply-chain/pack.mjs")).default;
const { replayEvidence } = await import("../lib/proof-evidence.mjs");
const { cryptoDetectors } = await import("../packs/supply-chain/crypto.mjs");
const { scannerDetectors } = await import("../packs/supply-chain/scanners.mjs");

const fx = JSON.parse(readFileSync(new URL("./fixtures/github-octokit-request-error.json", import.meta.url), "utf8"));
const REPO = "octokit/request-error.js";
const COMMIT = fx.commit;
const body = (r) => (r.text !== undefined ? Buffer.from(r.text, "utf8") : Buffer.from(r.base64, "base64"));
const reach = { granted: true, scope: [REPO] };
const ws = () => mkdtempSync(path.join(dir, "ws-"));

// Serve recorded responses. `edit` can change one body for a tamper test.
function replay({ log = [], edit = {} } = {}) {
  return async (url, opts = {}) => {
    log.push({ url, token: opts.token ?? null });
    const r = fx.responses[url];
    if (!r) throw Object.assign(new Error(`HTTP 404 from ${url}`), { status: 404 });
    return { status: r.status, buf: edit[url] ? edit[url](body(r)) : body(r) };
  };
}
const treeUrl = Object.keys(fx.responses).find((u) => u.includes("/git/trees/"));
const tree = JSON.parse(fx.responses[treeUrl].text).tree;

test("the fixture is a real capture pinned to one commit", () => {
  assert.match(COMMIT, /^[a-f0-9]{40}$/);
  assert.ok(treeUrl.endsWith(`/git/trees/${COMMIT}?recursive=1`));
  assert.ok(Object.keys(fx.responses).every((u) => u.startsWith("https://api.github.com/") || u.startsWith("https://raw.githubusercontent.com/")));
  // Only status and body are recorded, never request or response headers.
  assert.ok(Object.values(fx.responses).every((r) => Object.keys(r).every((k) => ["status", "text", "base64"].includes(k))));
  assert.ok(!JSON.stringify(fx).match(/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/), "the fixture holds no token");
});

test("a target is a github.com repo, org or ref; anything else is refused", () => {
  assert.deepEqual(githubTarget("https://github.com/octokit/request-error.js"), { owner: "octokit", repo: "request-error.js", ref: null });
  assert.deepEqual(githubTarget("https://github.com/octokit/request-error.js/tree/release/v6"), { owner: "octokit", repo: "request-error.js", ref: "release/v6" });
  assert.deepEqual(githubTarget("octokit/request-error.js@v6.1.0"), { owner: "octokit", repo: "request-error.js", ref: "v6.1.0" });
  assert.deepEqual(githubTarget("https://github.com/octokit"), { owner: "octokit", repo: null, ref: null });
  assert.deepEqual(githubTarget("octokit/x.git".replace(".git", "")), { owner: "octokit", repo: "x", ref: null });
  for (const bad of ["http://github.com/a/b", "https://gitlab.com/a/b", "https://user:pw@github.com/a/b", "https://github.com:8443/a/b", "https://github.com/a/b/blob/main/x", "a/b/c", "a/..", "a/b@../x", "a@main", "-bad/x", ""]) {
    assert.throws(() => githubTarget(bad), undefined, bad);
  }
});

test("no capture without a grant that names the repo or its owner", async () => {
  const t = githubTarget(REPO);
  const log = [];
  for (const r of [undefined, {}, { granted: "yes", scope: [REPO] }, { granted: true }, { granted: true, scope: ["octokit/other"] }, { granted: true, scope: ["octok"] }]) {
    await assert.rejects(() => captureGithub([t], { reach: r, token: null, get: replay({ log }) }), /grant|not in the granted scope/);
  }
  assert.equal(log.length, 0, "a refused capture sends no request");
  // The owner's name covers its repos. Case does not matter.
  assert.doesNotThrow(() => assertGithubReach({ granted: true, scope: ["Octokit"] }, [t]));
  // An org entry needs the org itself in scope, not just one of its repos.
  assert.throws(() => assertGithubReach(reach, [githubTarget("octokit")]), /not in the granted scope/);
});

test("no token: public read at the pinned commit, blobs verified, same snapshot shape as a git scan", async () => {
  const log = [];
  const snap = await captureGithub([githubTarget(REPO)], { reach, token: null, get: replay({ log }) });
  assert.equal(snap.scope, "github-commit");
  assert.equal(snap.commit, COMMIT);
  assert.equal(snap.github.authenticated, false);
  assert.deepEqual(snap.github.repos, [{ repo: REPO, ref: "main", commit: COMMIT, private: false, truncated: false }]);
  assert.deepEqual(snap.gaps, []);
  // Workflows, manifest and lockfile are all read, as committed bytes.
  for (const f of [".github/workflows/test.yml", ".github/workflows/release.yml", "package.json", "package-lock.json"]) assert.ok(snap.files[f], f);
  assert.equal(Object.keys(snap.files).length + snap.skipped.length, tree.filter((e) => e.type !== "tree").length);
  // Only the three API reads go to api.github.com. File bytes come from raw at the commit.
  const api = log.filter((l) => l.url.startsWith("https://api.github.com/"));
  assert.equal(api.length, 3);
  assert.ok(log.filter((l) => l.url.startsWith("https://raw.githubusercontent.com/")).every((l) => l.url.startsWith(`https://raw.githubusercontent.com/${REPO}/${COMMIT}/`)));
  assert.ok(log.every((l) => l.token === null));
  assert.ok(snap.npmAdvisories.length > 0, "the offline advisory slice rides in the snapshot");
});

test("a blob that does not match its Git object ID is refused, not scanned", async () => {
  const url = `https://raw.githubusercontent.com/${REPO}/${COMMIT}/package.json`;
  const edit = { [url]: (b) => Buffer.concat([b, Buffer.from("\n")]) };
  await assert.rejects(() => captureGithub([githubTarget(REPO)], { reach, token: null, get: replay({ edit }) }), /does not match its Git object ID/);
});

test("a truncated tree and a capped fetch are coverage gaps", async () => {
  const edit = { [treeUrl]: (b) => Buffer.from(JSON.stringify({ ...JSON.parse(b), truncated: true })) };
  const old = GITHUB_LIMITS.files;
  GITHUB_LIMITS.files = 10;
  try {
    const snap = await captureGithub([githubTarget(REPO)], { reach, token: null, get: replay({ edit }) });
    assert.deepEqual(snap.gaps.map((g) => g.kind).sort(), ["github-fetch-capped", "github-tree-truncated"]);
    assert.equal(Object.keys(snap.files).length, 10);
    // Workflows and manifests are read before other files.
    assert.ok(snap.files[".github/workflows/test.yml"] && snap.files["package-lock.json"]);
    assert.ok(snap.skipped.some((s) => s.reason === "over-budget"));
  } finally { GITHUB_LIMITS.files = old; }
});

test("with a token: blobs come from the API, the token is only a header and is never stored", async () => {
  const token = "test-token-not-real-0123456789";
  const raw = new Map(tree.filter((e) => e.type === "blob").map((e) => [e.sha, fx.responses[`https://raw.githubusercontent.com/${REPO}/${COMMIT}/${e.path.split("/").map(encodeURIComponent).join("/")}`]]));
  const log = [];
  const get = async (url, opts = {}) => {
    log.push({ url, token: opts.token ?? null, accept: opts.accept });
    const blob = url.match(/^https:\/\/api\.github\.com\/repos\/octokit\/request-error\.js\/git\/blobs\/([a-f0-9]{40})$/);
    const r = blob ? raw.get(blob[1]) : fx.responses[url];
    if (!r) throw Object.assign(new Error(`HTTP 404 from ${url}`), { status: 404 });
    return { status: r.status, buf: body(r) };
  };
  const w = ws();
  const { snapshot } = await prepareGithubSnapshot(w, [REPO], { reach, token, get });
  assert.equal(snapshot.github.authenticated, true);
  assert.ok(log.every((l) => l.url.startsWith("https://api.github.com/") && l.token === token));
  assert.ok(log.filter((l) => l.url.includes("/git/blobs/")).every((l) => l.accept === "application/vnd.github.raw"));
  for (const f of readdirSync(w)) assert.ok(!readFileSync(path.join(w, f), "utf8").includes(token), `${f} must not hold the token`);
  // A second call loads the pin and sends nothing.
  const again = await prepareGithubSnapshot(w, [REPO], { reach, token, get: () => assert.fail("a pinned snapshot never refetches") });
  assert.equal(again.snapshot.commit, COMMIT);
});

test("rate limits and private repos fail with a plain reason, never as a clean scan", async () => {
  const fail = (status, extra = {}) => async () => { throw Object.assign(new Error(`HTTP ${status}`), { status, ...extra }); };
  await assert.rejects(() => captureGithub([githubTarget(REPO)], { reach, token: null, get: fail(403, { rateLimited: true }) }), /rate limit.*60 API requests an hour.*GITHUB_TOKEN/);
  await assert.rejects(() => captureGithub([githubTarget(REPO)], { reach, token: null, get: fail(404) }), /not found. A private repo needs GITHUB_TOKEN/);
  await assert.rejects(() => captureGithub([githubTarget(REPO)], { reach, token: "t", get: fail(401) }), /refused the token/);
});

test("githubGet reads only the two GitHub hosts, with no credentials in the URL", async () => {
  for (const u of ["https://github.com/a/b", "https://example.com/x", "https://api.github.com.evil.test/x", "https://u:p@api.github.com/x", "https://api.github.com:444/x", "http://api.github.com/x"]) {
    await assert.rejects(() => githubGet(u), /refused|https/i, u);
  }
});

test("the captured repo runs the pack's own checks and every lead replays from the pin", async () => {
  const w = ws();
  await prepareGithubSnapshot(w, [REPO], { reach, token: null, get: replay() });
  writeFileSync(path.join(w, ".touchstone.json"), JSON.stringify({ ...JSON.parse(readFileSync(path.join(w, ".touchstone.json"), "utf8")), pack: "supply-chain", kind: "live", github: [REPO], reach }));
  const { record } = await pack.prepass(w, {});
  assert.equal(record.scope, "github-commit");
  assert.equal(record.commit, COMMIT);
  assert.equal(record.github.repos[0].repo, REPO);
  const status = Object.fromEntries(record.coverage.map((c) => [c.engine, c.status]));
  for (const engine of ["zizmor", "poutine", "gitleaks", "trufflehog", "semgrep", "osv"]) assert.equal(status[engine], "ok", engine);
  assert.ok(["ok", "gap"].includes(status.grype), "grype is ok, or a gap when its database is missing");
  assert.ok(record.leads.some((l) => l.engine === "zizmor" && l.file.startsWith(".github/workflows/")));
  assert.ok(record.leads.some((l) => l.engine === "poutine"));
  const detectors = { ...cryptoDetectors, ...scannerDetectors() };
  for (const l of record.leads) assert.equal((await replayEvidence(w, l.evidence, { detectors })).status, "pass", `${l.check} ${l.file}`);
  // The offline Touchstone checks see the same files a local scan would.
  assert.deepEqual(cryptoLeads({ files: (await prepareGithubSnapshot(w, [REPO], { reach })).snapshot.files }).map((l) => l.check).sort(), record.leads.filter((l) => l.engine === "Touchstone").map((l) => l.check).sort());
});

test("poutine runs once per repo when a capture holds several repos", async () => {
  const snap = await captureGithub([githubTarget(REPO)], { reach, token: null, get: replay() });
  const files = {};
  for (const root of [REPO, "copy/request-error.js"]) for (const [f, t] of Object.entries(snap.files)) files[`${root}/${f}`] = t;
  const flat = await scanSnapshot(snap, "poutine");
  const two = await scanSnapshot({ ...snap, files, github: { repos: [{ repo: REPO }, { repo: "copy/request-error.js" }] } }, "poutine");
  assert.equal(two.status, "ok");
  assert.equal(two.leads.length, flat.leads.length * 2);
  assert.ok(flat.leads.length > 0);
});

test("a supply-chain live scope grants only the GitHub API hosts and binds the repos to the run", () => {
  assert.throws(() => addLiveScope({ hosts: [`https://github.com/${REPO}`], pack: "supply-chain" }), /permission/);
  assert.throws(() => addLiveScope({ hosts: ["https://gitlab.com/a/b"], pack: "supply-chain", permission: true }), /github\.com/);
  assert.equal(readGrants().length, 0);
  const scope = addLiveScope({ hosts: [`https://github.com/${REPO}`, "octokit/core.js@main"], pack: "supply-chain", permission: true });
  try {
    assert.deepEqual(scope.github, [REPO, "octokit/core.js@main"]);
    assert.deepEqual(scope.hosts, ["api.github.com", "raw.githubusercontent.com"]);
    const [grant] = readGrants();
    assert.deepEqual(grant.hosts, ["api.github.com", "raw.githubusercontent.com"]);
    assert.match(grant.note, /octokit\/request-error\.js, octokit\/core\.js@main/);
    // The reach gate passes because the operator's tick made the grant.
    assert.deepEqual(enforceReach(getTarget(scope.id)).hosts.sort(), ["api.github.com", "raw.githubusercontent.com"]);
    assert.equal(listTargets().find((t) => t.id === scope.id).runnable, true, "the pack sets live: true");
    const w = prepareWorkspace(getTarget(scope.id));
    const cfg = JSON.parse(readFileSync(path.join(w, ".touchstone.json"), "utf8"));
    assert.deepEqual(cfg.github, [REPO, "octokit/core.js@main"]);
    assert.deepEqual(cfg.reach.scope, [REPO, "octokit/core.js"]);
    assert.equal(cfg.reach.granted, true);
    assert.match(scopeEnv(getTarget(scope.id)).SCOPE_NOTES, /octokit\/request-error\.js/);
    rmSync(w, { recursive: true, force: true });
  } finally { removeScope(scope.id); }
  assert.equal(readGrants().length, 0, "removing the scope removes its grant");
});
