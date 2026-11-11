// codebase-memory-mcp adapter — the hunter's source-navigation engine.
//
// codebase-memory-mcp is a pure-C, statically-linked, fully offline code-
// intelligence engine. It builds a symbol graph of a repository and answers
// read-only queries about it (resolve a name to a symbol, read a symbol's
// source, walk callers/callees). We do NOT port or copy its engine logic; we
// run the real binary and speak its CLI contract. The binary is fetched and
// pinned by tools/fetch-cbm-bin.sh (build-time, documented), then only ever
// RUN here — never at network time. No account, no API key, no network at
// runtime: the index lives under CBM_CACHE_DIR (default ~/.cache/
// codebase-memory-mcp). See spike/packs/source-nav/TOOLS.md.
//
// The CLI contract and the query composition below are a spike-native re-
// expression of pi-cbm v2.0.0 (vendored in spike/vendor/pi-cbm, MIT). Each
// ported block names the upstream file it came from. We expose the five READ-
// ONLY query tools pi-cbm defines and nothing destructive. Everything here
// uses Node built-ins only, so it is testable without the pi-durable runtime.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// ---------------------------------------------------------------------------
// env + small helpers (pi-cbm src/shared/{env,object,numbers,strings}.ts)
// ---------------------------------------------------------------------------

// An extension setting PI_CBM_<name>; blank counts as unset.
export function cbmEnv(name, env = process.env) {
  const v = env[`PI_CBM_${name}`];
  return v && v.trim() ? v.trim() : undefined;
}
const cbmEnvFlag = (name, env) => cbmEnv(name, env) === "1";

const isRecord = (v) => typeof v === "object" && v !== null;
const removeUndefined = (v) => Object.fromEntries(Object.entries(v).filter(([, e]) => e !== undefined));
function stringProp(item, key) {
  const v = item[key];
  return typeof v === "string" && v.trim() ? v : undefined;
}
function numberProp(item, key) {
  const v = item[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return undefined;
}
const clampInt = (v, fallback, min, max) =>
  typeof v !== "number" || !Number.isFinite(v) ? fallback : Math.max(min, Math.min(Math.floor(v), max));
const escapeRegExp = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalizeForMatch = (v) => v.replaceAll("\\", "/").toLowerCase();
const errorText = (v) =>
  v instanceof Error ? v.message : typeof v === "string" ? v : isRecord(v) && typeof v.error === "string" ? v.error : JSON.stringify(v);

// Bounded-concurrency map, order preserved (pi-cbm src/shared/concurrency.ts).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const n = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------
// binary resolution (pi-cbm src/cbm/binary.ts, plus our pinned install path)
// ---------------------------------------------------------------------------

const DEFAULT_BINARY = "codebase-memory-mcp";
// ~/.local/bin is pi-cbm's fallback; the share path is where tools/fetch-cbm-bin.sh installs.
const FALLBACK_BINARY_PATHS = [
  "~/.local/bin/codebase-memory-mcp",
  "~/.local/share/touchstone/codebase-memory-mcp/0.12.1/codebase-memory-mcp",
];

function expandHome(p) {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}
async function isExecutable(p) {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
async function findOnPath(cmd, env) {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, cmd);
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

// Resolve the engine binary. Returns null when it cannot be found, so callers
// degrade to "unavailable" instead of throwing (the aderyn.mjs pattern).
export async function resolveCbmBinary(env = process.env) {
  const configured = cbmEnv("BIN", env);
  if (configured) {
    const p = expandHome(configured);
    return (await isExecutable(p)) ? p : null;
  }
  const onPath = await findOnPath(DEFAULT_BINARY, env);
  if (onPath) return onPath;
  for (const fb of FALLBACK_BINARY_PATHS) {
    const p = expandHome(fb);
    if (await isExecutable(p)) return p;
  }
  return null;
}

// sha256 of the EXTRACTED v0.12.1 linux-amd64 portable engine binary (the file
// tools/fetch-cbm-bin.sh installs — not the release archive). We hash the
// resolved binary and refuse to exec anything that does not match this pin, so
// a $PATH/env-planted or untested-newer build cannot slip in. A different
// platform build requires updating this pin AND the fetch script together.
export const PINNED_CBM_SHA256 = "77745491f0a9c346d6da23eed4d92b5feaa31a27a883c9faa4fa9f47c8183705";

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

// Fail-closed binary identity check: hash the file (no exec) and compare to the
// pin. Returns { ok, sha256?, message? }; ok:false means do not run it.
export async function verifyCbmBinary(binPath) {
  try {
    const sha256 = await sha256File(binPath);
    if (sha256 === PINNED_CBM_SHA256) return { ok: true, sha256 };
    return {
      ok: false,
      sha256,
      message: `codebase-memory-mcp binary at ${binPath} has sha256 ${sha256}, which does not match the pinned ${PINNED_CBM_SHA256} (v0.12.1 linux-amd64 portable). Refusing to run. Reinstall with tools/fetch-cbm-bin.sh.`,
    };
  } catch (e) {
    return { ok: false, message: `cannot hash codebase-memory-mcp binary at ${binPath}: ${errorText(e)}` };
  }
}

// ---------------------------------------------------------------------------
// version gate (pi-cbm src/cbm/version.ts) — only the parts we need
// ---------------------------------------------------------------------------

export const SUPPORTED_CBM_VERSION_RANGE = ">=0.12.0 <0.13.0";
const parseCbmVersion = (out) => {
  const m = /codebase-memory-mcp\s+v?(\d+)\.(\d+)\.(\d+)/.exec(out);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : undefined;
};
// { status: "ok"|"too-old"|"untested-newer"|"unknown", version?, message? }
function evaluateCbmVersion(version) {
  if (!version) return { status: "unknown" };
  const text = `${version.major}.${version.minor}.${version.patch}`;
  if (version.major === 0 && version.minor < 12)
    return { status: "too-old", version: text, message: `codebase-memory-mcp ${text} is unsupported; requires 0.12.x (${SUPPORTED_CBM_VERSION_RANGE}).` };
  if (version.major === 0 && version.minor === 12) return { status: "ok", version: text };
  return { status: "untested-newer", version: text };
}

// ---------------------------------------------------------------------------
// envelope + normalization (pi-cbm src/cbm/{envelope,normalize}.ts)
// ---------------------------------------------------------------------------

function parseCbmEnvelope(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("codebase-memory-mcp produced no JSON output");
  const candidates = [
    trimmed,
    ...trimmed
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("{") && l.endsWith("}"))
      .reverse(),
  ];
  let envelope;
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === "object" && (Array.isArray(parsed.content) || "isError" in parsed)) {
        envelope = parsed;
        break;
      }
    } catch {
      /* log line before the envelope */
    }
  }
  if (!envelope) throw new Error(`Could not parse codebase-memory-mcp JSON envelope from: ${trimmed.slice(0, 500)}`);
  const firstText = envelope.content?.find((i) => i.type === "text" && typeof i.text === "string")?.text;
  return { envelope, text: firstText ?? trimmed };
}
function parseMaybeJson(text) {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return text;
  try {
    return JSON.parse(t);
  } catch {
    return text;
  }
}

