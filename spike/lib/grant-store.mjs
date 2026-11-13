// The grant store — who may be reached live, and on whose say-so.
//
// WHY THIS EXISTS. A live module (Web, Domains, Surface) tests a REAL target,
// not a lab. We never reach a real host on the agent's word alone. A grant is
// the operator's written permission: the exact hosts in scope, who approved it,
// and when. The grant fills the scope proxy's allow-list (lib/scope-proxy.mjs),
// so the proxy lets a request through only to a host a grant names. A live
// module refuses to run with no grant for its target (requireGrant).
//
// TWO KINDS of grant:
//   - "operator-owned": the operator confirms they own the target. This is the
//     grant for the operator's own infrastructure. It needs `ownership: true`.
//   - "authorized": a third party authorized the test (a pentest engagement, a
//     bug-bounty scope). It needs an `approvedBy` that names who authorized it.
//
// WHERE IT LIVES. One JSON file under spike/data/, which is gitignored: a grant
// points at the operator's own targets and permissions, not our source. We read
// and rewrite the whole file on each change, like scopes-store.mjs. There is one
// long-lived writer (the dev server), so there is no concurrent writer.
//
// NO HARM. A grant never widens what a run may DO. It only names hosts the
// network seam may reach. The proof surfaces stay the same: a finding is still
// real only when its proof replays and shows harm. A grant with no live run is
// inert. The hard boundary "never scan a target that is not a lab and not a
// granted, operator-owned target" (WAVE2.md Limits) is exactly this record.
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { isPublicSuffix, sharedWildcardRefusal } from "./public-suffix.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(HERE, "../data");
// TOUCHSTONE_GRANTS_FILE exists only so tests use a throwaway store. Read on
// each call, so a test can set it after import.
const grantsFile = () => process.env.TOUCHSTONE_GRANTS_FILE || path.join(DATA_DIR, "grants.json");

export const GRANT_KINDS = ["operator-owned", "authorized"];

// One shared console token for every mutating console action — both the live-reach
// grant routes and the settings-write guard import THIS. Single source => one
// token, never two that happen to share the x-touchstone-grant-token header.
//
// The token is made once and saved next to the grants file, so it stays the same
// across server restarts and an open page keeps working. The operator never
// types it: the dev server writes it into the page it serves. It is saved in
// a file, NOT in process.env, because the agent child inherits the server's env
// and must never hold the token. TOUCHSTONE_GRANT_TOKEN pins a known value for
// tests; TOUCHSTONE_GRANT_TOKEN_FILE moves the file so a test uses a throwaway.
function savedToken() {
  const file = process.env.TOUCHSTONE_GRANT_TOKEN_FILE || path.join(DATA_DIR, "console-token");
  try {
    const saved = readFileSync(file, "utf8").trim();
    if (saved) return saved;
  } catch {
    /* no file yet */
  }
  const token = randomUUID();
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, token + "\n", { mode: 0o600 });
  } catch {
    /* a read-only disk: the token lasts for this process only */
  }
  return token;
}
export const GRANT_TOKEN = process.env.TOUCHSTONE_GRANT_TOKEN || savedToken();

// One JSON store file: an array of records. The grant store and the scope store
// both use these two functions.
//
// loadStore: a missing file is an empty store. A file that exists but cannot be
// read, or is not a JSON array, is DAMAGED: this throws. Every mutation loads
// with it first, so a mutation never writes over a damaged file.
export function loadStore(file, what) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw new Error(`Refused: the ${what} file ${file} exists but cannot be read (${e.code || e.message}). Nothing was changed. Repair the file or move it away, then try again.`);
  }
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch {
    arr = null;
  }
  if (!Array.isArray(arr)) throw new Error(`Refused: the ${what} file ${file} is not a valid JSON list. Nothing was changed. Repair the file or move it away, then try again.`);
  return arr;
}

