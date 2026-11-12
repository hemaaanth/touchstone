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
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(HERE, "../data");
// TOUCHSTONE_GRANTS_FILE exists only so tests use a throwaway store. Read on
// each call, so a test can set it after import.
const grantsFile = () => process.env.TOUCHSTONE_GRANTS_FILE || path.join(DATA_DIR, "grants.json");

export const GRANT_KINDS = ["operator-owned", "authorized"];

// One shared console token for every mutating console action — both the live-reach
// grant routes and the settings-write guard import THIS. TOUCHSTONE_GRANT_TOKEN
// pins it (tests, or an operator who wants a known value); otherwise one random
// token is minted per process. Single source => the operator sees and pastes one
// token, never two that happen to share the x-touchstone-grant-token header.
export const GRANT_TOKEN = process.env.TOUCHSTONE_GRANT_TOKEN || randomUUID();

// Read the whole store. A missing file or unparsable JSON yields an empty list,
// so a hand-edited or absent file degrades to "no grants", never a throw.
export function readGrants() {
  try {
    const arr = JSON.parse(readFileSync(grantsFile(), "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeGrants(arr) {
  mkdirSync(path.dirname(grantsFile()), { recursive: true });
  writeFileSync(grantsFile(), JSON.stringify(arr, null, 2));
}

// One host, normalized to the form the allow-list and the proxy compare on:
// lowercase, no scheme, no port, no path, no credentials. Accepts a bare
// hostname, an "example.com:443" host:port, or a full "https://example.com/x"
// URL and keeps only the hostname. Returns null for anything that is not a
// usable hostname or IP literal, so a bad entry is dropped, never stored.
export function normalizeHost(raw) {
  let s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  // Pull the hostname out of a URL, or a bare "host[:port][/path]".
  if (s.includes("://")) {
    try { s = new URL(s).hostname; } catch { return null; }
  } else {
    s = s.split("/")[0]; // drop any path
    // Strip a :port, but keep a bracketed IPv6 literal intact.
    if (!s.startsWith("[")) s = s.split(":")[0];
    else s = s.replace(/^\[|\].*$/g, "");
  }
  s = s.replace(/\.$/, ""); // drop a trailing dot (FQDN root)
  if (!s) return null;
  // A hostname label set, or an IPv4/IPv6 literal. No spaces, no wildcards here
  // (a wildcard entry is stored separately as "*.example.com", handled below).
  const hostname = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
  const ipv6 = /^[0-9a-f:]+$/;
  if (hostname.test(s) || ipv6.test(s)) return s;
  return null;
}

// A short list of public suffixes we refuse to wildcard. A grant for
// "*.<suffix>" would cover the whole registry (every .com, every .co.uk), which
// is never a real scope. This is not the full Public Suffix List — it is the
// common multi-party suffixes a fat-fingered or malicious grant would reach for.
// A wildcard base must also have at least two labels, so "*.com" is refused on
// the label count alone; this set catches the two-label public suffixes.
const PUBLIC_SUFFIXES = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  "co.nz", "net.nz", "org.nz", "govt.nz",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
  "com.br", "net.br", "org.br", "gov.br",
  "co.in", "net.in", "org.in", "gov.in", "ac.in",
  "com.cn", "net.cn", "org.cn", "gov.cn",
  "co.za", "org.za", "gov.za",
  "com.mx", "com.ar", "com.sg", "com.hk", "com.tw", "com.tr",
  "github.io", "gitlab.io", "pages.dev", "web.app", "firebaseapp.com",
  "herokuapp.com", "vercel.app", "netlify.app", "workers.dev", "appspot.com",
  "s3.amazonaws.com", "cloudfront.net", "azurewebsites.net", "blob.core.windows.net",
]);

// True for a hostname that is loopback, unspecified, or an obvious local name
// (not an IP — those are caught by isIP + isBlockedAddress at grant time). These
// names must not be granted without an explicit opt-in: a grant for "localhost"
// would let a run reach back into the host the console runs on.
function isLocalName(name) {
  return name === "localhost" || name === "localhost.localdomain" || name.endsWith(".localhost");
}

// True for an IP literal in a range a run must not reach without opting in:
// loopback, private LAN, link-local (incl. cloud metadata 169.254.169.254),
// carrier-grade NAT, unspecified, and the IPv6 equivalents. Same ranges the
// scope proxy pins against (lib/scope-proxy.mjs) and lib/fetch.mjs refuses.
function isPrivateIp(addr) {
  const fam = isIP(addr);
  if (fam === 4) {
    const p = addr.split(".").map(Number);
    const [a, b] = p;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (fam === 6) {
    const a = addr.toLowerCase().replace(/^\[|\]$/g, "");
    if (a === "::" || a === "::1") return true;
    if (a.startsWith("fe80") || a.startsWith("fe9") || a.startsWith("fea") || a.startsWith("feb")) return true;
    if (a.startsWith("fc") || a.startsWith("fd")) return true;
    const m = a.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateIp(m[1]);
    return false;
  }
  return false;
}

// Reject a host entry that must not be granted. Returns an error string, or null
// if the entry is allowed. `allowPrivate` opts a grant into loopback/private
// space on purpose (the operator's own LAN, or a test). Wildcard bases are
// checked for label count and public suffixes either way — a "*.com" grant is
// never a real scope.
function grantEntryError(entry, allowPrivate) {
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
    if (PUBLIC_SUFFIXES.has(base)) return `"${e}" covers a whole public suffix (${base}); grant the exact subdomains instead.`;
    return null;
  }
  if (!allowPrivate) {
    if (isLocalName(e)) return `"${e}" is a loopback name; a grant for it would reach the console's own host. Pass allowPrivate to grant private space on purpose.`;
    if (isIP(e) && isPrivateIp(e)) return `"${e}" is a loopback/private/link-local address; a grant for it could reach the host or cloud metadata. Pass allowPrivate to grant private space on purpose.`;
    if (e === "0.0.0.0") return `"0.0.0.0" is the unspecified address and is never a target. Pass allowPrivate to grant private space on purpose.`;
  }
  return null;
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
  const all = readGrants();
  all.unshift(grant);
  writeGrants(all);
  return grant;
}

export function getGrant(id) {
  return readGrants().find((g) => g.id === id) ?? null;
}

export function removeGrant(id) {
  const all = readGrants();
  const next = all.filter((g) => g.id !== id);
  if (next.length === all.length) return false;
  writeGrants(next);
  return true;
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