// cbm 0.12 returns compact {cols, rows} / {qn_rule, cols, groups} tables.
// Expand them into the object arrays the query composition expects.
const COLUMN_ALIASES = { qn: "qualified_name", file: "file_path", in: "in_degree", out: "out_degree", matches: "match_lines" };
function rowToObject(columns, row) {
  const item = {};
  columns.forEach((col, i) => {
    item[typeof col === "string" ? col : String(col)] = Array.isArray(row) ? row[i] : undefined;
  });
  return item;
}
function applyAliases(item) {
  for (const [from, to] of Object.entries(COLUMN_ALIASES)) if (item[to] === undefined && item[from] != null) item[to] = item[from];
  if (typeof item.lines === "string") {
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(item.lines.trim());
    if (m) {
      if (typeof item.start_line !== "number") item.start_line = Number(m[1]);
      if (typeof item.end_line !== "number") item.end_line = Number(m[2]);
    }
  }
  return item;
}
function expandGroups(value) {
  const columns = value.cols;
  const out = [];
  for (const group of value.groups) {
    if (!isRecord(group)) continue;
    const prefix = typeof group.qn_prefix === "string" ? group.qn_prefix : "";
    const groupFile = typeof group.file === "string" ? group.file : undefined;
    for (const row of Array.isArray(group.rows) ? group.rows : []) {
      const item = rowToObject(columns, row);
      const name = typeof item.name === "string" ? item.name : "";
      item.qualified_name = prefix === "" ? name : `${prefix}.${name}`;
      if (groupFile !== undefined && item.file_path === undefined) item.file_path = groupFile;
      out.push(applyAliases(item));
    }
  }
  return out;
}
function expandRows(value) {
  return value.rows.map((row) => applyAliases(rowToObject(value.cols, row)));
}
function normalizeCbmData(value) {
  if (Array.isArray(value)) return value.map(normalizeCbmData);
  if (!isRecord(value)) return value;
  const isGroups = Array.isArray(value.cols) && Array.isArray(value.groups);
  const isRows = Array.isArray(value.cols) && Array.isArray(value.rows);
  const pagedGroups = isGroups && !Array.isArray(value.rows) && ("total" in value || "has_more" in value);
  const pagedRows = isRows && Object.keys(value).some((k) => k !== "cols" && k !== "rows");
  if (pagedGroups) {
    const r = {};
    for (const [k, e] of Object.entries(value)) if (k !== "cols" && k !== "groups") r[k] = normalizeCbmData(e);
    r.results = expandGroups(value);
    return r;
  }
  if (pagedRows) {
    const r = {};
    for (const [k, e] of Object.entries(value)) if (k !== "cols" && k !== "rows") r[k] = normalizeCbmData(e);
    r.results = expandRows(value);
    return r;
  }
  if (isGroups) return expandGroups(value);
  if (isRows) return expandRows(value);
  const r = {};
  for (const [k, e] of Object.entries(value)) r[k] = normalizeCbmData(e);
  if (Array.isArray(r.impacted)) r.impacted = r.impacted.map((row) => (isRecord(row) ? applyAliases(row) : row));
  return r;
}

