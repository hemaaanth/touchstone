// Live path: read an authorized GitHub repo (or an org's repos) through the
// read-only GitHub API into the same pinned snapshot the offline scanners read.
//
// READ ONLY. Each step is one HTTPS GET (lib/fetch.mjs githubGet): the repo
// record, the commit SHA of the ref, the recursive tree at that commit, and the
// blob bytes. Nothing is cloned, installed, built or run. The scanners then run
// offline in Docker on the pinned bytes, like every other snapshot.
//
// SCOPE. A capture needs a grant: `reach.granted === true` and `reach.scope`
// naming `owner/repo` or the whole `owner`. The platform writes `reach` from the
// operator's live scope (targets.mjs). An org is expanded only when the scope
// names the org itself.
//
// TOKEN. Optional. process.env.GITHUB_TOKEN lifts the rate limit and opens
// private repos the token can read. It is passed only to githubGet as a header.
// It is never logged, returned, written to the snapshot, or given to a tool.
//
// INTEGRITY. Every blob is checked against its Git object ID from the tree
// (sha1 of "blob <len>\0<bytes>"). The snapshot pins the commit, so a replay
// reads exactly the committed bytes, like a local Git scan.
import { isUtf8 } from "node:buffer";
import { readFileSync } from "node:fs";
import { githubGet } from "../../lib/fetch.mjs";
import { loadSnapshot, pinSnapshot } from "../../lib/proof-evidence.mjs";
import { LIMITS, blobOid, fileCap } from "./snapshot.mjs";
import { githubTarget, githubScopeKey as scopeKey, GITHUB_REPO as REPO, GITHUB_REF as REF } from "../../lib/scopes-store.mjs";

export { githubTarget };

// Network caps on top of the snapshot's own byte caps (LIMITS).
export const GITHUB_LIMITS = { files: 400, repos: 10, totalMs: 120_000, concurrency: 6, treeBytes: 16 * 1024 * 1024 };

const RESERVED = /(^|\/)(?:\.scanner-(?:db|rules)\/|\.scanner-sbom\.json$|\.semgrepignore$|\.touchstone\.json$)/;
// Extensions that are never text. Skipped before any byte is fetched.
const BINARY_EXT = /\.(?:png|jpe?g|gif|webp|ico|bmp|tiff?|svgz|pdf|zip|gz|tgz|bz2|xz|7z|rar|tar|jar|war|class|so|dylib|dll|exe|bin|o|a|wasm|woff2?|ttf|otf|eot|mp[34]|mov|avi|webm|ogg|wav|flac|psd|sqlite|db|pyc|node)$/i;

// Files the supply-chain checks lean on most. They are fetched first.
const WORKFLOW = /^(?:.*\/)?(?:\.github\/workflows\/[^/]+\.ya?ml|action\.ya?ml|\.github\/dependabot\.ya?ml)$/;
const MANIFEST = /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock|requirements[\w.-]*\.txt|Pipfile(?:\.lock)?|poetry\.lock|pyproject\.toml|uv\.lock|setup\.(?:py|cfg)|go\.(?:mod|sum)|Cargo\.(?:toml|lock)|Gemfile(?:\.lock)?|composer\.(?:json|lock)|pom\.xml|build\.gradle(?:\.kts)?|gradle\.lockfile|packages\.lock\.json|foundry\.toml|remappings\.txt|hardhat\.config\.[cm]?[jt]s)$/;
const inNodeModules = (f) => /(^|\/)node_modules\//.test(f);
const priority = (f) => (inNodeModules(f) ? 3 : WORKFLOW.test(f) ? 0 : MANIFEST.test(f) ? 1 : 2);

export const inGithubScope = (owner, repo, scope) => {
  const keys = (scope ?? []).map((s) => String(s).toLowerCase());
  return keys.includes(owner.toLowerCase()) || (repo !== null && keys.includes(`${owner}/${repo}`.toLowerCase()));
};

// Refuse a capture with no grant, or for a target the grant does not name.
export function assertGithubReach(reach, targets) {
  if (!reach || reach.granted !== true || !Array.isArray(reach.scope)) throw new Error("A GitHub capture needs an operator grant (reach.granted and reach.scope).");
  if (!Array.isArray(targets) || !targets.length) throw new Error("A GitHub capture needs at least one repo or org.");
  for (const t of targets) if (!inGithubScope(t.owner, t.repo, reach.scope)) throw new Error(`${scopeKey(t)} is not in the granted scope`);
}

const api = (path) => `https://api.github.com${path}`;
const enc = (p) => p.split("/").map(encodeURIComponent).join("/");

