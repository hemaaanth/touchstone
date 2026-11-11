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
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { classifyPath, githubRepoUrl, safeRelPath, secretContent, MAX_BYTES, MAX_FILES, MAX_MEMBERS } from "./scopes-store.mjs";

// The only hosts a fetch ever contacts.
const ALLOWED_HOSTS = new Set(["github.com", "raw.githubusercontent.com"]);

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
  if (!ALLOWED_HOSTS.has(hostname)) throw new Error(`refused host ${hostname}: only github.com and raw.githubusercontent.com are fetched`);
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
//   https://github.com/<owner>/<repo>/tree/<ref>[/...]      -> repo at ref
//   https://github.com/<owner>/<repo>/blob/<ref>/<path>     -> single file
// Anything else is refused.
function parseGithub(u) {
  if (u.hostname !== "github.com") return null;
  const seg = u.pathname.split("/").filter(Boolean);
  if (seg.length < 2) return null;
  const [owner, repoRaw] = seg;
  const repo = repoRaw.replace(/\.git$/, "");
  if (seg.length === 2) return { kind: "repo", owner, repo, ref: null };
  const kind = seg[2];
  if (kind === "tree" && seg.length >= 4) return { kind: "repo", owner, repo, ref: seg[3] };
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
//   repo  -> vendor/<owner>__<repo>[@<ref>]
//   blob  -> vendor/files/<owner>__<repo>[@<ref>]/<path in the repo>
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

// Refuse (and remove) a fetch that pushes the scope over the upload caps.
function enforceCaps(ws, dest, label) {
  const use = scopeUsage(ws);
  if (use.files > MAX_FILES || use.bytes > MAX_BYTES) {
    rmSync(dest, { recursive: true, force: true });
    const what = use.files > MAX_FILES ? `${use.files} source files (the cap is ${MAX_FILES})` : `${(use.bytes / 1024 / 1024).toFixed(1)} MB of source (the cap is ${MAX_BYTES / 1024 / 1024} MB)`;
    throw new Error(`${label} would bring this scope to ${what} after filtering — refused`);
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

async function fetchRepo(ws, gh) {
  await assertPublicHost("github.com");
  const dest = path.join(ws, memberDest(gh));
  rmSync(dest, { recursive: true, force: true });
  const cloneUrl = `https://github.com/${gh.owner}/${gh.repo}.git`;
  const args = [
    "-c", "protocol.allow=never",
    "-c", "protocol.https.allow=always",
    "-c", "core.hooksPath=/dev/null",
    "-c", "http.followRedirects=false",
    "clone", "--depth", "1", "--no-tags", "--single-branch",
  ];
  if (gh.ref) args.push("--branch", gh.ref);
  args.push(cloneUrl, dest);
  const r = await execFileP("git", args, {
    timeout: CLONE_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", HOME: ws },
  });
  if (r.err) {
    rmSync(dest, { recursive: true, force: true });
    const why = r.timedOut ? "clone timed out" : r.stderr.trim().split("\n").slice(-1)[0] || "clone failed";
    throw new Error(`could not clone ${gh.owner}/${gh.repo}: ${why}`);
  }
  // Drop .git first — we keep the tree, not its history. A raw clone over the
  // disk cap is refused before we read it. Then prune it like an uploaded folder
  // and hold the scope to the upload caps.
  rmSync(path.join(dest, ".git"), { recursive: true, force: true });
  if (dirSizeOver(dest, REPO_CAP)) {
    rmSync(dest, { recursive: true, force: true });
    throw new Error(`clone of ${gh.owner}/${gh.repo} exceeds the ${Math.round(REPO_CAP / 1024 / 1024)}MB cap — refused`);
  }
  const dropped = pruneClone(dest);
  enforceCaps(ws, dest, `${gh.owner}/${gh.repo}`);
  const files = reportSolFiles(ws, dest);
  return {
    kind: "repo",
    where: path.relative(ws, dest),
    ref: gh.ref ?? "default branch",
    files,
    dropped,
    note: `Cloned ${gh.owner}/${gh.repo} into ${path.relative(ws, dest)}/ (${files.length} Solidity file${files.length === 1 ? "" : "s"}; ${dropped} dependency, build, non-source or secret entr${dropped === 1 ? "y" : "ies"} dropped).`,
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
export async function fetchSource(ws, url) {
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