// ---------------------------------------------------------------------------
// the client (pi-cbm src/cbm/client.ts)
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_STDIO_BYTES = 50 * 1024 * 1024;

// A GLOBAL cap on concurrently running engine processes, across every Cbm
// instance. The engine is a heavyweight one-shot binary (~330 MB resident per
// process). A single read_symbols call fans out `concurrency × search-variants`
// spawns (e.g. 4 × 3 = up to 12), and the whole batch would otherwise cold-start
// at once — storming the host's memory/CPU AND the one private cache's lock, so
// some processes block past the per-call timeout and die by SIGTERM. Funnelling
// every exec through one bounded queue (a) keeps the engine reliable under batch
// fan-out and (b) bounds resource use so a crafted batch cannot fork-bomb the
// host. Override with PI_CBM_MAX_PROCS; the default is deliberately small since a
// single query is ~0.7 s and throughput past a few procs only adds contention.
const MAX_ENGINE_PROCS = Math.max(1, Number(process.env.PI_CBM_MAX_PROCS) || 3);
let engineInFlight = 0;
const engineWaiters = [];
function acquireEngineSlot() {
  if (engineInFlight < MAX_ENGINE_PROCS) {
    engineInFlight += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => engineWaiters.push(resolve));
}
function releaseEngineSlot() {
  const next = engineWaiters.shift();
  if (next) next(); // hand the slot straight to a waiter; in-flight count unchanged
  else engineInFlight -= 1;
}

// The ONLY environment the engine subprocess receives. Everything else —
// provider API keys, tokens, unrelated secrets in process.env — is withheld; a
// pure offline engine does not need them. CBM_CACHE_DIR is added separately
// from the instance's (private) cacheDir.
const CHILD_ENV_ALLOW = [
  "HOME", "PATH", "TMPDIR", "TMP", "TEMP",
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE",
  "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
];

export class Cbm {
  // bin: resolved binary path. cacheDir: forwarded as CBM_CACHE_DIR so the
  // index stays in one known offline location. skipVersionCheck honors
  // PI_CBM_SKIP_VERSION_CHECK=1 for a packaged build whose --version string the
  // caller already trusts.
  constructor({ bin, cacheDir, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.bin = bin;
    this.cacheDir = cacheDir ?? cbmEnv("CACHE_DIR", env) ?? env.CBM_CACHE_DIR;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.skipVersionCheck = cbmEnvFlag("SKIP_VERSION_CHECK", env);
    this._version = undefined;
  }

  childEnv() {
    const e = {};
    for (const k of CHILD_ENV_ALLOW) if (this.env[k] !== undefined) e[k] = this.env[k];
    if (this.cacheDir) e.CBM_CACHE_DIR = this.cacheDir;
    return e;
  }

  // Verify the binary's sha256 against the pin exactly once, before the FIRST
  // exec of this instance. Fail-closed: a mismatch throws and nothing runs.
  async #ensureVerified() {
    if (this._verified) return;
    if (!this._verifying)
      this._verifying = verifyCbmBinary(this.bin).then((r) => {
        if (!r.ok) throw new Error(r.message);
        this._verified = true;
      });
    return this._verifying;
  }