function explain(err, what, token) {
  if (err.rateLimited) return new Error(`GitHub rate limit hit while reading ${what}${token ? "" : ". With no token the limit is 60 API requests an hour. Set GITHUB_TOKEN"}.`);
  if (err.status === 404) return new Error(`${what} was not found${token ? " or the token cannot read it" : ". A private repo needs GITHUB_TOKEN"}.`);
  if (err.status === 401) return new Error(`GitHub refused the token while reading ${what} (401).`);
  return new Error(`could not read ${what}: ${err.message}`);
}

// The repos an org (or user) entry expands to. First page only, newest push
// first, no forks, no archived repos, at most GITHUB_LIMITS.repos.
async function orgRepos(owner, { get, token }) {
  const json = async (path) => JSON.parse((await get(api(path), { token })).buf.toString("utf8"));
  let list;
  try { list = await json(`/orgs/${owner}/repos?per_page=100&sort=pushed&type=${token ? "all" : "public"}`); }
  catch (err) {
    if (err.status !== 404) throw explain(err, `the repos of ${owner}`, token);
    try { list = await json(`/users/${owner}/repos?per_page=100&sort=pushed`); } catch (e) { throw explain(e, `the repos of ${owner}`, token); }
  }
  const usable = list.filter((r) => !r.fork && !r.archived && r.owner?.login?.toLowerCase() === owner.toLowerCase() && REPO.test(r.name ?? ""));
  return { repos: usable.slice(0, GITHUB_LIMITS.repos).map((r) => ({ owner, repo: r.name, ref: null })), dropped: Math.max(0, usable.length - GITHUB_LIMITS.repos), listed: list.length };
}

// The commit and the full file list of one repo at one ref.
async function repoTree(t, { get, token }) {
  const what = `${t.owner}/${t.repo}`;
  const read = async (path, accept) => {
    try { return await get(api(path), { token, accept, cap: GITHUB_LIMITS.treeBytes }); }
    catch (err) { throw explain(err, what, token); }
  };
  const meta = JSON.parse((await read(`/repos/${t.owner}/${t.repo}`)).buf.toString("utf8"));
  const ref = t.ref ?? meta.default_branch;
  if (!ref || !REF.test(ref)) throw new Error(`${what} has no usable default branch`);
  const sha = (await read(`/repos/${t.owner}/${t.repo}/commits/${enc(ref)}`, "application/vnd.github.sha")).buf.toString("utf8").trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error(`${what}@${ref} did not resolve to a commit`);
  const tree = JSON.parse((await read(`/repos/${t.owner}/${t.repo}/git/trees/${sha}?recursive=1`)).buf.toString("utf8"));
  return { repo: what, ref, commit: sha, private: meta.private === true, truncated: tree.truncated === true, entries: tree.tree ?? [] };
}

