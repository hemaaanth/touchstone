// Host-side source fetch for brief scopes.
//
// WHY HOST-SIDE. The Foundry sandbox runs with --network none, so it cannot pull
// code itself. A brief names its sources as links; the engine fetches them here,
// on the host, into the run's workspace under vendor/, and only then does the
// offline sandbox compile and prove against them. The proof still happens with no
// network and no live chain — fetching is just how the code gets onto disk.
//
// WHY THE GUARDS. The agent picks the URL, so the URL is untrusted. These guards
// keep a fetch from reaching into the machine or running away:
//   - Member binding. A URL is fetched only when it is one of the run's member
//     links in .touchstone.json, compared after normalization. The agent cannot
//     name a URL of its own.
//   - Host allowlist. Only github.com (clone) and raw.githubusercontent.com
//     (single file) are ever contacted, over TLS. No other host, so a DNS answer
//     for an attacker-chosen name never matters (no DNS rebinding). The resolved
//     address of an allowlisted host must still be public, redirects are refused,
//     and git does not follow redirects.
//   - Collision-free paths. Each member lands in its own folder, named by its
//     full owner/repo and ref, so two members never overwrite each other.
//   - Content filters and caps. A clone is pruned like an uploaded folder
//     (dependency and build folders, non-source, secret names and secret
//     content), then the scope's fetched code must fit the same caps as uploads.
//   - Size and time caps on every path, so a huge repo or a slow host cannot hang
//     or fill the disk.
//   - git runs with prompts disabled, hooks disabled, and only the https
//     protocol allowed, so a clone cannot execute a hook or follow a file:// or
//     ssh:// submodule off the machine.
import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { classifyPath, githubRepoUrl, safeRelPath, secretContent, MAX_BYTES, MAX_FILES, MAX_MEMBERS } from "./scopes-store.mjs";
import { event } from "./event.mjs";

// The only hosts a fetch ever contacts. api.github.com serves the read-only
// GitHub API reads of the supply-chain live path (githubGet below). fetchSource
// never builds an api.github.com URL, so it cannot reach it.
const ALLOWED_HOSTS = new Set(["github.com", "raw.githubusercontent.com", "api.github.com"]);

const FILE_CAP = 2 * 1024 * 1024; // 2 MB — a single source file
const REPO_CAP = 300 * 1024 * 1024; // 300 MB — a cloned repo on disk
const FETCH_TIMEOUT_MS = 20_000;
const CLONE_TIMEOUT_MS = 90_000;

// --- SSRF guard: the resolved address must be a public one. ------------------

// True for addresses we refuse to connect to: loopback, private LAN, link-local,
// carrier-grade NAT, IPv6 loopback / link-local / unique-local, and anything
// unspecified. Covers both the raw IP a link may use directly and the address a
// hostname resolves to.
function isBlockedAddress(addr) {
  const fam = isIP(addr);
  if (fam === 4) {
    const p = addr.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = p;
    if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (fam === 6) {
    const a = addr.toLowerCase().replace(/^\[|\]$/g, "");
    if (a === "::" || a === "::1") return true; // unspecified, loopback
    if (a.startsWith("fe80") || a.startsWith("fe9") || a.startsWith("fea") || a.startsWith("feb")) return true; // link-local
    if (a.startsWith("fc") || a.startsWith("fd")) return true; // unique-local
    // IPv4-mapped (::ffff:a.b.c.d) — re-check the embedded v4.
    const m = a.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isBlockedAddress(m[1]);
    return false;
  }
  return true; // not a recognizable IP literal
}

// Resolve a hostname to every address and refuse if ANY is blocked (defends
// against a DNS answer that mixes a public and a private address). A bare IP
// hostname is checked directly without a lookup.
async function assertPublicHost(hostname) {
  if (!ALLOWED_HOSTS.has(hostname)) throw new Error(`refused host ${hostname}: only github.com, raw.githubusercontent.com and api.github.com are fetched`);
  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) throw new Error(`refused non-public address: ${hostname}`);
    return;
  }
  let addrs;
  try {
    addrs = await lookup(hostname, { all: true });
  } catch {
    throw new Error(`could not resolve host: ${hostname}`);
  }
  if (!addrs.length) throw new Error(`host resolved to nothing: ${hostname}`);
  for (const { address } of addrs) {
    if (isBlockedAddress(address)) throw new Error(`host ${hostname} resolves to a non-public address (${address}) — refused`);
  }
}

function parseUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`not a URL: ${raw}`);
  }
  if (u.protocol !== "https:") throw new Error(`only https:// is allowed, got ${u.protocol}//`);
  return u;
}

// --- GitHub URL shapes -------------------------------------------------------

// Recognize the GitHub URLs we support and pull out the parts we need:
//   https://github.com/<owner>/<repo>                       -> repo (default branch)
//   https://github.com/<owner>/<repo>/tree/<ref>            -> repo at ref
//   https://github.com/<owner>/<repo>/tree/<ref>/<folder>   -> one folder of the repo at ref
//   https://github.com/<owner>/<repo>/blob/<ref>/<path>     -> single file
// A folder URL is how an operator audits a large repo in parts: only that folder
// is kept, and only it counts toward the scope caps. A ref that holds a "/"
// cannot be told apart from a folder, so the first segment after tree/ is the ref.
// Anything else is refused.
function parseGithub(u) {
  if (u.hostname !== "github.com") return null;
  const seg = u.pathname.split("/").filter(Boolean);
  if (seg.length < 2) return null;
  const [owner, repoRaw] = seg;
  const repo = repoRaw.replace(/\.git$/, "");
  if (seg.length === 2) return { kind: "repo", owner, repo, ref: null };
  const kind = seg[2];
  if (kind === "tree" && seg.length >= 4) {
    let subPath = null;
    if (seg.length > 4) {
      try { subPath = decodeURIComponent(seg.slice(4).join("/")); } catch { subPath = seg.slice(4).join("/"); }
    }
    return { kind: "repo", owner, repo, ref: seg[3], subPath };
  }
  if (kind === "blob" && seg.length >= 5) {
    const ref = seg[3];
    const filePath = seg.slice(4).join("/");
    return { kind: "blob", owner, repo, ref, filePath };
  }
  return null;
}

// --- member binding -----------------------------------------------------------

// One canonical form for a member URL: the scopes-store GitHub form (https,
// github.com, no credentials, port, query or fragment), with no trailing "/" or
// ".git". Returns null for anything that is not a GitHub repo, tree or blob URL.
export function memberUrl(raw) {
  try {
    return githubRepoUrl(String(raw ?? "").trim()).replace(/\/+$/, "").replace(/\.git$/, "");
  } catch {
    return null;
  }
}

// The run's member links, from .touchstone.json, normalized. At most
// MAX_MEMBERS, in the order the scope lists them.
export function memberLinks(ws) {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(path.join(ws, ".touchstone.json"), "utf8")); } catch {}
  const links = Array.isArray(cfg.links) ? cfg.links : [];
  return [...new Set(links.map(memberUrl).filter(Boolean))].slice(0, MAX_MEMBERS);
}

// A ref or owner/repo part that is safe as one path segment.
const SEGMENT = /^[A-Za-z0-9_][\w.-]*$/;

// Where a member lands, relative to the workspace. Named by full owner/repo and
// ref, so two members that share a repo name or a file name never collide:
//   repo   -> vendor/<owner>__<repo>[@<ref>]
//   folder -> vendor/<owner>__<repo>@<ref>/<folder in the repo>
//   blob   -> vendor/files/<owner>__<repo>[@<ref>]/<path in the repo>
// Two folder members of one repo and ref land side by side in one slot.
// GitHub owners have no "_" and repo names have no "@", so the name is unique.
export function memberDest(gh) {
  for (const part of [gh.owner, gh.repo, ...(gh.ref ? [gh.ref] : [])]) {
    if (!SEGMENT.test(part)) throw new Error(`refused an unsafe repo name or ref: ${part}`);
  }
  const slot = `${gh.owner}__${gh.repo}${gh.ref ? `@${gh.ref}` : ""}`;
  if (gh.kind === "blob") {
    if (!safeRelPath(gh.filePath)) throw new Error(`refused an unsafe file path: ${gh.filePath}`);
    return path.posix.join("vendor", "files", slot, gh.filePath);
  }
  if (gh.subPath != null) {
    if (!safeRelPath(gh.subPath)) throw new Error(`refused an unsafe folder path: ${gh.subPath}`);
    return path.posix.join("vendor", slot, gh.subPath);
  }
  return path.posix.join("vendor", slot);
}

