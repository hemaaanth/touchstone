// Source navigation pack — read-only symbol lookup over the run's workspace.
//
// This pack exposes the FIVE read-only query tools of the codebase-memory-mcp
// code-intelligence engine, behind the `local-source` scope, so a hunter can
// resolve and read symbols, pull snippets, and walk callers/callees without
// grepping blind. It is modeled on `surface`: a tools pack that produces no
// findings (`prove: async () => []`). Navigation is never a vulnerability.
//
// The engine is RUN, not vendored into source: the pinned binary is installed
// out of band by tools/fetch-cbm-bin.sh and resolved at run time. The query
// path is a spike-native re-expression of pi-cbm (MIT) — see
// spike/lib/cbm.mjs, spike/vendor/pi-cbm/VENDOR.md, and this pack's TOOLS.md.
// Only the five query tools are registered; pi-cbm's destructive/admin/write
// tools (index as an agent tool, manage_adr, deletion, the UI server) are not.
//
// Everything runs offline: no account, no network, no API key. The index lands
// in the engine's own cache (~/.cache/codebase-memory-mcp). The only step that
// needs the network is the one-time binary fetch, documented as build-time.
import { defineTool } from "@earendil-works/pi-durable";
import { obj, str, int, bool, arr, opt, oneOf } from "@earendil-works/pi-schema";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readdirSync, lstatSync, linkSync, copyFileSync, mkdirSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cbm, resolveCbmBinary } from "../../lib/cbm.mjs";
import { classifyPath, secretContent, SKIP_DIRS } from "../../lib/scopes-store.mjs";
import { readFileSync } from "node:fs";

// A directory the read layer never descends into: a dependency/build folder, or
// any hidden folder (.git, .venv, ...). Pruning these before we stage or
// fingerprint keeps the symbol index identical to what the pack's own file tools
// expose — a nested node_modules/ or out/ under a vendored repo is no longer at a
// leading path segment once vendor/ is restaged under the sentinel, so the
// engine's own dependency-dir ignore would NOT catch it; we must drop it here.
const skipDir = (name) => SKIP_DIRS.has(name) || name.startsWith(".");
// One file is indexable only if the read layer would keep it: classifyPath drops
// dependency/build paths, secret-NAMED files (.env, *.pem, secrets.*), sandbox
// config, and non-source files; secretContent then drops a source file carrying
// an embedded private key / cloud credential. `rel` is relative to the staged
// ROOT (src/ or vendor/), because "vendor" itself is a SKIP_DIR and classifying
// the workspace path would drop every vendored file. Name-based only unless
// `content` is given (the staging pass reads it; the per-query fingerprint does
// not, to stay cheap).
function indexableFile(rel, content) {
  if (classifyPath(rel) !== "keep") return false;
  if (content !== undefined && secretContent(content)) return false;
  return true;
}

const text = (value) => ({ output: [{ type: "text", text: JSON.stringify(value) }] });
const fail = (message) => ({ output: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true });

const UNAVAILABLE =
  "source navigation unavailable: codebase-memory-mcp binary not found. Install the pinned release with tools/fetch-cbm-bin.sh, or set PI_CBM_BIN to its path.";

// A deterministic project name per workspace path, stable across every tool
// call in one run so the index is built once and reused.
const projectName = (ws) => `src-${createHash("sha256").update(ws).digest("hex").slice(0, 12)}`;