// saveStore: write a temp file in the same directory, then rename it over the
// store. A crash in the middle leaves the old file whole, never a half file.
export function saveStore(file, arr) {
  mkdirSync(path.dirname(file), { recursive: true });
  // Keep the mode the operator gave the file. A new file gets the default mode.
  let mode = 0o666;
  try {
    mode = statSync(file).mode & 0o777;
  } catch {
    /* no file yet */
  }
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(arr, null, 2), { mode });
    const fd = openSync(tmp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    lockStillOurs(file);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  // The rename lives in the folder: fsync the folder too, so a crash right
  // after this cannot bring the old file back.
  syncFolder(path.dirname(file));
}

function syncFolder(dir) {
  let fd;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch (e) {
    // A system that cannot fsync a folder (EISDIR, EINVAL, EPERM) keeps the old
    // durability. Any other error is real.
    if (!["EISDIR", "EINVAL", "EPERM", "EBADF"].includes(e.code)) throw e;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// ---- One writer at a time, across processes -------------------------------
//
// The server and the CLI can both write a store. Each mutation reads the whole
// file, changes it and writes it back, so two at once could lose one update.
// withStoreLock runs a mutation while it holds "<file>.lock", made with "wx"
// (only one process can make it). The lock holds the owner's pid, the time and
// a random token; ownership is the token, never the inode (an inode number can
// be reused by the next lock).
//   - The lock path must be a regular file. A link or a folder there is
//     refused with a sentence and never followed (lstat).
//   - A lock is STALE when its process is gone, or when it is older than
//     LOCK_STALE_MS. Breaking a stale lock is serialized by a second file,
//     "<file>.lock.break", made with "wx": one breaker at a time. Under it the
//     breaker reads the lock again and removes it only when it is still the
//     very lock it judged stale (same content, so same token). A lock made in
//     the meantime is never removed, so a writer is never refused because
//     another process broke the lock it had just made.
//   - A live lock is waited for up to TOUCHSTONE_STORE_LOCK_WAIT_MS, default
//     LOCK_WAIT_MS (300 ms). The wait is synchronous: store calls are
//     synchronous, and the console server calls them from its request
//     handlers. A short bound keeps one stuck lock from freezing the console:
//     the write is refused with a sentence and the operator tries again.
//   - A writer that held its lock longer than LOCK_STALE_MS can lose it. A
//     real write takes milliseconds; only a stopped or hung process is that
//     slow. saveStore checks, just before its rename, that the lock still holds
//     its token, and refuses if not. Release removes the lock only then too.
// Re-entrant in one process: a mutation that calls another on the same store
// does not wait for itself.
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 300;
const BREAK_STALE_MS = 5_000; // a break takes microseconds
const heldLocks = new Map(); // lock path -> our token
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// For tests only: called between judging a lock stale and breaking it, so a
// test can change the lock in that gap or make two processes meet there.
export const lockTestHooks = { afterStaleJudged: null };

// What sits at a lock path: null (nothing), { bad: true } (not a regular
// file), or { raw, token, owner, ageMs }.
function lockAt(lock) {
  let st;
  try {
    st = lstatSync(lock);
  } catch {
    return null;
  }
  if (!st.isFile()) return { bad: true };
  let raw = "";
  try {
    raw = readFileSync(lock, "utf8");
  } catch {
    return null; // removed between the lstat and the read
  }
  let owner = null;
  try {
    owner = JSON.parse(raw);
  } catch {
    /* being written right now, or damaged */
  }
  return { raw, token: owner?.token ?? null, owner, ageMs: Date.now() - st.mtimeMs };
}

function isStale(lock, { owner, ageMs }, maxAgeMs) {
  if (ageMs > maxAgeMs) return true;
  const pid = Number(owner?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return ageMs > 2_000; // no owner written yet: give the writer a moment
  if (pid === process.pid) return !heldLocks.has(lock); // ours but not held: a leftover
  try {
    process.kill(pid, 0);
    return false; // alive (or alive under another user: EPERM below)
  } catch (e) {
    return e.code === "ESRCH";
  }
}

// Break the stale lock `seen`, one breaker at a time. Removes the lock only
// when it is still exactly `seen`. Returns nothing: the caller tries "wx" again.
function breakStale(lock, seen) {
  const breaker = `${lock}.break`;
  try {
    writeFileSync(breaker, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx", mode: 0o600 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    // Another process is breaking it now, or crashed while doing so.
    const b = lockAt(breaker);
    if (b && !b.bad && isStale(breaker, b, BREAK_STALE_MS)) rmSync(breaker, { force: true });
    return;
  }
  try {
    const now = lockAt(lock);
    if (now && !now.bad && now.raw === seen.raw && isStale(lock, now, LOCK_STALE_MS)) unlinkSync(lock);
  } finally {
    rmSync(breaker, { force: true });
  }
}

const notALockFile = (what, lock) =>
  new Error(`Refused: the ${what} lock ${lock} is a link or a folder, not a lock file. Touchstone does not follow it. Nothing was changed. Remove it, then try again.`);

export function withStoreLock(file, what, fn) {
  const lock = `${file}.lock`;
  if (heldLocks.has(lock)) return fn();
  mkdirSync(path.dirname(file), { recursive: true });
  const waitMs = Number(process.env.TOUCHSTONE_STORE_LOCK_WAIT_MS) || LOCK_WAIT_MS;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const token = randomUUID();
    try {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now(), token }), { flag: "wx", mode: 0o600 });
      heldLocks.set(lock, token);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const seen = lockAt(lock);
    if (!seen) continue; // released just now: try again at once
    if (seen.bad) throw notALockFile(what, lock);
    if (isStale(lock, seen, LOCK_STALE_MS)) {
      lockTestHooks.afterStaleJudged?.();
      breakStale(lock, seen);
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`Refused: the ${what} is busy. Another Touchstone process (pid ${seen.owner?.pid ?? "unknown"}) is writing it. Nothing was changed. Try again in a moment.`);
    }
    pause(10);
  }
  try {
    return fn();
  } finally {
    const ours = heldLocks.get(lock);
    heldLocks.delete(lock);
    if (lockAt(lock)?.token === ours) rmSync(lock, { force: true });
  }
}