  // One --version probe per instance; short-circuited by PI_CBM_SKIP_VERSION_CHECK.
  async checkVersion() {
    if (this.skipVersionCheck) return { status: "ok" };
    if (this._version) return this._version;
    const out = await this._spawn(["--version"], undefined, 15_000).catch(() => ({ stdout: "" }));
    this._version = evaluateCbmVersion(parseCbmVersion(out.stdout));
    return this._version;
  }

  // Every exec goes through here, so the sha256 pin is enforced before any
  // child process starts (including --version and config).
  _spawn(argv, stdin, timeoutMs) {
    return this.#ensureVerified().then(() => this.#rawSpawn(argv, stdin, timeoutMs));
  }

  // Acquire a global engine slot, then spawn; always release the slot. The gate
  // bounds how many engine processes exist at once (see MAX_ENGINE_PROCS).
  async #rawSpawn(argv, stdin, timeoutMs) {
    await acquireEngineSlot();
    try {
      return await this.#execSpawn(argv, stdin, timeoutMs);
    } finally {
      releaseEngineSlot();
    }
  }

  #execSpawn(argv, stdin, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, argv, {
        stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
        env: this.childEnv(),
      });
      if (stdin !== undefined) {
        child.stdin.on("error", () => {});
        child.stdin.end(stdin);
      }
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled && !child.killed) child.kill("SIGTERM");
      }, timeoutMs);
      child.stdout.on("data", (c) => {
        stdout += c.toString("utf8");
        if (Buffer.byteLength(stdout, "utf8") > MAX_STDIO_BYTES) {
          child.kill("SIGTERM");
          reject(new Error("codebase-memory-mcp stdout exceeded limit"));
        }
      });
      child.stderr.on("data", (c) => {
        stderr += c.toString("utf8");
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code, signal) => {
        settled = true;
        clearTimeout(timer);
        resolve({ code, signal, stdout, stderr });
      });
    });
  }

  // Run one engine tool. Returns { ok, data, rawText, stderr }. `data` is
  // normalized (tables expanded to object arrays). `allowError` keeps a
  // tool-level error as data instead of throwing.
  async callTool(toolName, args = {}, { allowError = false, timeoutMs = this.timeoutMs } = {}) {
    const version = await this.checkVersion();
    if (version.status === "too-old") throw new Error(version.message ?? "codebase-memory-mcp is unsupported");

    const argv = ["cli", "--json", toolName];
    let stdin;
    if (toolName === "list_projects") {
      argv.push("--format", "json");
      for (const flag of ["limit", "offset"]) {
        const v = args[flag];
        if (typeof v === "number" && Number.isInteger(v)) argv.push(`--${flag}`, String(v));
      }
    } else {
      stdin = JSON.stringify({ format: "json", ...args });
    }

    const { code, signal, stdout, stderr } = await this._spawn(argv, stdin, timeoutMs);
    if (signal) throw new Error(`codebase-memory-mcp ${toolName} terminated by ${signal}`);
    if (code !== 0 && !stdout.trim()) throw new Error(`codebase-memory-mcp ${toolName} failed (exit ${code}): ${stderr.trim()}`);

    const { envelope, text } = parseCbmEnvelope(stdout);
    const data = normalizeCbmData(parseMaybeJson(text));
    const ok = envelope.isError !== true;
    if (!ok && !allowError) throw new Error(`codebase-memory-mcp ${toolName}: ${errorText(data)}`);
    return { ok, data, rawText: text, stderr };
  }

  // Index a repository out of band (NOT an agent tool). mode "fast" is the
  // quick graph build; the engine excludes the cache dir automatically.
  async index(repoPath, { name, mode = "fast", timeoutMs = 300_000 } = {}) {
    const args = removeUndefined({ repo_path: repoPath, name, mode });
    const r = await this.callTool("index_repository", args, { timeoutMs });
    return r.data;
  }

  async listProjects({ limit, offset } = {}) {
    const r = await this.callTool("list_projects", removeUndefined({ limit, offset }));
    return r.data;
  }

  // Run an engine `config` subcommand. This is NOT a `cli --json` tool; it is a
  // top-level subcommand that prints plain text and persists into this
  // instance's (private) CBM_CACHE_DIR via childEnv.
  async config(args, { timeoutMs = 15_000 } = {}) {
    const { code, signal, stdout, stderr } = await this._spawn(["config", ...args], undefined, timeoutMs);
    if (signal) throw new Error(`codebase-memory-mcp config terminated by ${signal}`);
    if (code !== 0) throw new Error(`codebase-memory-mcp config ${args.join(" ")} failed (exit ${code}): ${(stderr || stdout).trim()}`);
    return stdout;
  }

  // Turn off every served/background surface in this private cache BEFORE any
  // index or query. In a FRESH cache the engine serves its loopback UI/admin
  // HTTP server on 127.0.0.1:9749 by default (despite the --help text claiming
  // ui_enabled defaults false) and runs an auto-reindex watcher thread. A
  // query-only hunter needs neither; disabling them keeps the engine to pure
  // one-shot reads with no listener and no background writes. Idempotent.
  async hardenCache() {
    await this.config(["set", "ui_enabled", "false"]);
    await this.config(["set", "watcher_enabled", "false"]);
    await this.config(["set", "auto_watch", "false"]);
    await this.config(["set", "auto_index", "false"]);
  }

  // ---- the five read-only query tools (pi-cbm src/domain/symbols.ts) ----

  async resolveSymbol(params) {
    const resolution = await this.#resolveCandidates(params);
    return renderSymbolResolution(resolution, params);
  }

  async readSymbol(params) {
    const resolution = await this.#resolveCandidates(params);
    if (resolution.candidates.length !== 1) return renderSymbolResolution(resolution, params); // fail closed on ambiguity
    const candidate = resolution.candidates[0];
    const read = await this.#readQualifiedName(String(candidate.qualified_name), resolution.project, params, false);
    const neighbors = await this.#symbolNeighbors(String(candidate.qualified_name), resolution.project, params);
    const resolved = compactResolveCandidate(candidate, params.include_metadata === true);
    const snippet = isRecord(read) ? read : { snippet: read };
    return { resolved, ...snippet, ...neighbors };
  }

  async getCodeSnippets(params) {
    const qualifiedNames = stringsArrayParam(params.qualified_names, "qualified_names", 50);
    const project = requireProject(params);
    const concurrency = clampInt(params.max_concurrency, 8, 1, 16);
    const results = await mapLimit(qualifiedNames, concurrency, async (qn, index) => {
      try {
        return { index, qualified_name: qn, status: "ok", snippet: await this.#readQualifiedName(qn, project, params, true) };
      } catch (e) {
        return { index, qualified_name: qn, status: "error", error: errorText(e) };
      }
    });
    return {
      project,
      requested_count: qualifiedNames.length,
      returned_count: results.filter((r) => r.status === "ok").length,
      failed_count: results.filter((r) => r.status === "error").length,
      max_concurrency: concurrency,
      results,
    };
  }

  async readSymbols(params) {
    const requests = symbolRequestsParam(params.symbols);
    const project = requireProject(params);
    const concurrency = clampInt(params.max_concurrency, 4, 1, 12);
    const results = await mapLimit(requests, concurrency, async (request, index) => {
      try {
        return await this.#readOneSymbol(request, project, params, index);
      } catch (e) {
        return { index, request, status: "error", error: errorText(e) };
      }
    });
    return {
      project,
      requested_count: requests.length,
      read_count: results.filter((r) => r.status === "ok").length,
      max_concurrency: concurrency,
      ...statusCounts(results),
      results,
    };
  }

  async searchAndReadSymbols(params) {
    if (!hasSearchInput(params))
      throw new Error("search_and_read_symbols requires query, name_pattern, qn_pattern, file_pattern, or semantic_query.");
    const project = requireProject(params);
    const searchLimit = clampInt(params.search_limit, 12, 1, 50);
    const readLimit = clampInt(params.read_limit, Math.min(searchLimit, 8), 1, 20);
    const concurrency = clampInt(params.max_concurrency, 6, 1, 16);
    const includeMetadata = params.include_metadata === true;

    const search = await this.callTool(
      "search_graph",
      removeUndefined({
        project,
        query: params.query,
        name_pattern: params.name_pattern,
        qn_pattern: params.qn_pattern,
        file_pattern: params.file_pattern,
        label: params.label,
        semantic_query: params.semantic_query,
        limit: searchLimit,
        fields: SEARCH_GRAPH_FIELDS,
      }),
    );
    const candidates = dedupeCandidates(allSearchCandidates(search.data));
    const selected = candidates.slice(0, Math.min(readLimit, candidates.length));
    const reads = await mapLimit(selected, concurrency, async (candidate, rank) => {
      const base = { rank, qualified_name: candidate.qualified_name, search_result: compactResolveCandidate(candidate, includeMetadata) };
      try {
        return { ...base, status: "ok", snippet: await this.#readQualifiedName(String(candidate.qualified_name), project, params, true) };
      } catch (e) {
        return { ...base, status: "error", error: errorText(e) };
      }
    });
    return {
      project,
      search: {
        query: params.query,
        name_pattern: params.name_pattern,
        qn_pattern: params.qn_pattern,
        file_pattern: params.file_pattern,
        label: params.label,
        search_limit: searchLimit,
        read_limit: Math.min(readLimit, candidates.length),
        total_candidates: candidates.length,
      },
      max_concurrency: concurrency,
      read_count: reads.filter((r) => r.status === "ok").length,
      ...statusCounts(reads),
      results: reads,
      unread_candidates: candidates.slice(selected.length).map((c, i) => ({ rank: selected.length + i, ...compactResolveCandidate(c, includeMetadata) })),
    };
  }

  // ---- private composition ----

  async #resolveCandidates(params) {
    const project = requireProject(params);
    const name = typeof params.name === "string" ? params.name.trim() : "";
    const qualifiedName = typeof params.qualified_name === "string" ? params.qualified_name.trim() : "";

    const searches = [];
    if (qualifiedName) searches.push({ qn_pattern: `.*${escapeRegExp(qualifiedName)}.*` });
    if (name) {
      searches.push({ name_pattern: `^${escapeRegExp(name)}$` });
      searches.push({ qn_pattern: `.*${escapeRegExp(name)}.*` });
      searches.push({ query: name });
    }
    if (searches.length === 0) throw new Error("resolve_symbol/read_symbol requires name or qualified_name.");

    const results = await Promise.all(
      searches.map((search) =>
        // Search breadth is a FIXED internal bound, never caller-controlled: a
        // caller must not be able to shrink the candidate set to slip past the
        // ambiguity gate (read_symbol fails closed on >1 match). See below.
        this.callTool("search_graph", removeUndefined({ project, limit: RESOLVE_SEARCH_BREADTH, fields: SEARCH_GRAPH_FIELDS, ...search }), {
          allowError: true,
        }),
      ),
    );
    // Every lookup failing is a contract error (bad project/regex), not an empty set.
    if (results.every((r) => !r.ok)) throw new Error(`codebase-memory-mcp search_graph: ${errorText(results[0].data)}`);

    const candidates = results.flatMap((r) => (r.ok ? allSearchCandidates(r.data) : []));
    const deduped = dedupeCandidates(candidates);
    // Ambiguity is judged on the FULL filtered set — no limit slice here. The
    // caller cannot pass a limit to collapse a multi-match down to one.
    const filtered = filterCandidates(deduped, params);
    const enriched = await this.#enrichLocations(filtered, project, params);
    return { project, query: symbolQuery(params), candidates: enriched, consideredCandidates: deduped.length };
  }

  async #enrichLocations(candidates, project, params) {
    const cache = new Map();
    return Promise.all(
      candidates.map(async (c) => {
        if (hasLocation(c) || !c.qualified_name) return c;
        let req = cache.get(c.qualified_name);
        if (!req) {
          req = (async () => {
            const r = await this.callTool("get_code_snippet", { project, qualified_name: c.qualified_name }, { allowError: true });
            if (!r.ok || !isRecord(r.data)) return {};
            const s = r.data;
            return removeUndefined({
              file_path: s.file_path ?? s.file ?? s.path,
              start_line: numberProp(s, "start_line"),
              end_line: numberProp(s, "end_line"),
              signature: s.signature,
              parent_class: s.parent_class,
              return_type: s.return_type,
            });
          })();
          cache.set(c.qualified_name, req);
        }
        return { ...c, ...removeUndefined(await req) };
      }),
    );
  }

  async #readQualifiedName(qualifiedName, project, params, includeNeighbors) {
    const args = removeUndefined({ project, qualified_name: qualifiedName, include_neighbors: includeNeighbors ? params.include_neighbors : undefined });
    const snippet = await this.callTool("get_code_snippet", args, { allowError: true });
    if (!snippet.ok) throw new Error(`codebase-memory-mcp get_code_snippet: ${errorText(snippet.data)}`);
    return isRecord(snippet.data) ? snippet.data : { snippet: snippet.data };
  }

  async #readOneSymbol(request, project, params, index) {
    const resolution = await this.#resolveCandidates({ ...params, ...request, project });
    const includeMetadata = params.include_metadata === true;
    if (resolution.candidates.length === 0)
      return { index, request, status: "not_found", query: resolution.query, considered_candidates: resolution.consideredCandidates };
    if (resolution.candidates.length !== 1)
      return {
        index,
        request,
        status: "ambiguous",
        query: resolution.query,
        considered_candidates: resolution.consideredCandidates,
        candidates: resolution.candidates.map((c) => compactResolveCandidate(c, includeMetadata)),
      };
    const candidate = resolution.candidates[0];
    const snippet = await this.#readQualifiedName(String(candidate.qualified_name), project, params, false);
    const neighbors = await this.#symbolNeighbors(String(candidate.qualified_name), project, params);
    return { index, request, status: "ok", resolved: compactResolveCandidate(candidate, includeMetadata), snippet: { ...snippet, ...neighbors } };
  }

  async #symbolNeighbors(qualifiedName, project, params) {
    const neighbors = requestedNeighbors(params);
    const direction = neighborDirection(neighbors);
    if (!direction) return {};
    const limit = clampInt(params.neighbor_limit, 10, 1, 50);
    const trace = await this.callTool(
      "trace_path",
      { project, function_name: qualifiedName, direction, mode: "calls", depth: 1, risk_labels: false },
      { allowError: true },
    );
    if (!trace.ok) return { neighbors_error: errorText(trace.data) };
    const includeMetadata = params.include_metadata === true;
    const pick = async (key) => {
      if (!isRecord(trace.data) || !Array.isArray(trace.data[key])) return undefined;
      const cand = trace.data[key].slice(0, limit).map((i) => (isRecord(i) ? i : { name: String(i) }));
      return (await this.#enrichLocations(cand, project, params)).map((c) => compactResolveCandidate(c, includeMetadata));
    };
    const callers = neighbors === "callers" || neighbors === "both" ? await pick("callers") : undefined;
    const callees = neighbors === "callees" || neighbors === "both" ? await pick("callees") : undefined;
    return removeUndefined({ neighbors, neighbor_limit: limit, callers, callees, caller_count: callers?.length, callee_count: callees?.length });
  }
}