// --- helpers -----------------------------------------------------------------

// Every pragma version string a .sol body declares, e.g. "^0.8.19". Reported so
// the caller knows which solc the fetched code expects.
export function pragmaVersions(sol) {
  const out = new Set();
  for (const m of String(sol).matchAll(/pragma\s+solidity\s+([^;]+);/g)) out.add(m[1].trim());
  return [...out];
}

// Recursively size a directory, bailing as soon as it passes the cap so we never
// walk an enormous tree in full.
function dirSizeOver(dir, cap) {
  let total = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      const st = lstatSync(p); // never follow a link out of the clone
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) total += st.size;
      if (total > cap) throw new Error("over cap");
    }
  };
  try {
    walk(dir);
    return false;
  } catch {
    return true;
  }
}

// Remove what a run must never read from a fresh clone. Uses lstat, so it never
// follows a link. Dropped:
//   - symlinks (they can point out of the workspace) and hidden entries (.env,
//     .npmrc, .github, ...);
//   - every file an uploaded folder would drop (classifyPath): dependency and
//     build folders, our sandbox config, secret names, non-source files;
//   - text whose content looks like a secret (a private key block, a cloud key,
//     a token), and binary content.
// Returns how many entries it removed.
export function pruneClone(dir) {
  let removed = 0;
  const files = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink() || name.startsWith(".") || (!st.isFile() && !st.isDirectory())) {
        rmSync(p, { recursive: true, force: true });
        removed++;
      } else if (st.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dir);
  const rels = files.map((p) => path.relative(dir, p).split(path.sep).join("/"));
  const solidity = rels.some((r) => r.endsWith(".sol"));
  files.forEach((p, i) => {
    let drop = classifyPath(rels[i], { solidity }) !== "keep";
    if (!drop) {
      // Over the per-file cap is dropped unread; the scope cap counts the rest.
      if (statSync(p).size > FILE_CAP) drop = true;
      else {
        const body = readFileSync(p, "utf8");
        drop = body.includes("\u0000") || secretContent(body);
      }
    }
    if (drop) {
      rmSync(p, { force: true });
      removed++;
    }
  });
  return removed;
}

// The files and bytes of everything fetched into vendor/ plus the scope's own
// folders under src/. This is the scope total the caps apply to.
export function scopeUsage(ws) {
  const use = { files: 0, bytes: 0 };
  const walk = (d) => {
    let names;
    try { names = readdirSync(d); } catch { return; }
    for (const name of names) {
      const p = path.join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) { use.files++; use.bytes += st.size; }
    }
  };
  walk(path.join(ws, "src"));
  walk(path.join(ws, "vendor"));
  return use;
}

// How many files sit under a directory (a file counts as 1). Never follows a link.
function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    let st;
    try { st = lstatSync(d); } catch { return; }
    if (st.isFile()) { n++; return; }
    if (!st.isDirectory()) return;
    for (const name of readdirSync(d)) walk(path.join(d, name));
  };
  walk(dir);
  return n;
}

// The folders of a fetched tree that an operator could list as separate folder
// members, largest first. A folder over the file cap is split into its own
// subfolders (a few levels deep), so the list names parts that can fit.
function largestFolders(root, limit = 5) {
  const subdirs = (rel) => {
    try {
      return readdirSync(path.join(root, rel)).map((n) => (rel ? `${rel}/${n}` : n)).filter((r) => lstatSync(path.join(root, r)).isDirectory());
    } catch { return []; }
  };
  let rows = subdirs("").map((rel) => ({ rel, files: countFiles(path.join(root, rel)) }));
  for (let depth = 0; depth < 4; depth++) {
    const next = rows.flatMap((r) => {
      if (r.files <= MAX_FILES) return [r];
      const kids = subdirs(r.rel).map((rel) => ({ rel, files: countFiles(path.join(root, rel)) })).filter((k) => k.files > 0);
      return kids.length ? kids : [r];
    });
    if (next.length === rows.length) break;
    rows = next;
  }
  return rows.filter((r) => r.files > 0).sort((a, b) => b.files - a.files || a.rel.localeCompare(b.rel)).slice(0, limit);
}

