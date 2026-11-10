// Operator-configured scopes — the assets the operator adds themselves, as
// opposed to the labs that ship built into targets.mjs. Today that means a
// "brief": a pasted markdown write-up with links to the code under review. The
// engine fetches those links host-side into a throwaway workspace at run time
// (the sandbox has no network), then proves findings offline against local test
// contracts only — never a live chain, never real funds.
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
const SCOPES_FILE = path.join(DATA_DIR, "scopes.json");

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
    const raw = readFileSync(SCOPES_FILE, "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeScopes(arr) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SCOPES_FILE, JSON.stringify(arr, null, 2));
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

// Only Solidity source is attached. Never accept host paths, build hooks,
// credentials, or a supplied Foundry config. The sandbox uses our own config.
export function sourceFiles(files) {
  if (!Array.isArray(files) || !files.length || files.length > 200) throw new Error("Attach 1 to 200 Solidity files.");
  let bytes = 0;
  const seen = new Set();
  return files.map((f) => {
    const name = typeof f?.path === "string" ? f.path : "";
    const parts = name.split("/");
    if (!name || name.length > 240 || !name.endsWith(".sol") || parts.some((p) => !p || p === "." || p === ".." || p.startsWith(".") || /[:\\\x00-\x1f]/.test(p))) {
      throw new Error("Use relative Solidity file paths without hidden folders.");
    }
    if (typeof f.content !== "string" || f.content.includes("\u0000")) throw new Error("Attach text source files only.");
    bytes += Buffer.byteLength(f.content);
    if (bytes > 2 * 1024 * 1024) throw new Error("Source files must be under 2 MB in total.");
    if (seen.has(name)) throw new Error(`Duplicate file: ${name}`);
    seen.add(name);
    return { path: name, content: f.content };
  });
}

export function addSourceScope({ title, files } = {}) {
  const t = String(title || "").trim();
  if (!t || t.length > 120) throw new Error("Use a scope name of 1 to 120 characters.");
  const sources = sourceFiles(files);
  const scope = {
    id: `source-${slugify(t)}-${randomUUID().slice(0, 8)}`,
    kind: "local-source", title: t, blurb: "", entry: sources[0].path,
    signal: "static", files: sources, proofSurface: SANDBOX_FOUNDRY, createdAt: Date.now(),
  };
  const all = readScopes();
  all.unshift(scope);
  writeScopes(all);
  return scope;
}

export function addRepoScope({ title, repo } = {}) {
  let u;
  try { u = new URL(repo); } catch { throw new Error("Enter a GitHub repository URL."); }
  if (u.protocol !== "https:" || u.hostname !== "github.com" || u.username || u.password || u.port || !/^\/[\w.-]+\/[\w.-]+(?:\/(?:tree|blob)\/.+)?\/?$/.test(u.pathname)) {
    throw new Error("Use an HTTPS GitHub repository, folder, or file URL.");
  }
  u.search = ""; u.hash = "";
  return addBriefScope({ title: title || u.pathname.split("/")[2], brief: `Audit the Solidity code at ${u.href}.`, blurb: "" });
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
  return existsSync(SCOPES_FILE);
}
