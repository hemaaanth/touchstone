// Operator-configured scopes — the assets the operator adds themselves, as
// opposed to the labs that ship built into targets.mjs. The main shape is a
// "scope" with members: GitHub repos and local folders, mixed, in any language
// (see addScope). Older records are a "brief" (pasted markdown with links) or a
// "local-source" folder; they still run. Repos are fetched host-side into a
// throwaway workspace at run time (the sandbox has no network). Findings are
// proven offline only — never a live chain, never real funds — and only when a
// replay fits the code.
//
// WHERE IT LIVES. A single JSON file under spike/data/, which is gitignored:
// these point at the operator's own machine and work, not our source. The file
// is the whole store; we read and rewrite it in full on each change. There is
// one long-lived Node process (the Vite dev server), so there is no concurrent
// writer to coordinate with.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(HERE, "../data");
// TOUCHSTONE_SCOPES_FILE exists only so tests use a throwaway store. Read on
// each call, so a test can set it after import.
const scopesFile = () => process.env.TOUCHSTONE_SCOPES_FILE || path.join(DATA_DIR, "scopes.json");

// The one proof surface a brief run is allowed: an isolated, offline Foundry
// workspace. Mirrors targets.mjs SANDBOX_FOUNDRY so a brief can never be proven
// anywhere that touches live funds.
const SANDBOX_FOUNDRY = {
  kind: "sandbox-foundry",
  note: "Proven in an isolated, offline, per-run Foundry workspace — no live chain and no real funds.",
};