// What an operator can do about a repo or folder that is over the caps: the
// member's own file count, its largest folders, and folder URLs to use instead.
function splitAdvice(dest, gh, over = "files") {
  const own = countFiles(dest);
  const base = gh.subPath ? `${gh.subPath}/` : "";
  const ref = gh.ref ?? gh.headRef ?? "<branch>";
  const top = largestFolders(dest);
  const lines = [`This member alone has ${own} source file${own === 1 ? "" : "s"} after filtering.`];
  if (top.length) lines.push(`Largest folders: ${top.map((r) => `${base}${r.rel} (${r.files})`).join(", ")}.`);
  const example = top.find((r) => r.files <= MAX_FILES)?.rel ?? top[0]?.rel ?? "<folder>";
  const limit = over === "files" ? `${MAX_FILES} source files` : `${MAX_BYTES / 1024 / 1024} MB of source`;
  lines.push(`The whole scope (every member together) must stay under ${limit}. To audit it, edit the scope and replace this member with folder URLs that together fit, for example https://github.com/${gh.owner}/${gh.repo}/tree/${ref}/${base}${example} — each folder URL is fetched on its own, and a folder still over the cap must be split further.`);
  return lines.join(" ");
}

// Refuse (and remove) a fetch that pushes the scope over the upload caps.
// `advice` is extra text that says what the operator can do.
function enforceCaps(ws, dest, label, advice = null) {
  const use = scopeUsage(ws);
  if (use.files > MAX_FILES || use.bytes > MAX_BYTES) {
    const tip = advice ? ` ${advice(use.files > MAX_FILES ? "files" : "bytes")}` : "";
    rmSync(dest, { recursive: true, force: true });
    const what = use.files > MAX_FILES ? `${use.files} source files (the cap is ${MAX_FILES})` : `${(use.bytes / 1024 / 1024).toFixed(1)} MB of source (the cap is ${MAX_BYTES / 1024 / 1024} MB)`;
    throw new Error(`${label} would bring this scope to ${what} after filtering — refused.${tip}`);
  }
}

function execFileP(cmd, args, opts) {
  return new Promise((resolve) => {
    execFile(cmd, args, opts, (err, stdout, stderr) =>
      resolve({ err, stdout: String(stdout), stderr: String(stderr), timedOut: err?.killed === true }),
    );
  });
}

// Collect the .sol files under a directory as ws-relative report rows with their
// pragmas. Capped in count so a giant repo does not produce an unbounded report.
function reportSolFiles(ws, dir, cap = 200) {
  const rows = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (rows.length >= cap) return;
      if (name === ".git" || name === "node_modules") continue;
      const p = path.join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".sol")) {
        let pragmas = [];
        try {
          pragmas = pragmaVersions(readFileSync(p, "utf8"));
        } catch {}
        rows.push({ path: path.relative(ws, p), pragmas });
      }
    }
  };
  walk(dir);
  return rows;
}

// --- the fetchers ------------------------------------------------------------

// The branch a clone checked out, from .git/HEAD, or null. Used only in advice text.
function headBranch(clone) {
  try {
    const m = readFileSync(path.join(clone, ".git", "HEAD"), "utf8").match(/^ref: refs\/heads\/(\S+)/);
    return m && SEGMENT.test(m[1]) ? m[1] : null;
  } catch { return null; }
}