// ---------------------------------------------------------------------------
// pure shaping helpers (pi-cbm src/domain/symbols.ts) — no I/O
// ---------------------------------------------------------------------------

const SEARCH_GRAPH_FIELDS = ["signature", "parent_class", "start_line", "end_line"];
// Fixed breadth for resolve/read symbol graph searches. NOT caller-controlled —
// the ambiguity gate must see every match, so a caller cannot narrow it away.
const RESOLVE_SEARCH_BREADTH = 100;

function requireProject(params) {
  const p = typeof params.project === "string" ? params.project.trim() : "";
  if (!p) throw new Error("a project name is required (index a repo first, then pass its project).");
  return p;
}
function searchResultRows(data, tool) {
  if (Array.isArray(data)) return data;
  if (isRecord(data) && Array.isArray(data.results)) return data.results;
  const keys = isRecord(data) ? Object.keys(data).join(", ") || "(none)" : typeof data;
  throw new Error(`codebase-memory-mcp ${tool} returned an unrecognized shape: expected results array, got keys: ${keys}.`);
}
function allSearchCandidates(data, tool = "search_graph") {
  return searchResultRows(data, tool).filter((i) => isRecord(i) && typeof i.qualified_name === "string");
}
function dedupeCandidates(candidates) {
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    if (!c.qualified_name || seen.has(c.qualified_name)) continue;
    seen.add(c.qualified_name);
    out.push(c);
  }
  return out;
}
const candidateFilePath = (c) => stringProp(c, "file_path") ?? stringProp(c, "file") ?? stringProp(c, "path");
const candidateRouteMethod = (c) => stringProp(c, "route_method") ?? stringProp(c, "http_method") ?? stringProp(c, "method");
const candidateMatchesName = (c, name) => c.name === name || c.qualified_name === name || c.qualified_name?.endsWith(`.${name}`) === true;