// Read the whole store. Missing file or unparsable JSON yields an empty list, so
// a hand-edited or absent file degrades to "no user scopes" instead of throwing.
export function readScopes() {
  try {
    const raw = readFileSync(scopesFile(), "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeScopes(arr) {
  mkdirSync(path.dirname(scopesFile()), { recursive: true });
  writeFileSync(scopesFile(), JSON.stringify(arr, null, 2));
}

// A short url-safe slug from a title, for a readable scope id. Falls back to
// "brief" when the title has no usable characters.
export function slugify(title) {
  const s = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return s || "brief";
}

// Pull the links out of a markdown brief. We take both bare https URLs and the
// targets of []( ) markdown links, dedup, and keep order. These are the sources
// the engine will fetch at run time; they are extracted once here so the summary
// and the UI can show what a run will pull before it starts. http (non-TLS) is
// intentionally dropped — fetch.mjs refuses it anyway.
export function extractLinks(md) {
  const text = String(md || "");
  const out = [];
  const seen = new Set();
  const push = (u) => {
    const url = u.replace(/[)>\].,;'"]+$/, ""); // trim trailing punctuation
    if (/^https:\/\/\S+$/i.test(url) && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  };
  // Markdown link targets first, then any remaining bare URLs.
  for (const m of text.matchAll(/\]\(\s*(https:\/\/[^)\s]+)/gi)) push(m[1]);
  for (const m of text.matchAll(/https:\/\/[^\s)<>"']+/gi)) push(m[0]);
  return out;
}

// Add a brief scope. `title` and `brief` (the markdown) are required; `blurb` is
// an optional one-liner for the list. Returns the stored scope. The links are
// derived from the markdown, never passed in, so what we fetch always matches
// what the operator actually wrote.
export function addBriefScope({ title, brief, blurb } = {}) {
  const t = String(title || "").trim();
  const body = String(brief || "").trim();
  if (!t) throw new Error("a brief needs a title");
  if (!body) throw new Error("a brief needs some markdown");
  const links = extractLinks(body);
  const scope = {
    id: `brief-${slugify(t)}-${randomUUID().slice(0, 8)}`,
    kind: "brief",
    title: t,
    blurb: String(blurb || "").trim() || (links.length ? `Brief with ${links.length} linked source${links.length === 1 ? "" : "s"}.` : "Pasted brief."),
    entry: "BRIEF.md",
    signal: "agent",
    brief: body,
    links,
    proofSurface: SANDBOX_FOUNDRY,
    createdAt: Date.now(),
  };
  const all = readScopes();
  all.unshift(scope);
  writeScopes(all);
  return scope;
}

// ---- Scopes with members ---------------------------------------------------
//
// A scope is one unit of code tested together. It holds one or more members.
// A member is a GitHub repo or a local folder. Members mix freely, in any
// language:
//
//   { kind: "repo",   url }                                  fetched at run time
//   { kind: "folder", name, files: [{ path, content }] }     stored here
//
// The scope's pack comes from its content (see scopePack). A scope never gets a
// proof that does not fit its code: Solidity is proven by the offline Foundry
// replay, and code with no fitting replay oracle runs under the read-only
// "review" pack, which cannot prove anything.

// Limits for one scope, across all of its folders. Totals, so each file is also
// under them.
export const MAX_FILES = 200;
export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_MEMBERS = 20;

// Folders that hold dependencies or build output, not the code under test.
// Their files are dropped, never stored. Hidden folders (.git, .next, .venv)
// are refused before this, as hidden paths.
export const SKIP_DIRS = new Set([
  "node_modules", "out", "cache", "broadcast", "artifacts", "build", "dist",
  "target", "coverage", "venv", "__pycache__", "bower_components", "vendor",
]);
// Foundry keeps its dependencies in lib/. In other languages lib/ is often the
// source itself (Ruby, Elixir), so a top-level lib/ is skipped only in a
// Solidity folder.
const SOLIDITY_DEP_DIR = "lib";

// Source and config text we accept, by extension. Anything else (images,
// archives, binaries, databases) is dropped.
const SOURCE_EXT = new Set([
  // contracts
  "sol", "vy", "move", "cairo", "fe", "huff", "yul",
  // systems and app languages
  "rs", "go", "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "py", "rb", "java", "kt", "kts",
  "swift", "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "cs", "fs", "php", "scala", "ex", "exs", "erl",
  "hs", "ml", "mli", "zig", "nim", "lua", "dart", "clj", "r", "jl", "sh", "bash", "zsh", "ps1", "sql",
  // web
  "html", "htm", "css", "scss", "sass", "less", "vue", "svelte", "astro", "graphql", "gql",
  // data, config, docs, locks
  "json", "jsonc", "json5", "yaml", "yml", "toml", "xml", "ini", "cfg", "conf", "proto", "md", "mdx",
  "txt", "rst", "tf", "hcl", "nix", "gradle", "mod", "sum", "lock", "csv",
]);

// Files with no extension that are source or build description.
const SOURCE_NAMES = new Set(["Dockerfile", "Makefile", "Gemfile", "Procfile", "Rakefile", "Justfile", "LICENSE", "README", "CODEOWNERS"]);

// Files that carry secrets or our own sandbox config. They are dropped by name,
// before their content is used. Hidden files (.env, .npmrc, .netrc, ...) never
// get this far: a hidden path is refused outright.
const SECRET_NAME = [
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ovpn|gpg|asc|crt|cer|der)$/i,
  /^(secrets?|credentials?|service[-_]?account)(\.[\w-]+)?\.(json|ya?ml|toml|txt|ini)$/i,
  /^(secrets?|credentials?)$/i,
  /^wallet\.dat$/i,
  /^(keystore|mnemonic|seed)(\.[\w-]+)?\.(json|txt)$/i,
  /^env$/i,
  /\.env$/i,
];
// Never accept a supplied Foundry config. The sandbox uses our own.
const SANDBOX_CONFIG = new Set(["foundry.toml", "remappings.txt"]);

// A private key block in the content. Such a file is dropped, never stored.
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/;

// Is one relative path safe to write under a workspace? Refuses empty and long
// paths, absolute and host paths (a leading "/", a drive "C:", a "\"), "." and
// "..", hidden segments, and control characters.
export function safeRelPath(name) {
  if (typeof name !== "string" || !name || name.length > 240) return false;
  const parts = name.split("/");
  return !parts.some((p) => !p || p === "." || p === ".." || p.startsWith(".") || /[:\\\x00-\x1f]/.test(p));
}

// What happens to one safe path: "keep", or the reason it is dropped. Used here
// for folder intake and by the review pack before it reads a fetched file.
export function classifyPath(name, { solidity = false } = {}) {
  const parts = name.split("/");
  const base = parts[parts.length - 1];
  if (parts.slice(0, -1).some((p) => SKIP_DIRS.has(p) || p.startsWith(".")) || (solidity && parts.length > 1 && parts[0] === SOLIDITY_DEP_DIR)) return "dependency or build folder";
  if (SANDBOX_CONFIG.has(base)) return "sandbox config";
  if (SECRET_NAME.some((re) => re.test(base))) return "secret file";
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  if (ext ? SOURCE_EXT.has(ext) : SOURCE_NAMES.has(base)) return "keep";
  return "not a source file";
}

const isSolidity = (p) => p.endsWith(".sol");

// Validate one folder's files. Refuses (throws) on an unsafe path, a duplicate,
// non-text content, or no files. Drops (does not store) dependency and build
// folders, secret files, our sandbox config, and non-source files. `budget`
// carries the scope-wide file and byte totals across folders.
export function folderFiles(files, budget = { files: 0, bytes: 0 }) {
  if (!Array.isArray(files) || !files.length) throw new Error("A folder needs at least one file.");
  budget.files += files.length;
  if (budget.files > MAX_FILES) throw new Error(`Attach 1 to ${MAX_FILES} files per scope.`);
  const kept = [];
  const dropped = {};
  const seen = new Set();
  const solidity = files.some((f) => typeof f?.path === "string" && isSolidity(f.path));
  for (const f of files) {
    const name = typeof f?.path === "string" ? f.path : "";
    if (!safeRelPath(name)) throw new Error("Use relative file paths without hidden folders, host paths, or \"..\".");
    if (seen.has(name)) throw new Error(`Duplicate file: ${name}`);
    seen.add(name);
    if (typeof f.content !== "string") throw new Error("Attach text source files only.");
    let why = classifyPath(name, { solidity });
    if (why === "keep" && PRIVATE_KEY_BLOCK.test(f.content)) why = "secret file";
    if (why !== "keep") {
      dropped[why] = (dropped[why] ?? 0) + 1;
      continue;
    }
    if (f.content.includes("\u0000")) throw new Error("Attach text source files only.");
    budget.bytes += Buffer.byteLength(f.content);
    if (budget.bytes > MAX_BYTES) throw new Error("Source files must be under 2 MB in total.");
    kept.push({ path: name, content: f.content });
  }
  if (!kept.length) throw new Error("No source files left after skipping dependency, build, secret, and non-source files.");
  return { files: kept, dropped };
}

// Back-compat: the files of a legacy local-source scope. Same rules as a folder.
export function sourceFiles(files) {
  return folderFiles(files).files;
}

// A GitHub repo, folder, or file URL, normalized. HTTPS github.com only: no
// other host, no credentials, no port, no query or fragment.
export function githubRepoUrl(repo) {
  let u;
  try { u = new URL(repo); } catch { throw new Error("Enter a GitHub repository URL."); }
  if (u.protocol !== "https:" || u.hostname !== "github.com" || u.username || u.password || u.port || !/^\/[\w.-]+\/[\w.-]+(?:\/(?:tree|blob)\/.+)?\/?$/.test(u.pathname)) {
    throw new Error("Use an HTTPS GitHub repository, folder, or file URL.");
  }
  u.search = ""; u.hash = "";
  return u.href;
}

const FOLDER_NAME = /^[\w-][\w.-]{0,63}$/;

// Validate a members array. Returns the normalized members.
export function validateMembers(members) {
  if (!Array.isArray(members) || !members.length || members.length > MAX_MEMBERS) {
    throw new Error(`A scope needs 1 to ${MAX_MEMBERS} repos or folders.`);
  }
  const budget = { files: 0, bytes: 0 };
  const seen = new Set();
  return members.map((m) => {
    if (m?.kind === "repo") {
      const url = githubRepoUrl(m.url);
      if (seen.has(url)) throw new Error(`Duplicate repo: ${url}`);
      seen.add(url);
      return { kind: "repo", url };
    }
    if (m?.kind === "folder") {
      const name = String(m.name ?? "");
      if (!FOLDER_NAME.test(name) || name === "..") throw new Error("Use a folder name of letters, digits, \"-\", \"_\" or \".\", not starting with \".\".");
      if (seen.has(`folder:${name}`)) throw new Error(`Two folders are named ${name}. Rename one.`);
      seen.add(`folder:${name}`);
      const { files, dropped } = folderFiles(m.files, budget);
      return { kind: "folder", name, files, dropped };
    }
    throw new Error("A member is a repo { kind: \"repo\", url } or a folder { kind: \"folder\", name, files }.");
  });
}

// The packs an operator scope can run under. Each one's replay must fit the
// scope's code, or it must be unable to prove anything at all.
export const SCOPE_PACKS = {
  contracts: {
    kind: "sandbox-foundry",
    note: "Solidity is proven in an isolated, offline, per-run Foundry workspace. No live chain and no real funds. Other code in the scope is read as context and is never proven.",
  },
  review: {
    kind: "none",
    note: "No replay oracle fits this code. The run reads it and reports leads. No finding can be proven.",
  },
};

// The pack for a set of members. Folder content is known, so it decides:
// any Solidity file means Contracts. A repo's content is not known until the run
// fetches it, and we do not touch the network here, so a repo counts as
// Solidity only when its URL is a .sol file or the operator added it under
// Contracts (`declared`). Everything else is "review". There is no fallback to
// Contracts: non-Solidity code never gets a Foundry proof.
//
// Why not web, supply-chain, and the rest: their replays are bound to their own
// practice labs (web replays against its lab image; the evidence packs re-check
// a pinned lab snapshot). Operator code is not that lab, so none of those
// oracles fits it.
export function scopePack(members, declared) {
  const solFile = members.some((m) => (m.kind === "folder" ? m.files.some((f) => isSolidity(f.path)) : isSolidity(new URL(m.url).pathname)));
  if (solFile) return "contracts";
  if (declared === "contracts" && members.some((m) => m.kind === "repo")) return "contracts";
  return "review";
}

// How one member is proven under its scope's pack.
export function memberProof(member, pack) {
  if (pack !== "contracts") return "none";
  if (member.kind === "repo") return "forge"; // Foundry compiles only the Solidity the run fetches.
  return member.files.some((f) => isSolidity(f.path)) ? "forge" : "none";
}

// Where a folder member's files land in the workspace, under src/. One folder
// keeps its own layout; with several, each path starts with its folder name.
export function memberFilePaths(members) {
  const folders = members.filter((m) => m.kind === "folder");
  return folders.flatMap((m) => m.files.map((f) => ({ path: folders.length === 1 ? f.path : `${m.name}/${f.path}`, content: f.content })));
}

// The BRIEF.md a scope run reads first: its members and where each one is.
export function scopeBrief(scope) {
  const lines = [`# ${scope.title}`, "", "One scope, tested as one unit. Its members:", ""];
  const several = scope.members.filter((m) => m.kind === "folder").length > 1;
  for (const m of scope.members) {
    const proof = memberProof(m, scope.pack) === "forge" ? "Solidity is proven by the Foundry replay" : "read only, no proof";
    if (m.kind === "repo") lines.push(`- Repo ${m.url} — fetch it with fetch_source; it lands under vendor/. (${proof})`);
    else lines.push(`- Folder ${m.name} — ${m.files.length} file${m.files.length === 1 ? "" : "s"} under src/${several ? `${m.name}/` : ""}. (${proof})`);
  }
  return lines.join("\n") + "\n";
}

// Add a scope with members. `pack` is only a hint: it counts only for repos,
// whose content is not known yet (see scopePack). Returns the stored scope.
export function addScope({ title, members, pack: declared, blurb } = {}) {
  const list = validateMembers(members);
  const label = (m) => (m.kind === "repo" ? new URL(m.url).pathname.split("/")[2] : m.name);
  const t = String(title || "").trim() || list.map(label).join(" + ").slice(0, 120);
  if (!t || t.length > 120) throw new Error("Use a scope name of 1 to 120 characters.");
  const pack = scopePack(list, declared);
  const files = memberFilePaths(list);
  const links = list.filter((m) => m.kind === "repo").map((m) => m.url);
  const scope = {
    id: `scope-${slugify(t)}-${randomUUID().slice(0, 8)}`,
    kind: "scope",
    title: t,
    blurb: String(blurb || "").trim(),
    pack,
    entry: files[0]?.path ?? links[0],
    signal: pack === "contracts" && files.some((f) => isSolidity(f.path)) ? "static" : "agent",
    members: list,
    links,
    proofSurface: SCOPE_PACKS[pack],
    createdAt: Date.now(),
  };
  const all = readScopes();
  all.unshift(scope);
  writeScopes(all);
  return scope;
}

// Back-compat: one folder of files. Same rules as a folder member.
export function addSourceScope({ title, files } = {}) {
  const t = String(title || "").trim();
  if (!t || t.length > 120) throw new Error("Use a scope name of 1 to 120 characters.");
  return addScope({ title: t, members: [{ kind: "folder", name: slugify(t), files }] });
}

// Back-compat: one repo. The old body meant "audit the Solidity at this URL",
// so it keeps the Contracts declaration.
export function addRepoScope({ title, repo } = {}) {
  return addScope({ title, members: [{ kind: "repo", url: repo }], pack: "contracts" });
}

export function getUserScope(id) {
  return readScopes().find((s) => s.id === id) ?? null;
}

// Remove a scope by id. Returns true if one was removed.
export function removeScope(id) {
  const all = readScopes();
  const next = all.filter((s) => s.id !== id);
  if (next.length === all.length) return false;
  writeScopes(next);
  return true;
}

export function hasScopesFile() {
  return existsSync(scopesFile());
}