// Clone a repo into a temporary folder in the workspace, keep the whole tree or
// only the member's folder, prune it, and move it into place. The temporary
// folder is hidden and outside src/ and vendor/, so the agent never sees it and
// the caps never count it, and it is always removed.
async function fetchRepo(ws, gh) {
  await assertPublicHost("github.com");
  const rel = memberDest(gh);
  const dest = path.join(ws, rel);
  const label = `${gh.owner}/${gh.repo}${gh.subPath ? `/tree/${gh.ref}/${gh.subPath}` : ""}`;
  const cloneUrl = `https://github.com/${gh.owner}/${gh.repo}.git`;
  const tmp = mkdtempSync(path.join(ws, ".fetch-"));
  const clone = path.join(tmp, "repo");
  let dropped;
  try {
    const args = [
      "-c", "protocol.allow=never",
      "-c", "protocol.https.allow=always",
      "-c", "core.hooksPath=/dev/null",
      "-c", "http.followRedirects=false",
      "clone", "--depth", "1", "--no-tags", "--single-branch",
    ];
    if (gh.ref) args.push("--branch", gh.ref);
    args.push(cloneUrl, clone);
    const r = await execFileP("git", args, {
      timeout: CLONE_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", HOME: ws },
    });
    if (r.err) {
      const why = r.timedOut ? "clone timed out" : r.stderr.trim().split("\n").slice(-1)[0] || "clone failed";
      throw new Error(`could not clone ${gh.owner}/${gh.repo}: ${why}`);
    }
    gh = { ...gh, headRef: headBranch(clone) };
    // Drop .git first — we keep the tree, not its history. A raw clone over the
    // disk cap is refused before we read it.
    rmSync(path.join(clone, ".git"), { recursive: true, force: true });
    if (dirSizeOver(clone, REPO_CAP)) throw new Error(`clone of ${gh.owner}/${gh.repo} exceeds the ${Math.round(REPO_CAP / 1024 / 1024)}MB cap — refused`);
    // A folder member keeps only its folder. Every part of the path must be a
    // real folder, never a link, so a link cannot pull in a path outside it.
    let keep = clone;
    if (gh.subPath) {
      for (const part of gh.subPath.split("/")) {
        keep = path.join(keep, part);
        let st = null;
        try { st = lstatSync(keep); } catch {}
        if (!st?.isDirectory()) throw new Error(`refused ${label}: ${gh.subPath} is not a folder in ${gh.owner}/${gh.repo} at ${gh.ref} (it does not exist, or it is a file or a symlink). Check the folder URL`);
      }
    }
    // Prune it like an uploaded folder, then put it in place. An earlier copy
    // at dest (which can hold another member's folder) is set aside, and put
    // back if the caps refuse the new copy.
    dropped = pruneClone(keep);
    const old = path.join(tmp, "old");
    if (existsSync(dest)) renameSync(dest, old);
    mkdirSync(path.dirname(dest), { recursive: true });
    renameSync(keep, dest);
    // Hold the scope to the upload caps.
    try {
      enforceCaps(ws, dest, label, (over) => splitAdvice(dest, gh, over));
    } catch (e) {
      if (existsSync(old)) renameSync(old, dest);
      throw e;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const files = reportSolFiles(ws, dest);
  return {
    kind: "repo",
    where: rel,
    ref: gh.ref ?? "default branch",
    files,
    dropped,
    note: `Cloned ${label} into ${rel}/ (${files.length} Solidity file${files.length === 1 ? "" : "s"}; ${dropped} dependency, build, non-source or secret entr${dropped === 1 ? "y" : "ies"} dropped).`,
  };
}

// Stream a response body into a buffer, aborting as soon as it passes `cap`.
async function readCapped(resp, cap) {
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel();
      throw new Error(`response exceeds the ${Math.round(cap / 1024)}KB cap`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function httpGet(url, cap) {
  const u = parseUrl(url);
  await assertPublicHost(u.hostname);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    // redirect:"manual" — a redirect would re-resolve a fresh host past our SSRF
    // check, so we refuse to follow one rather than re-validate the hop.
    const resp = await fetch(u.href, { redirect: "manual", signal: ctrl.signal, headers: { "user-agent": "touchstone-fetch" } });
    if (resp.status >= 300 && resp.status < 400) throw new Error(`refused a redirect (${resp.status}) from ${u.hostname}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${u.hostname}`);
    const buf = await readCapped(resp, cap);
    return { buf, contentType: resp.headers.get("content-type") || "" };
  } finally {
    clearTimeout(timer);
  }
}

// One read-only GET to api.github.com or raw.githubusercontent.com, with the
// same guards as every other fetch here: host allowlist, public address, TLS,
// no redirects, a byte cap, and a time cap. `token` is optional. It is sent only
// as the Authorization header and never appears in an error or a return value.
// Returns { status, buf, headers } for 2xx. Throws a short, token-free error
// otherwise; err.status and err.rateLimited let the caller explain it.
export async function githubGet(url, { token = null, accept = "application/vnd.github+json", cap = FILE_CAP } = {}) {
  const u = parseUrl(url);
  if (u.hostname !== "api.github.com" && u.hostname !== "raw.githubusercontent.com") throw new Error(`refused host ${u.hostname}: githubGet reads only api.github.com and raw.githubusercontent.com`);
  if (u.username || u.password || u.port) throw new Error("refused a URL with credentials or a port");
  await assertPublicHost(u.hostname);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const headers = { "user-agent": "touchstone-fetch", accept, ...(u.hostname === "api.github.com" ? { "x-github-api-version": "2022-11-28" } : {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    let resp;
    try { resp = await fetch(u.href, { redirect: "manual", signal: ctrl.signal, headers }); }
    catch (e) { throw new Error(ctrl.signal.aborted ? `timed out after ${FETCH_TIMEOUT_MS / 1000}s reading ${u.hostname}${u.pathname}` : `could not reach ${u.hostname}`); }
    if (resp.status >= 300 && resp.status < 400) throw Object.assign(new Error(`refused a redirect (${resp.status}) from ${u.hostname}${u.pathname}`), { status: resp.status });
    if (!resp.ok) {
      const rateLimited = (resp.status === 403 || resp.status === 429) && (resp.headers.get("x-ratelimit-remaining") === "0" || resp.headers.has("retry-after"));
      try { await resp.body?.cancel(); } catch {}
      throw Object.assign(new Error(`HTTP ${resp.status} from ${u.hostname}${u.pathname}${rateLimited ? " (rate limited)" : ""}`), { status: resp.status, rateLimited });
    }
    const buf = await readCapped(resp, cap);
    return { status: resp.status, buf, headers: resp.headers };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBlob(ws, gh) {
  const base = path.posix.basename(gh.filePath);
  if (classifyPath(gh.filePath) !== "keep") throw new Error(`refused to fetch ${gh.filePath}: it is not a source file, or it looks like a secret, dependency or build file`);
  const rel = memberDest(gh);
  const raw = `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${gh.ref}/${gh.filePath}`;
  const { buf } = await httpGet(raw, FILE_CAP);
  const body = buf.toString("utf8");
  if (body.includes("\u0000") || secretContent(body)) throw new Error(`refused to save ${base}: its content is binary or looks like a secret`);
  const dest = path.join(ws, rel);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, body);
  enforceCaps(ws, dest, gh.filePath);
  const pragmas = gh.filePath.endsWith(".sol") ? pragmaVersions(body) : [];
  return {
    kind: "file",
    where: rel,
    files: [{ path: rel, pragmas }],
    note: `Saved ${gh.filePath} to ${rel}.`,
  };
}

// Fetch one of the run's member links into the workspace. The URL must equal a
// member link (memberLinks) after normalization; anything else is refused before
// any network call. A GitHub repo or tree URL is cloned; a blob URL is saved as
// one file. Returns a small report the caller turns into a tool result. Throws
// on a refused or failed fetch; the caller surfaces that to the agent.
//
// Every call emits one `source-fetch` event: the member URL, whether it landed,
// where, how many files, or the refusal text. The run reads these to tell a
// scope it read from one it did not (lib/source-coverage.mjs), so a refused
// fetch can never end as a clean run.
export async function fetchSource(ws, url) {
  const member = memberUrl(url) ?? String(url).slice(0, 200);
  try {
    const report = await fetchMember(ws, url);
    event("source-fetch", { url: member, ok: true, where: report.where ?? null, files: report.where ? countFiles(path.join(ws, report.where)) : 0 });
    return report;
  } catch (e) {
    event("source-fetch", { url: member, ok: false, error: String(e?.message ?? e).slice(0, 1500) });
    throw e;
  }
}

async function fetchMember(ws, url) {
  const want = memberUrl(url);
  if (!want) throw new Error(`refused ${String(url).slice(0, 200)}: only GitHub repo, tree or file URLs that this scope lists are fetched`);
  if (!memberLinks(ws).includes(want)) throw new Error(`refused ${want}: it is not one of this scope's members. Fetch only a URL BRIEF.md lists`);
  const gh = parseGithub(parseUrl(want));
  if (gh?.kind === "repo") return fetchRepo(ws, gh);
  if (gh?.kind === "blob") return fetchBlob(ws, gh);
  throw new Error(`refused ${want}: not a GitHub repo, tree or file URL`);
}

// Exposed for tests.
export const _internal = { isBlockedAddress, parseGithub, assertPublicHost, extract: pragmaVersions };