function filterCandidates(candidates, params) {
  let result = candidates;
  const qn = stringProp(params, "qualified_name");
  if (qn) result = result.filter((c) => c.qualified_name === qn || c.qualified_name?.endsWith(`.${qn}`));
  const name = stringProp(params, "name");
  if (name) {
    const exact = result.filter((c) => candidateMatchesName(c, name));
    if (exact.length > 0) result = exact;
  }
  const label = stringProp(params, "label");
  if (label) result = result.filter((c) => c.label === label || (label === "Route" && c.route_path));
  const filePath = stringProp(params, "file_path") ? normalizeForMatch(params.file_path.trim()) : undefined;
  if (filePath)
    result = result.filter((c) => {
      const p = candidateFilePath(c);
      if (!p) return false;
      const n = normalizeForMatch(p);
      return n === filePath || n.endsWith(filePath) || n.includes(filePath);
    });
  const parentClass = stringProp(params, "parent_class");
  if (parentClass) result = result.filter((c) => c.parent_class === parentClass || c.qualified_name?.includes(`.${parentClass}.`) === true);
  const routePath = stringProp(params, "route_path");
  if (routePath) result = result.filter((c) => c.route_path === routePath || stringProp(c, "path_pattern") === routePath);
  const routeMethod = stringProp(params, "route_method") ? params.route_method.trim().toUpperCase() : undefined;
  if (routeMethod) result = result.filter((c) => candidateRouteMethod(c)?.toUpperCase() === routeMethod);
  return result;
}
function compactResolveCandidate(c, includeMetadata) {
  if (includeMetadata) return c;
  return removeUndefined({
    name: c.name,
    qualified_name: c.qualified_name,
    label: c.label,
    file_path: candidateFilePath(c),
    start_line: numberProp(c, "start_line"),
    end_line: numberProp(c, "end_line"),
    parent_class: c.parent_class,
    signature: c.signature,
    return_type: c.return_type,
    route_path: c.route_path,
    route_method: candidateRouteMethod(c),
  });
}
const symbolQuery = (p) =>
  removeUndefined({ name: p.name, qualified_name: p.qualified_name, file_path: p.file_path, parent_class: p.parent_class, label: p.label, route_path: p.route_path, route_method: p.route_method });