// A PRIVATE per-run cache dir for the engine, never the operator's default
// ~/.cache/codebase-memory-mcp. The default cache (a) is shared with the
// operator's own engine state and (b) comes up with the loopback UI/admin HTTP
// server enabled, so every short-lived engine call would serve a filesystem
// browse endpoint on 127.0.0.1:9749. A fresh private cache that we harden
// (ui_enabled=false, watcher off) before any engine call closes both.
const tempDirs = [];
function privateCacheDir() {
  const dir = mkdtempSync(join(tmpdir(), "touchstone-cbm-")); // mode 0700
  tempDirs.push(dir);
  return dir;
}
// Best-effort cleanup of the private caches and staging trees on process exit
// (sync; no async fs in an 'exit' handler).
process.once("exit", () => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// A cheap signature of the workspace's indexable source, so the index rebuilds
// when code lands (e.g. after fetch_source clones a repo into vendor/ mid-run)
// and is reused when nothing changed. It walks only src/ and vendor/ — the same
// roots the source tools read and the staging dir below indexes — pruning the
// SAME dependency/build/hidden folders and non-indexable files staging drops, so
// the signature tracks exactly the set that gets indexed (and skips descending
// into a vendored node_modules/ or .git/, which would otherwise dominate the
// walk). It hashes each kept file's path, size, and mtime. Symlinks are skipped
// (never followed), so a symlink loop cannot blow the walk and a symlinked file
// cannot smuggle code from outside the two roots into the signature.
function sourceFingerprint(ws) {
  const parts = [];
  // `root` labels the hashed key (so src/x and vendor/x differ); `rel` is the
  // path WITHIN the root, which is what classifyPath must see.
  const walk = (dir, root, rel) => {
    let names;
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const abs = join(dir, name);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      const within = rel ? `${rel}/${name}` : name;
      if (st.isDirectory()) {
        if (!skipDir(name)) walk(abs, root, within);
      } else if (st.isFile() && indexableFile(within)) {
        parts.push(`${root}/${within}:${st.size}:${Math.round(st.mtimeMs)}`);
      }
    }
  };
  for (const root of ["src", "vendor"]) {
    const abs = join(ws, root);
    if (existsSync(abs)) walk(abs, root, "");
  }
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

// The engine hardcodes a dependency-directory ignore: a top-level `vendor/` (and
// `node_modules/`, `.git/`, ...) is never indexed, and the match is on the
// leading segment ("vendored" is skipped too). The pack's own read tools DO
// cover vendor/ — vendored contracts are prime audit surface — so to make it
// navigable we stage vendor/ under a sentinel directory the engine does index,
// then map the sentinel back to "vendor" in results. The sentinel carries no
// "vendor"/"node_modules" substring and cannot collide with a real path segment.
const VENDOR_STAGE = "__deps__";

// Materialize a staging tree holding ONLY src/ and vendor/, so the engine (whose
// index has no ignore/include option) never sees test fixtures, scripts, build
// output, or anything else in the workspace. Without this a `withdraw` in test/
// shadows the real one in src/ and read_symbol fails closed on the ambiguity, or
// a stale proof-of-concept under test/ gets served as if it were the target.
// Within those two roots we apply the SAME filter the read layer does
// (indexableFile → classifyPath + secretContent): dependency/build folders,
// hidden folders, secret-named files, and secret-bearing source are dropped, so
// the symbol index can never expose what the pack's file tools refuse to show —
// crucial once vendor/ is restaged under the sentinel, where a nested
// node_modules/ or out/ is no longer at a leading segment the engine would ignore.
// The engine does not follow directory symlinks, so a symlinked staging dir
// indexes empty; instead we HARDLINK each kept file (no byte copy, same inode — a
// walker sees a plain file), falling back to a copy across filesystems. Symlinks
// in the source are skipped, matching the fingerprint. File paths come back
// relative to this root; query() maps the sentinel back so the hunter sees
// src/... , vendor/... — the same shape the pack's own read tools use.
function stageSources(ws) {
  const staging = mkdtempSync(join(tmpdir(), "touchstone-src-")); // mode 0700
  tempDirs.push(staging);
  // `rel` is the path within the staged root, passed to indexableFile so the
  // index covers EXACTLY what the read tools expose — no node_modules/, build
  // output, hidden folders, secret files, or secret-bearing source.
  const copyInto = (srcDir, dstDir, rel) => {
    let names;
    try {
      names = readdirSync(srcDir);
    } catch {
      return;
    }
    let made = false;
    for (const name of names) {
      const s = join(srcDir, name);
      const d = join(dstDir, name);
      let st;
      try {
        st = lstatSync(s);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      const within = rel ? `${rel}/${name}` : name;
      if (st.isDirectory()) {
        if (!skipDir(name)) copyInto(s, d, within);
        continue;
      }
      if (!st.isFile()) continue;
      // Name-based gate first (cheap), then read content once to drop a source
      // file that carries an embedded secret — the same two-step the read layer
      // (folderFiles) applies. An unreadable/binary file throws here and is
      // skipped, exactly as the old hardlink-fallback did.
      if (!indexableFile(within)) continue;
      let content;
      try {
        content = readFileSync(s, "utf8");
      } catch {
        continue;
      }
      if (!indexableFile(within, content)) continue;
      if (!made) {
        mkdirSync(dstDir, { recursive: true });
        made = true;
      }
      try {
        linkSync(s, d);
      } catch {
        try {
          copyFileSync(s, d);
        } catch {
          /* unreadable file: skip, like the fingerprint does */
        }
      }
    }
  };
  // src/ keeps its name; vendor/ is staged under the sentinel so the engine's
  // dependency-dir ignore does not drop it.
  for (const [root, staged] of [["src", "src"], ["vendor", VENDOR_STAGE]]) {
    const abs = join(ws, root);
    if (existsSync(abs)) copyInto(abs, join(staging, staged), "");
  }
  return staging;
}

// One index per workspace, built lazily on the first query and memoized by the
// source fingerprint above: a post-fetch workspace has a new fingerprint, so the
// next query rebuilds the index against the freshly staged code. The binary is
// RUN, never committed; if it is missing the whole pack degrades to "unavailable"
// (the aderyn.mjs pattern) instead of failing the run.
//
// The job SETTLES to a result marker ({ cbm, project, ... } | { unavailable } |
// { failed }) rather than rejecting. A settled success or "unavailable" is reused
// as-is. A settled FAILURE (e.g. a transient 300s index timeout under fleet
// fan-out) is retried at most MAX_INDEX_ATTEMPTS times for the SAME fingerprint:
// enough to recover from a blip, but bounded so a persistently failing index does
// not re-run the expensive build on every query and stall a fleet of hunters. A
// pending job is always shared, so concurrent queries never start a second index.
//
// Superseded indexes (a mid-run fingerprint change) are NOT eagerly deleted —
// doing so raced a cleanup against an in-flight query still reading the old cache.
// Their temp dirs (staging + private cache, both tracked in tempDirs) are instead
// reclaimed together on process exit.
const MAX_INDEX_ATTEMPTS = 2;
const indexed = new Map();
function ensureIndexed(ws) {
  const fp = sourceFingerprint(ws);
  const cached = indexed.get(ws);
  if (cached && cached.fp === fp) {
    // Reuse a pending or successful job; retry only a settled failure, and only
    // while under the per-fingerprint attempt cap.
    if (!(cached.settled && cached.settled.failed && cached.attempts < MAX_INDEX_ATTEMPTS)) return cached.job;
  }
  const attempts = (cached && cached.fp === fp ? cached.attempts : 0) + 1;
  const job = (async () => {
    try {
      const bin = await resolveCbmBinary();
      if (!bin) return { unavailable: true };
      // Private, hardened cache: no listener, no watcher, no shared state. The
      // binary's sha256 is verified by the wrapper before its first exec.
      const cacheDir = privateCacheDir();
      const cbm = new Cbm({ bin, cacheDir });
      await cbm.hardenCache(); // disable UI server + watcher BEFORE any index/query
      const project = projectName(ws);
      const staging = stageSources(ws); // index ONLY src/ + vendor/
      await cbm.index(staging, { name: project, mode: "fast" });
      return { cbm, project, cacheDir, staging, stagingReal: safeRealpath(staging) };
    } catch (e) {
      return { failed: String(e?.message ?? e) };
    }
  })();
  // Record the settled marker synchronously on the entry so the next call can see
  // a failure (and retry under the cap) without awaiting.
  const entry = { fp, job, attempts, settled: null };
  job.then((r) => { entry.settled = r; }).catch(() => {});
  indexed.set(ws, entry);
  return job;
}

function safeRealpath(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// The engine echoes absolute and sentinel-staged paths in its results. Map them
// back to the workspace shape STRUCTURALLY, not by blanket string replace:
//  - The private absolute staging path (a unique mkdtemp dir, never present in
//    real source) is stripped from every string — read_symbol puts it in the
//    top-level file_path, and stripping it there cannot corrupt a snippet.
//  - The vendor sentinel is rewritten to "vendor" ONLY in a PATH field —
//    `file_path`, or the `file`/`path` aliases the engine's raw record uses under
//    include_metadata (cbm.mjs normalizes file_path ?? file ?? path). A vendored
//    file then reads as vendor/Foo.sol (matching the pack's own read tools). It is
//    deliberately NOT rewritten in `qualified_name`/`parent_class` (which also
//    embed the sentinel as a dotted segment): those are opaque tokens the hunter
//    passes straight back to the engine, which still has them under __deps__ —
//    rewriting them would break the round trip. And it is never run over `source`,
//    so a snippet that happens to contain the literal "__deps__" is shown verbatim
//    rather than mangled.
const PATH_KEYS = new Set(["file_path", "file", "path"]);
function stripAbs(s, ready) {
  for (const root of [ready.stagingReal, ready.staging]) {
    if (root) s = s.split(`${root}/`).join("").split(root).join("");
  }
  return s;
}
function toVendorPath(s, ready) {
  s = stripAbs(s, ready);
  if (s === VENDOR_STAGE) return "vendor";
  if (s.startsWith(`${VENDOR_STAGE}/`)) return `vendor/${s.slice(VENDOR_STAGE.length + 1)}`;
  return s;
}
function mapOut(value, ready) {
  if (typeof value === "string") return stripAbs(value, ready);
  if (Array.isArray(value)) return value.map((v) => mapOut(v, ready));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = PATH_KEYS.has(k) && typeof v === "string" ? toVendorPath(v, ready) : mapOut(v, ready);
    }
    return out;
  }
  return value;
}

// The inverse on the way IN: a vendored path the hunter saw as vendor/... must be
// resolved back to the sentinel the engine indexed it under, or every file_path /
// file_pattern disambiguator for vendored code would match nothing. Only the two
// path-bearing inputs are touched; names, qualified names, and queries pass
// through untouched (qualified_name already carries the sentinel the hunter got
// back from a result, so it round-trips as-is).
function toStagePath(s) {
  if (s === "vendor") return VENDOR_STAGE;
  if (s.startsWith("vendor/")) return `${VENDOR_STAGE}/${s.slice("vendor/".length)}`;
  return s;
}
function mapIn(params) {
  const p = { ...params };
  if (typeof p.file_path === "string") p.file_path = toStagePath(p.file_path);
  // file_pattern is a regex on the file path: remap only a leading vendor/ (or
  // ^vendor/ , or a bare vendor) segment, so a pattern like "vendorUtils" or
  // "src/vendor" is left intact.
  if (typeof p.file_pattern === "string")
    p.file_pattern = p.file_pattern.replace(/^(\^?)vendor(\/|$)/, (_, anchor, tail) => `${anchor}${VENDOR_STAGE}${tail}`);
  // read_symbols carries per-entry disambiguators, each of which may pin file_path.
  if (Array.isArray(p.symbols))
    p.symbols = p.symbols.map((s) =>
      s && typeof s === "object" && typeof s.file_path === "string" ? { ...s, file_path: toStagePath(s.file_path) } : s,
    );
  return p;
}

// Resolve the index, run one query method, and return its result as tool text.
// The project name is injected here, never taken from the agent.
async function query(ws, method, params) {
  let ready;
  try {
    ready = await ensureIndexed(ws);
  } catch (e) {
    return fail(`source navigation index failed: ${e?.message ?? e}`);
  }
  if (ready.unavailable) return fail(UNAVAILABLE);
  if (ready.failed) return fail(`source navigation index failed: ${ready.failed}`);
  try {
    return text(mapOut(await ready.cbm[method]({ ...mapIn(params), project: ready.project }), ready));
  } catch (e) {
    return fail(`${method} failed: ${e?.message ?? e}`);
  }
}

// Shared lookup disambiguators for resolve_symbol / read_symbol.
const lookupProps = {
  name: opt(str({ description: "Exact symbol name, e.g. transfer." })),
  qualified_name: opt(str({ description: "Dotted qualified name or a suffix of one, e.g. Token.transfer." })),
  file_path: opt(str({ description: "Keep only symbols whose file path ends with (or contains) this." })),
  label: opt(str({ description: "Keep only this node label, e.g. Function, Class, Route." })),
  parent_class: opt(str({ description: "Keep only members of this class." })),
  route_path: opt(str({ description: "For routes: the route path to match." })),
  route_method: opt(str({ description: "For routes: the HTTP method to match, e.g. GET." })),
  include_metadata: opt(bool({ description: "Return the full raw candidate record instead of the compact one." })),
};
// NOTE: there is deliberately no `limit` on the resolve/read path. Candidate
// breadth is a fixed internal bound in the wrapper; a caller must not be able
// to narrow the set and slip a multi-match past read_symbol's fail-closed gate.

// One symbol request inside read_symbols: the same disambiguators, per entry.
// Closed (no `open: true`): an undeclared key — e.g. a smuggled `limit` — is
// rejected, so nothing a caller invents reaches the resolution path.
const symbolRequest = obj({
  name: opt(str()),
  qualified_name: opt(str()),
  file_path: opt(str()),
  parent_class: opt(str()),
  label: opt(str()),
  route_path: opt(str()),
  route_method: opt(str()),
});

function tools(ws) {
  return [
    defineTool({
      name: "resolve_symbol",
      description:
        "Resolve a symbol to its candidate locations in the indexed workspace. Give name or qualified_name, plus any disambiguators (file_path, parent_class, label, route_path, route_method). Returns candidates with file path and line range; it does not return source. Read-only.",
      parameters: obj(lookupProps),
      replay: "safe",
      execute: async (args) => query(ws, "resolveSymbol", args),
    }),
    defineTool({
      name: "read_symbol",
      description:
        "Read one symbol's source from the indexed workspace. Give name or qualified_name plus disambiguators. FAILS CLOSED on ambiguity: if more than one symbol matches it returns the candidates and no source — narrow with file_path, parent_class, label, or qualified_name. Set neighbors to also list callers/callees. Read-only.",
      parameters: obj(
        {
          ...lookupProps,
          neighbors: opt(oneOf(["callers", "callees", "both"], { description: "Also return the symbol's callers, callees, or both." })),
          neighbor_limit: opt(int({ minimum: 1, maximum: 50, description: "Max neighbors per direction (default 10)." })),
        },
      ),
      replay: "safe",
      execute: async (args) => query(ws, "readSymbol", args),
    }),
    defineTool({
      name: "get_code_snippets",
      description:
        "Read source for a batch of already-known qualified names (up to 50). Use this after resolve_symbol when you have exact qualified_names. Read-only.",
      parameters: obj(
        {
          qualified_names: arr(str(), { minItems: 1, maxItems: 50, description: "Exact qualified names to read." }),
          max_concurrency: opt(int({ minimum: 1, maximum: 16 })),
          include_neighbors: opt(bool({ description: "Include each symbol's callers and callees." })),
        },
      ),
      replay: "safe",
      execute: async (args) => query(ws, "getCodeSnippets", args),
    }),
    defineTool({
      name: "read_symbols",
      description:
        "Resolve and read a batch of symbols by name or qualified_name (up to 30). Each entry may carry its own disambiguators. Entries that stay ambiguous or unresolved are reported per entry; they do not fail the call. Read-only.",
      parameters: obj(
        {
          symbols: arr(symbolRequest, { minItems: 1, maxItems: 30, description: "One request object per symbol to read." }),
          max_concurrency: opt(int({ minimum: 1, maximum: 12 })),
          include_metadata: opt(bool()),
        },
      ),
      replay: "safe",
      execute: async (args) => query(ws, "readSymbols", args),
    }),
    defineTool({
      name: "search_and_read_symbols",
      description:
        "Search the graph and read the top matches in one step. Give at least one of query, name_pattern, qn_pattern, or file_pattern (patterns are regexes). Returns each match's source up to read_limit, plus the unread remainder. Use this to explore when you do not yet know exact names. Read-only.",
      parameters: obj(
        {
          query: opt(str({ description: "Free-text search over symbol names and signatures." })),
          name_pattern: opt(str({ description: "Regex on the symbol name." })),
          qn_pattern: opt(str({ description: "Regex on the qualified name." })),
          file_pattern: opt(str({ description: "Regex on the file path." })),
          label: opt(str({ description: "Restrict to a node label." })),
          search_limit: opt(int({ minimum: 1, maximum: 50, description: "Max candidates to search (default 12)." })),
          read_limit: opt(int({ minimum: 1, maximum: 20, description: "Max matches to read source for (default up to 8)." })),
          max_concurrency: opt(int({ minimum: 1, maximum: 16 })),
          include_metadata: opt(bool()),
        },
      ),
      replay: "safe",
      execute: async (args) => query(ws, "searchAndReadSymbols", args),
    }),
  ];
}

// The five read-only query tools, for a run to mount alongside its own pack
// tools. This is the default way a Contracts or Review run reads code it was
// given: a symbol index, not blind greps. agent-run.mjs imports this and
// NAV_SYSTEM directly; there is no selectable "source-nav" pack.
export function sourceNavTools(ws) {
  return tools(ws);
}

// Exported for the pack's test only: the fingerprint that triggers a re-index,
// the staging builder that scopes the index to src/ + vendor/, and the sentinel
// directory vendor/ is staged under to dodge the engine's dependency-dir ignore.
export { sourceFingerprint, stageSources, VENDOR_STAGE };

// Instruction appended to a run's system prompt when the nav tools are mounted.
// It tells the hunter to prefer the index and names the flat source tools as the
// fallback, so the index is the default reading path, not a parallel mode.
export const NAV_SYSTEM =
  "\n\nThis codebase is also available to you through a read-only symbol index — prefer it over reading whole files blind. Use search_and_read_symbols to find entry points and sensitive code when you do not yet know names, resolve_symbol to locate a name, read_symbol to read one definition (it FAILS CLOSED on ambiguity — narrow with file_path, parent_class, label, or qualified_name), and read_symbols / get_code_snippets to pull several at once and walk callers and callees. Fall back to the pack's own file-reading tools (list_sources, read_source, and search_source where the pack has it) only when the index has no answer — for example before it has finished building, or for a file it does not cover. The index is offline and read-only; a symbol it surfaces is a lead, never a proof.";

