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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cbm, resolveCbmBinary } from "../../lib/cbm.mjs";

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
const cacheDirs = [];
function privateCacheDir() {
  const dir = mkdtempSync(join(tmpdir(), "touchstone-cbm-")); // mode 0700
  cacheDirs.push(dir);
  return dir;
}
// Best-effort cleanup of the private caches on process exit (sync; no async fs
// in an 'exit' handler).
process.once("exit", () => {
  for (const dir of cacheDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// One index per workspace, built lazily on the first query and memoized. The
// binary is RUN, never committed; if it is missing the whole pack degrades to
// "unavailable" (the aderyn.mjs pattern) instead of failing the run. A failed
// index clears the memo so a later call can retry.
const indexed = new Map();
function ensureIndexed(ws) {
  let job = indexed.get(ws);
  if (!job) {
    job = (async () => {
      const bin = await resolveCbmBinary();
      if (!bin) return { unavailable: true };
      // Private, hardened cache: no listener, no watcher, no shared state. The
      // binary's sha256 is verified by the wrapper before its first exec.
      const cacheDir = privateCacheDir();
      const cbm = new Cbm({ bin, cacheDir });
      await cbm.hardenCache(); // disable UI server + watcher BEFORE any index/query
      const project = projectName(ws);
      await cbm.index(ws, { name: project, mode: "fast" });
      return { cbm, project };
    })();
    job.catch(() => indexed.delete(ws));
    indexed.set(ws, job);
  }
  return job;
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
  try {
    return text(await ready.cbm[method]({ ...params, project: ready.project }));
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

export default {
  id: "source-nav",
  title: "Source navigation",
  tier: "P",
  proof: "evidence",
  system: () =>
    "Navigate the indexed workspace with the source-navigation tools. resolve_symbol finds candidate locations; read_symbol reads one symbol's source and FAILS CLOSED on ambiguity — narrow with file_path, parent_class, label, or qualified_name. get_code_snippets reads a batch of known qualified_names; read_symbols resolves and reads a batch by name; search_and_read_symbols explores by query or regex. All five are read-only and offline — no account, no network, no key. Navigation output is leads, never a vulnerability: finding a symbol does not prove a bug. Do not access the internet.",
  tools: (ws) => tools(ws),
  kickoff: () =>
    "Map the workspace with the source-navigation tools, worst-first by risk. Start with search_and_read_symbols to find entry points and sensitive symbols, then resolve_symbol and read_symbol to read each one and walk its callers and callees. Summarize what you found; every result is a lead, not a vulnerability.",
  nudge: () => null,
  // Navigation produces no findings. No finding may pass this pack.
  prove: async () => [],
};