const hasLocation = (c) => typeof candidateFilePath(c) === "string" && numberProp(c, "start_line") !== undefined && numberProp(c, "end_line") !== undefined;

function renderSymbolResolution(resolution, params) {
  const includeMetadata = params.include_metadata === true;
  const candidates = resolution.candidates.map((c) => compactResolveCandidate(c, includeMetadata));
  if (candidates.length === 0)
    return {
      error: "symbol not found",
      query: resolution.query,
      total_candidates: 0,
      considered_candidates: resolution.consideredCandidates,
      hint: "Try search_and_read_symbols with a broader query or fewer disambiguators.",
    };
  return {
    query: resolution.query,
    total_candidates: candidates.length,
    considered_candidates: resolution.consideredCandidates,
    ambiguous: candidates.length !== 1,
    hint: candidates.length === 1 ? undefined : "Multiple matches. Retry with file_path, parent_class, label, route_path, route_method, or qualified_name.",
    candidates,
  };
}
function requestedNeighbors(params) {
  if (params.include_neighbors === true) return "both";
  if (params.neighbors === "callers" || params.neighbors === "callees" || params.neighbors === "both") return params.neighbors;
  return "none";
}
const neighborDirection = (n) => (n === "callers" ? "inbound" : n === "callees" ? "outbound" : n === "both" ? "both" : undefined);
function hasSearchInput(params) {
  return (
    [params.query, params.name_pattern, params.qn_pattern, params.file_pattern].some((v) => typeof v === "string" && v.trim()) ||
    (Array.isArray(params.semantic_query) && params.semantic_query.some((v) => typeof v === "string" && v.trim()))
  );
}
function stringsArrayParam(value, name, max) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array of strings.`);
  const items = value.map((i) => (typeof i === "string" ? i.trim() : "")).filter(Boolean);
  if (items.length === 0) throw new Error(`${name} must include at least one non-empty string.`);
  if (items.length > max) throw new Error(`${name} supports at most ${max} entries per call.`);
  return items;
}
function symbolRequestsParam(value) {
  if (!Array.isArray(value)) throw new Error("symbols must be an array of symbol request objects.");
  if (value.length === 0) throw new Error("symbols must include at least one request.");
  if (value.length > 30) throw new Error("symbols supports at most 30 entries per call.");
  return value.map((item, i) => {
    if (!isRecord(item)) throw new Error(`symbols[${i}] must be an object.`);
    const request = removeUndefined({
      name: item.name,
      qualified_name: item.qualified_name,
      file_path: item.file_path,
      parent_class: item.parent_class,
      label: item.label,
      route_path: item.route_path,
      route_method: item.route_method,
    });
    if (typeof request.name !== "string" && typeof request.qualified_name !== "string")
      throw new Error(`symbols[${i}] must include name or qualified_name.`);
    return request;
  });
}
function statusCounts(results) {
  const counts = {};
  for (const r of results) {
    const status = typeof r.status === "string" ? r.status : "unknown";
    counts[`${status}_count`] = (counts[`${status}_count`] ?? 0) + 1;
  }
  return counts;
}