// Run `fn` over `items` with at most `n` in flight.
async function pool(items, n, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

// Capture authorized GitHub targets into a snapshot.
//   targets: [{ owner, repo|null, ref|null }]   (from githubTarget)
//   reach:   { granted: true, scope: ["owner/repo" | "owner"] }
//   token:   optional read-only token (process.env.GITHUB_TOKEN by default)
//   get:     the reader (githubGet). Tests pass a recorder replay.
// One repo keeps its own paths. Several repos are each under "<owner>/<repo>/".
export async function captureGithub(targets, { reach, token = process.env.GITHUB_TOKEN || null, get = githubGet, now = Date.now } = {}) {
  assertGithubReach(reach, targets);
  const started = now();
  const overTime = () => now() - started > GITHUB_LIMITS.totalMs;
  const gaps = [];
  const repos = [];
  for (const t of targets) {
    if (t.repo) { repos.push(t); continue; }
    const org = await orgRepos(t.owner, { get, token });
    if (org.dropped) gaps.push({ kind: "github-org-repos-capped", detail: `${t.owner} has ${org.dropped} more repos than the cap of ${GITHUB_LIMITS.repos}. They were not read.` });
    if (org.listed >= 100) gaps.push({ kind: "github-org-first-page-only", detail: `${t.owner} lists 100 or more repos. Only the first page (newest push first) was read.` });
    repos.push(...org.repos);
  }
  const seen = new Set();
  const unique = repos.filter((r) => !seen.has(scopeKey(r)) && seen.add(scopeKey(r)));
  if (!unique.length) throw new Error("No repos to read in the granted GitHub scope.");
  if (unique.length > GITHUB_LIMITS.repos) throw new Error(`At most ${GITHUB_LIMITS.repos} repos per capture.`);
  const prefixed = unique.length > 1;
  const trees = [];
  for (const r of unique) {
    if (overTime()) throw new Error(`GitHub capture passed its ${GITHUB_LIMITS.totalMs / 1000}s time cap.`);
    trees.push(await repoTree(r, { get, token }));
  }

  // Plan every file before fetching any: skip by mode, name, extension and size
  // from the tree, then keep the highest-priority files inside the caps.
  const skipped = [], plan = [];
  for (const tr of trees) {
    if (tr.truncated) gaps.push({ kind: "github-tree-truncated", detail: `GitHub truncated the file list of ${tr.repo}. Files past the cut were not seen.` });
    for (const e of tr.entries) {
      if (e.type === "tree") continue;
      const file = prefixed ? `${tr.repo}/${e.path}` : e.path;
      const skip = (reason) => skipped.push({ file, reason });
      if (e.type === "commit") { skip("submodule"); continue; }
      if (e.type !== "blob" || !["100644", "100755"].includes(e.mode)) { skip("not-a-regular-file"); continue; }
      if (RESERVED.test(e.path) || e.path.split("/").some((s) => s === ".." || s === ".git")) { skip("reserved-name"); continue; }
      if (BINARY_EXT.test(e.path)) { skip("binary-or-not-utf8"); continue; }
      if (!Number.isInteger(e.size) || e.size > fileCap(e.path)) { skip("too-large"); continue; }
      if (!/^[a-f0-9]{40}$/.test(e.sha ?? "")) { skip("unreadable"); continue; }
      plan.push({ file, path: e.path, sha: e.sha, size: e.size, tree: tr });
    }
  }
  plan.sort((a, b) => priority(a.file) - priority(b.file) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  let bytes = 0;
  const fetchList = [];
  for (const p of plan) {
    if (fetchList.length >= GITHUB_LIMITS.files || bytes + p.size > LIMITS.totalBytes) { skipped.push({ file: p.file, reason: "over-budget" }); continue; }
    bytes += p.size;
    fetchList.push(p);
  }
  if (fetchList.length < plan.length) gaps.push({ kind: "github-fetch-capped", detail: `${plan.length - fetchList.length} text files were over the ${GITHUB_LIMITS.files}-file or ${LIMITS.totalBytes / 1024 / 1024} MiB cap and were not read. Workflows and manifests are read first.` });

  // Fetch. With a token, the API blob endpoint (works for private repos). With
  // no token, raw.githubusercontent.com at the pinned commit (no API quota).
  const got = new Map();
  await pool(fetchList, GITHUB_LIMITS.concurrency, async (p) => {
    if (overTime()) throw new Error(`GitHub capture passed its ${GITHUB_LIMITS.totalMs / 1000}s time cap.`);
    const [owner, repo] = p.tree.repo.split("/");
    const url = token ? api(`/repos/${owner}/${repo}/git/blobs/${p.sha}`) : `https://raw.githubusercontent.com/${owner}/${repo}/${p.tree.commit}/${enc(p.path)}`;
    let raw;
    try { raw = (await get(url, { token, accept: "application/vnd.github.raw", cap: fileCap(p.path) })).buf; }
    catch (err) { throw explain(err, `${p.tree.repo}:${p.path}`, token); }
    // A blob that does not match its tree OID is not the committed file.
    if (blobOid(raw) !== p.sha) throw new Error(`${p.tree.repo}:${p.path} does not match its Git object ID. Refusing the capture.`);
    got.set(p.file, raw);
  });
  const files = Object.create(null);
  for (const p of fetchList) {
    const raw = got.get(p.file);
    if (raw.includes(0) || !isUtf8(raw)) { skipped.push({ file: p.file, reason: "binary-or-not-utf8" }); continue; }
    files[p.file] = raw.toString("utf8");
  }
  if (!Object.keys(files).length) throw new Error("Target has no scannable text files");
  const commits = Object.fromEntries(trees.map((t) => [t.repo, t.commit]));
  return {
    version: 1,
    scope: "github-commit",
    ...(trees.length === 1 ? { commit: trees[0].commit } : {}),
    github: { repos: trees.map((t) => ({ repo: t.repo, ref: t.ref, commit: t.commit, private: t.private, truncated: t.truncated })), commits, authenticated: Boolean(token) },
    gaps,
    files,
    skipped,
    npmAdvisories: readFileSync(new URL("./advisories/osv-scalibr/npm/all.zip", import.meta.url)).toString("base64"),
  };
}

// Load the pin, or capture the granted GitHub targets and pin them. A replay
// never refetches: it reads the pinned snapshot only.
export async function prepareGithubSnapshot(ws, entries, { reach, signingPolicy, ...opts } = {}) {
  try { return loadSnapshot(ws); }
  catch (err) { if (err.code !== "ENOENT" && !String(err.message).includes("Missing snapshot SHA-256 pin")) throw err; }
  const list = (Array.isArray(entries) ? entries : [entries]).map(githubTarget);
  const snapshot = { ...await captureGithub(list, { reach, ...opts }), ...(signingPolicy ? { signingPolicy } : {}) };
  return { snapshot, snapshotHash: pinSnapshot(ws, snapshot) };
}
