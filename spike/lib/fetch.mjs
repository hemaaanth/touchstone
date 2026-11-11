// Host-side source fetch for brief scopes.
//
// WHY HOST-SIDE. The Foundry sandbox runs with --network none, so it cannot pull
// code itself. A brief names its sources as links; the engine fetches them here,
// on the host, into the run's workspace under vendor/, and only then does the
// offline sandbox compile and prove against them. The proof still happens with no
// network and no live chain — fetching is just how the code gets onto disk.
//
// WHY THE GUARDS. The links come from a brief the operator pasted, so a link can
// point anywhere. Three guards keep a fetch from reaching into the machine or
// running away:
//   - TLS only, and the resolved host must be a public address. A link that
//     resolves to localhost, a private LAN range, link-local, or an IPv6 ULA is
//     refused, so a brief cannot make the engine probe the operator's own network
//     (SSRF).
//   - Size and time caps on every path, so a huge repo or a slow host cannot hang
//     or fill the disk.
//   - git runs with prompts disabled, hooks disabled, and only the https
//     protocol allowed, so a clone cannot execute a hook or follow a file:// or
//     ssh:// submodule off the machine.
import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { classifyPath } from "./scopes-store.mjs";

const FILE_CAP = 2 * 1024 * 1024; // 2 MB — a single source file
const PAGE_CAP = 100 * 1024; // 100 KB of stripped page text
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
// Anything else on github.com, or any other host, is handled as a plain page.
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
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else total += st.size;
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

// Remove what a run must never read from a fresh clone: symlinks (they can point
// out of the workspace), hidden entries (.env, .npmrc, .github, ...), and files
// named like secrets (keys, keystores, credentials). Uses lstat, so it never
// follows a link. Returns how many entries it removed.
export function pruneClone(dir) {
  let removed = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink() || name.startsWith(".") || (st.isFile() && classifyPath(name) === "secret file")) {
        rmSync(p, { recursive: true, force: true });
        removed++;
      } else if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return removed;
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
  const dest = path.join(ws, "vendor", gh.repo);
  rmSync(dest, { recursive: true, force: true });
  const cloneUrl = `https://github.com/${gh.owner}/${gh.repo}.git`;
  const args = [
    "-c", "protocol.allow=never",
    "-c", "protocol.https.allow=always",
    "-c", "core.hooksPath=/dev/null",
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
  // Drop .git before the size check — we keep the tree, not its history. Then
  // drop symlinks, hidden files, and secret-named files, so no tool can read them.
  rmSync(path.join(dest, ".git"), { recursive: true, force: true });
  pruneClone(dest);
  if (dirSizeOver(dest, REPO_CAP)) {
    rmSync(dest, { recursive: true, force: true });
    throw new Error(`clone of ${gh.owner}/${gh.repo} exceeds the ${Math.round(REPO_CAP / 1024 / 1024)}MB cap — refused`);
  }
  const files = reportSolFiles(ws, dest);
  return {
    kind: "repo",
    where: path.relative(ws, dest),
    ref: gh.ref ?? "default branch",
    files,
    note: `Cloned ${gh.owner}/${gh.repo} into ${path.relative(ws, dest)}/ (${files.length} Solidity file${files.length === 1 ? "" : "s"}).`,
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
  if (base.startsWith(".") || classifyPath(base) === "secret file") throw new Error(`refused to fetch ${base}: it looks like a secret or hidden file`);
  const raw = `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${gh.ref}/${gh.filePath}`;
  const { buf } = await httpGet(raw, FILE_CAP);
  const body = buf.toString("utf8");
  const rel = path.join("vendor", "files", `${gh.owner}__${gh.repo}__${path.basename(gh.filePath)}`);
  const dest = path.join(ws, rel);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, body);
  const pragmas = gh.filePath.endsWith(".sol") ? pragmaVersions(body) : [];
  return {
    kind: "file",
    where: rel,
    files: [{ path: rel, pragmas }],
    note: `Saved ${gh.filePath} to ${rel}.`,
  };
}

// A non-GitHub page, or an unrecognized GitHub path: fetch it, strip tags, and
// return capped text. NOT saved to disk — it is context for the agent to read,
// not a source file to compile.
async function fetchPage(url) {
  const { buf } = await httpGet(url, PAGE_CAP);
  const html = buf.toString("utf8");
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { kind: "page", where: null, text, files: [], note: `Fetched page text from ${new URL(url).hostname} (not saved).` };
}

// Fetch one source link into the workspace. Dispatches on the URL shape:
// GitHub repo/tree -> clone, GitHub blob -> single file, anything else -> page
// text. Returns a small report the caller turns into a tool result. Throws on a
// refused or failed fetch; the caller surfaces that to the agent as a tool error.
export async function fetchSource(ws, url) {
  const u = parseUrl(url);
  const gh = parseGithub(u);
  if (gh?.kind === "repo") return fetchRepo(ws, gh);
  if (gh?.kind === "blob") return fetchBlob(ws, gh);
  return fetchPage(u.href);
}

// Exposed for tests.
export const _internal = { isBlockedAddress, parseGithub, extract: pragmaVersions };