// Called by saveStore just before its rename: a writer that holds the lock of
// this file must still hold it. Throws when another process took it over.
function lockStillOurs(file) {
  const lock = `${file}.lock`;
  if (!heldLocks.has(lock)) return;
  if (lockAt(lock)?.token !== heldLocks.get(lock)) {
    throw new Error(`Refused: another process took over the store lock ${lock} during this write (it was held longer than 30 s). Nothing was changed. Try again.`);
  }
}

// The grants for a mutation: throws on a damaged file (see loadStore).
export const loadGrants = () => loadStore(grantsFile(), "grant store");

// A sentence when the grant store file exists but cannot be read, else null.
// The gate then refuses every live run (readGrants reads it as empty).
export function grantStoreError() {
  try {
    loadGrants();
    return null;
  } catch (e) {
    // Read on a page that changes nothing: no "Nothing was changed".
    const text = String(e?.message ?? e)
      .replace(/^Refused: /, "")
      .replace(/ Nothing was changed\. Repair the file or move it away, then try again\.$/, " Its grants are not shown, and none can be added or changed, until the file is repaired or moved away.");
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
}

// Read the whole store for a gate or a list. A missing file is an empty list.
// A damaged file also reads as "no grants": the gate then refuses every run
// (fail closed). It is never written over: addGrant and removeGrant refuse it.
export function readGrants() {
  try {
    return loadGrants();
  } catch {
    return [];
  }
}

function writeGrants(arr) {
  saveStore(grantsFile(), arr);
}

// One host, normalized to the form the allow-list and the proxy compare on:
// lowercase, no scheme, no port, no path, no credentials. Accepts a bare
// hostname, an "example.com:443" host:port, or a full "https://example.com/x"
// URL and keeps only the hostname. Returns null for anything that is not a
// usable hostname or IP literal, so a bad entry is dropped, never stored.
//
// CANONICAL. An IP literal comes out in one spelling, whatever spelling came
// in, so every allow/deny decision sees the real address:
//   - IPv4 in any form the WHATWG URL parser (and so fetch) accepts:
//     2130706433, 0177.0.0.1 and 0x7f000001 all become 127.0.0.1.
//   - IPv6 in its compressed form, without brackets: [fd00:0ec2:0:0:0:0:0:254]
//     and fd00:ec2::0254 both become fd00:ec2::254.
// The result is idempotent: normalizeHost(normalizeHost(x)) === normalizeHost(x).
// A bare IPv6 literal is never cut at a ":" as if that were a port.
const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
export function normalizeHost(raw) {
  let s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  // A wildcard entry, "*.example.com": a name pattern, never an address.
  if (s.startsWith("*.")) {
    const base = s.slice(2).split("/")[0].split(":")[0].replace(/\.$/, "");
    if (!HOSTNAME.test(base)) return null;
    // A base that parses as an IP ("*.0.1") is not a name pattern.
    let parsed;
    try { parsed = new URL(`http://${base}/`).hostname; } catch { return null; }
    return parsed === base && !isIP(base) ? `*.${base}` : null;
  }
  if (isIP(s) === 6) s = `[${s}]`;
  let host;
  try {
    host = new URL(s.includes("://") ? s : `http://${s}`).hostname;
    // Parse the host again as http, so a host from any scheme is canonical too.
    host = new URL(`http://${host}/`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.$/, ""); // drop a trailing dot (FQDN root)
  if (host.startsWith("[")) return host.slice(1, -1); // IPv6, already compressed by URL
  if (isIP(host) === 4) return host;
  return HOSTNAME.test(host) ? host : null;
}

// "an unspecified address", "a loopback address".
const article = (word) => (/^[aeiou]/.test(word) ? "an" : "a");

// What kind of address an IP literal is, decided on the PARSED address, never
// on its spelling. Returns null when the host is not an IP literal. Kinds:
// "public", "loopback", "private" (RFC 1918, carrier-grade NAT, IPv6 unique-
// local), "link-local", "metadata" (cloud metadata), "unspecified", "reserved"
// (multicast and the like). An IPv6 address that carries an IPv4 address
// (::ffff:a.b.c.d, the NAT64 64:ff9b::/96 prefix, the old ::a.b.c.d form) is
// the kind of that IPv4 address.
function v4Kind([a, b, c, d]) {
  if ((a === 169 && b === 254 && c === 169 && d === 254) || (a === 100 && b === 100 && c === 100 && d === 200)) return "metadata";
  if (a === 0) return "unspecified";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return "private";
  if (a >= 224) return "reserved";
  return "public";
}

// Eight 16-bit words of a canonical IPv6 literal (as normalizeHost gives it).
function v6Words(ip) {
  const [head, tail] = ip.includes("::") ? ip.split("::") : [ip, null];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const fill = tail === null ? [] : Array(8 - h.length - t.length).fill("0");
  return [...h, ...fill, ...t].map((x) => parseInt(x, 16));
}

export function ipKind(raw) {
  const ip = normalizeHost(raw);
  if (!ip || !isIP(ip)) return null;
  if (isIP(ip) === 4) return v4Kind(ip.split(".").map(Number));
  const w = v6Words(ip);
  if (w.length !== 8 || w.some((x) => !Number.isInteger(x) || x < 0 || x > 0xffff)) return "reserved";
  const zero = (from, to) => w.slice(from, to).every((x) => x === 0);
  const embedded = () => v4Kind([w[6] >> 8, w[6] & 255, w[7] >> 8, w[7] & 255]);
  if (zero(0, 5) && w[5] === 0xffff) return embedded(); // ::ffff:a.b.c.d
  if (w[0] === 0x64 && w[1] === 0xff9b && zero(2, 6)) return embedded(); // NAT64
  if (zero(0, 8)) return "unspecified";
  if (zero(0, 7) && w[7] === 1) return "loopback";
  if (zero(0, 6)) return embedded(); // ::a.b.c.d, the old IPv4-compatible form
  if (w[0] === 0xfd00 && w[1] === 0x0ec2 && zero(2, 7) && w[7] === 0x254) return "metadata";
  if ((w[0] & 0xffc0) === 0xfe80) return "link-local";
  if ((w[0] & 0xfe00) === 0xfc00) return "private";
  if ((w[0] & 0xff00) === 0xff00 || (w[0] & 0xffc0) === 0xfec0) return "reserved"; // multicast, old site-local
  return "public";
}

// The public suffixes come from the Public Suffix List (lib/public-suffix.mjs),
// the one source of truth. This name stays for the Domains CAA walk
// (packs/domains/tls.mjs), which asks only `.has(name)`.
export const PUBLIC_SUFFIXES = Object.freeze({ has: (name) => isPublicSuffix(name) });

// True for a hostname that is loopback, unspecified, or an obvious local name
// (not an IP — those are caught by isIP + isBlockedAddress at grant time). These
// names must not be granted without an explicit opt-in: a grant for "localhost"
// would let a run reach back into the host the console runs on.
function isLocalName(name) {
  return name === "localhost" || name === "localhost.localdomain" || name.endsWith(".localhost");
}

// Reject a host entry that must not be granted. Returns an error string, or null
// if the entry is allowed. `allowPrivate` opts a grant into loopback/private
// space on purpose (the operator's own LAN, or a test). Wildcard bases are
// checked for label count and public suffixes either way — a "*.com" grant is
// never a real scope.
function grantEntryError(entry, allowPrivate) {
  // A user name or password in the entry would be dropped by normalizeHost
  // without a word. Refuse it, and name the host only, never the secret.
  const raw = String(entry ?? "").trim();
  if (raw.includes("@")) {
    let u = null;
    try {
      u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      /* not a URL: normalizeHost decides */
    }
    if (u && (u.username || u.password)) {
      return `the host entry for ${u.hostname} holds a user name or password. Touchstone never keeps a credential typed into a host. Remove it, then add the grant again.`;
    }
  }
  const e = normalizeHost(entry);
  // An unusable host is not this guard's concern: it is dropped by normalizeHost
  // and caught downstream by the "at least one valid host" check. This guard only
  // refuses hosts that ARE usable but must not be granted (too-broad wildcards,
  // private space without opt-in).
  if (!e) return null;
  if (e.startsWith("*.")) {
    const base = e.slice(2);
    const labels = base.split(".").filter(Boolean);
    if (labels.length < 2) return `"${e}" is too broad: a wildcard needs at least two labels after "*." (so "*.example.com", never "*.com").`;
    // A public suffix, a name with public suffixes under it, or a shared name
    // the PSL lacks: the wildcard would cover hosts that belong to other people.
    const shared = sharedWildcardRefusal(base);
    if (shared) return shared;
    return null;
  }
  if (!allowPrivate) {
    if (isLocalName(e)) return `"${e}" is a loopback name; a grant for it would reach the console's own host. Pass allowPrivate to grant private space on purpose.`;
    // Decided on the parsed address (ipKind), so no spelling of a private
    // address passes as public.
    const kind = ipKind(e);
    if (kind && kind !== "public") return `"${e}" is ${article(kind)} ${kind} address, not a public one; a grant for it could reach the host or cloud metadata. Pass allowPrivate to grant private space on purpose.`;
  }
  return null;
}

// The stricter rule for a live scope the operator opts into private space (a
// local lab). Returns an error string, or null if the entry is allowed. The
// host is parsed first (normalizeHost, ipKind); the decision is on the parsed
// address, never on the text. Every host in such a scope must be:
//   - exactly "localhost", or
//   - an IP literal whose address is loopback or private (RFC 1918, carrier-
//     grade NAT, IPv6 unique-local).
// So: no DNS name of any kind, not even localhost.localdomain or *.localhost.
// An opted-in grant lets the proxy reach private space, so a name in it could
// be answered with any address, including cloud metadata. No wildcard. No
// link-local, unspecified, reserved or cloud-metadata address in any spelling.
// A host that does not parse is refused here, not dropped.
// The hostname as the operator typed it, before any trailing dot is dropped.
function typedHostname(entry) {
  const t = String(entry ?? "").trim();
  try {
    return new URL(t.includes("://") ? t : `http://${isIP(t) === 6 ? `[${t}]` : t}`).hostname;
  } catch {
    return "";
  }
}

export function privateLabHostError(entry) {
  const e = normalizeHost(entry);
  if (!e) return `"${String(entry ?? "").trim()}" is not a host. A private lab scope takes only "localhost" or a loopback/private IP address.`;
  if (e.startsWith("*.")) return `"${e}" is a wildcard. A private lab scope names exact hosts.`;
  // "localhost." is an absolute DNS name: the run is aimed at the name as typed,
  // and the proxy would ask DNS for it. Only the bare name is a lab.
  if (typedHostname(entry).endsWith(".")) return `"${String(entry).trim()}" ends in a dot, so it is a DNS name. A private lab scope takes only "localhost" or a loopback/private IP address.`;
  if (e === "localhost") return null;
  const kind = ipKind(e);
  if (!kind) return `"${e}" is a DNS name. A private lab scope takes only "localhost" or a loopback/private IP address.`;
  if (kind === "loopback" || kind === "private") return null;
  if (kind === "public") return `"${e}" is a public address. A private lab scope takes only loopback or private addresses.`;
  return `"${e}" is ${article(kind)} ${kind} address and is never a lab.`;
}

// Does a granted host entry cover a request host? Exact match, or a "*.example
// .com" wildcard that covers any single-or-multi-label subdomain of example.com
// (but not example.com itself). Exact is the common case; the wildcard is opt-in
// per entry, so a grant never covers more than the operator wrote.
export function hostCovers(entry, host) {
  const e = normalizeHost(entry);
  const h = normalizeHost(host);
  if (!e || !h) return false;
  if (e.startsWith("*.")) {
    // An IP address is never a subdomain.
    if (isIP(h)) return false;
    const base = e.slice(2);
    return h === base ? false : h.endsWith("." + base);
  }
  return e === h;
}

// Validate and store a grant. Throws on a bad request, so a malformed grant is
// never saved. Returns the stored grant.
//   hosts     one or more hostnames (or "*.example.com" wildcards). Required.
//   kind      "operator-owned" or "authorized". Required.
//   ownership for "operator-owned": must be true (the operator confirms they own
//             the target). Ignored for "authorized".
//   approvedBy for "authorized": who authorized the test. Required there.
//   note      free text (the engagement, the ticket). Optional.
//   scopeId   an optional link to a code scope (scopes-store.mjs).
//   expiresAt an optional ms timestamp after which the grant is inert.
export function addGrant({ hosts, kind, ownership, approvedBy, note, scopeId, expiresAt, allowPrivate } = {}) {
  const list = Array.isArray(hosts) ? hosts : hosts == null ? [] : [hosts];
  const priv = allowPrivate === true;
  // Refuse a host that must not be granted (a public-suffix wildcard either way;
  // loopback/private space unless opted in) BEFORE normalizing to the store, so a
  // bad entry never lands.
  for (const h of list) {
    const err = grantEntryError(h, priv);
    if (err) throw new Error(`Refused: ${err}`);
  }
  const norm = [...new Set(list.map(normalizeHost).filter(Boolean))];
  if (!norm.length) throw new Error("A grant needs at least one valid host.");
  if (!GRANT_KINDS.includes(kind)) throw new Error(`A grant kind is one of: ${GRANT_KINDS.join(", ")}.`);
  let who;
  if (kind === "operator-owned") {
    if (ownership !== true) throw new Error("An operator-owned grant needs the operator to confirm ownership (ownership: true).");
    who = String(approvedBy || "operator").trim() || "operator";
  } else {
    who = String(approvedBy || "").trim();
    if (!who) throw new Error("An authorized grant needs approvedBy: who authorized the test.");
  }
  let exp = null;
  if (expiresAt != null) {
    exp = Number(expiresAt);
    if (!Number.isFinite(exp) || exp <= Date.now()) throw new Error("expiresAt must be a future timestamp in ms.");
  }
  const grant = {
    id: `grant-${norm[0].replace(/[^a-z0-9]+/g, "-").slice(0, 24)}-${randomUUID().slice(0, 8)}`,
    kind,
    hosts: norm,
    ownership: kind === "operator-owned",
    approvedBy: who,
    note: String(note || "").trim(),
    scopeId: scopeId ? String(scopeId) : null,
    approvedAt: Date.now(),
    expiresAt: exp,
    // The grant carries its own opt-in: the scope proxy reads this (via
    // lib/reach.mjs) to decide whether to let this run reach private space. A
    // grant for a public host never touches it.
    allowPrivate: priv,
  };
  withStoreLock(grantsFile(), "grant store", () => {
    const all = loadGrants();
    all.unshift(grant);
    writeGrants(all);
  });
  return grant;
}

export function getGrant(id) {
  return readGrants().find((g) => g.id === id) ?? null;
}

export function removeGrant(id) {
  return withStoreLock(grantsFile(), "grant store", () => {
    const all = loadGrants();
    const next = all.filter((g) => g.id !== id);
    if (next.length === all.length) return false;
    writeGrants(next);
    return true;
  });
}

// Is a grant live right now? A grant with an expiry in the past is inert.
export function grantActive(grant, now = Date.now()) {
  return Boolean(grant) && (grant.expiresAt == null || grant.expiresAt > now);
}

// The active grants only.
export function activeGrants(now = Date.now()) {
  return readGrants().filter((g) => grantActive(g, now));
}

// The active grant that covers a host, or null. This is the lookup the scope
// proxy and the browser seam use to decide one request.
export function grantForHost(host, now = Date.now()) {
  return activeGrants(now).find((g) => g.hosts.some((h) => hostCovers(h, host))) ?? null;
}

// Every host entry across all active grants, deduplicated. This is the allow-
// list the scope proxy is started with (lib/scope-proxy.mjs allowedHosts).
export function allowedHosts(now = Date.now()) {
  return [...new Set(activeGrants(now).flatMap((g) => g.hosts))];
}

// The gate a live module calls before it reaches a target. Given the hosts a run
// wants to reach, it returns the covering grants, or throws a clear refusal that
// names the first uncovered host. "Live modules refuse to run without a grant"
// (WAVE2.md) is exactly this throw.
export function requireGrant(hosts, now = Date.now()) {
  const list = (Array.isArray(hosts) ? hosts : [hosts]).map(normalizeHost).filter(Boolean);
  if (!list.length) throw new Error("No target host to check a grant against.");
  const grants = [];
  for (const h of list) {
    const g = grantForHost(h, now);
    if (!g) throw new Error(`Refused: no active grant covers ${h}. A live module needs a grant that names its target host. Add one (operator-owned for your own infra, or authorized with who approved it).`);
    // Dedup by id: each grantForHost re-reads the file and returns a fresh
    // object, so compare on id, not reference.
    if (!grants.some((x) => x.id === g.id)) grants.push(g);
  }
  return grants;
}

export function hasGrantsFile() {
  return existsSync(grantsFile());
}
