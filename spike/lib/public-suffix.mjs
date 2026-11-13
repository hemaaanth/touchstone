// The Public Suffix List: the one source of truth for "is this a public suffix"
// and "what is the registrable domain of this host". It replaces the two short
// hand lists that grant-store.mjs and live-hosts.mjs had.
//
// THE DATA. spike/vendor/publicsuffix/public_suffix_list.dat, vendored as is
// (MPL-2.0, see THIRD_PARTY.md). Fetched once with curl from
// https://publicsuffix.org/list/public_suffix_list.dat on 2026-11-13T15:21Z,
// list VERSION 2026-11-12_19-44-12_UTC,
// sha256 b3f2d087e147f5fb4226710acb180d4f2361a281473e234d61005e46afdc8891.
// To update: fetch the same URL, replace the file, update these three lines,
// and run spike/test/public-suffix.test.mjs.
//
// THE RULES (https://publicsuffix.org/list/ "Formal algorithm"). Both the ICANN
// and the PRIVATE section count. A rule is a name ("co.uk"), a wildcard
// ("*.ck": every child of ck is a public suffix) or an exception ("!www.ck":
// www.ck is not, though *.ck says so). An exception wins; otherwise the longest
// matching rule wins; with no match, the last label alone ("*") is the suffix.
// Names are compared in their ASCII (punycode) form, lower case.
import { readFileSync } from "node:fs";
import { domainToASCII } from "node:url";

const LIST = new URL("../vendor/publicsuffix/public_suffix_list.dat", import.meta.url);

// Parsed once, on first use. One pass over the file: about 16,000 lines.
let rules = null;
function load() {
  if (rules) return rules;
  const normal = new Map(); // name -> private?
  const wildcard = new Map(); // "ck" for the rule "*.ck" -> private?
  const exception = new Map(); // "www.ck" for the rule "!www.ck" -> private?
  const above = new Set(); // every name that has a rule strictly under it
  let section = null;
  for (const raw of readFileSync(LIST, "utf8").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("//")) {
      if (line.includes("===BEGIN ICANN DOMAINS===")) section = "icann";
      else if (line.includes("===BEGIN PRIVATE DOMAINS===")) section = "private";
      continue;
    }
    if (!line || !section) continue;
    let rule = line.split(/\s/)[0].toLowerCase();
    const kind = rule.startsWith("!") ? "exception" : rule.startsWith("*.") ? "wildcard" : "normal";
    if (kind === "exception") rule = rule.slice(1);
    if (kind === "wildcard") rule = rule.slice(2);
    if (/[^\x20-\x7e]/.test(rule)) rule = domainToASCII(rule);
    if (!rule) continue;
    const priv = section === "private";
    if (kind === "exception") exception.set(rule, priv);
    else if (kind === "wildcard") wildcard.set(rule, priv);
    else normal.set(rule, priv);
    // The names above this rule. A wildcard rule "*.b.c" puts suffixes under b.c too.
    const labels = rule.split(".");
    for (let i = kind === "wildcard" ? 0 : 1; i < labels.length; i++) above.add(labels.slice(i).join("."));
  }
  rules = { normal, wildcard, exception, above };
  return rules;
}

const ascii = (host) => {
  const h = String(host ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!h) return "";
  return /[^\x20-\x7e]/.test(h) ? domainToASCII(h) : h;
};

// The public suffix of a host and the section of the rule that decided it
// ("icann", "private", or "default" for the "*" rule). Null for an empty name.
export function suffixOf(host) {
  const h = ascii(host);
  if (!h) return null;
  const { normal, wildcard, exception } = load();
  const labels = h.split(".");
  const n = labels.length;
  // An exception rule wins over every other rule: its suffix drops its first label.
  for (let i = 0; i < n; i++) {
    const name = labels.slice(i).join(".");
    if (exception.has(name)) return { suffix: labels.slice(i + 1).join("."), section: exception.get(name) ? "private" : "icann" };
  }
  let best = null;
  for (let i = 0; i < n; i++) {
    const name = labels.slice(i).join(".");
    if (i >= 1 && wildcard.has(name)) {
      const len = n - i + 1;
      if (!best || len > best.len) best = { len, section: wildcard.get(name) ? "private" : "icann" };
    }
    if (normal.has(name)) {
      const len = n - i;
      if (!best || len > best.len) best = { len, section: normal.get(name) ? "private" : "icann" };
    }
  }
  if (!best) return { suffix: labels[n - 1], section: "default" };
  return { suffix: labels.slice(n - best.len).join("."), section: best.section };
}

export const publicSuffix = (host) => suffixOf(host)?.suffix ?? null;

// Is this name itself a public suffix ("com", "co.uk", "vercel.app", "foo.ck")?
export function isPublicSuffix(name) {
  const h = ascii(name);
  return !!h && publicSuffix(h) === h;
}

// The registrable domain: the public suffix plus one label. Null when the host
// is itself a public suffix (it has no registrable domain).
export function registrableDomain(host) {
  const h = ascii(host);
  const s = suffixOf(h);
  if (!s || s.suffix === h) return null;
  const labels = h.split(".");
  return labels.slice(labels.length - s.suffix.split(".").length - 1).join(".");
}

// Is there a public suffix strictly under this name ("amazonaws.com" has
// "s3.amazonaws.com"; "run.app" has every "<region>.run.app")?
export const hasSuffixUnder = (name) => load().above.has(ascii(name));

// ---- What the PSL cannot know ---------------------------------------------
// A provider zone where every customer gets a name under it, but the provider
// did not list it in the PSL. And a floor: every name the hand lists refused
// before the PSL (main at cc2690d: live-hosts.mjs ANY_DEPTH, TENANT,
// SECOND_LEVEL; grant-store.mjs PUBLIC_SUFFIXES). A change of the source of
// truth may add refusals, never remove one; public-suffix.test.mjs reads those
// old lists from git and checks every name they refused.
//
// HOW TO ADD ONE: find the provider's own docs that say customers get names
// under the zone. Put it in ANY_DEPTH when customers sit at varying depths or
// the zone resolves any name (every wildcard under it is refused), or in
// PLATFORM when each customer is one label under it (the zone itself is
// refused; a wildcard under one customer's own name is allowed). Add a row to
// the provider-zone table test in public-suffix.test.mjs.
const ANY_DEPTH = [
  // "resolves anything": 1.2.3.4.nip.io resolves to 1.2.3.4, *.lvh.me to 127.0.0.1.
  "nip.io", "sslip.io", "xip.io", "localtest.me", "lvh.me",
  // Cloud namespaces that nest customers by region and service. The PSL lists
  // only some sub-zones (s3, elb), not e.g. cache.amazonaws.com or database.windows.net.
  "amazonaws.com", "windows.net", "cloudapp.net", "googleusercontent.com",
  // From the 2d review: Kudu sites under scm.azurewebsites.net, Azure VMs under
  // <region>.cloudapp.azure.com.
  "scm.azurewebsites.net", "cloudapp.azure.com",
];
const PLATFORM = [
  // main's TENANT list (live-hosts.mjs at cc2690d), kept whole.
  "cloudfront.net", "azurewebsites.net", "appspot.com", "web.app", "firebaseapp.com", "blogspot.com",
  "github.io", "gitlab.io", "pages.dev", "workers.dev", "vercel.app", "netlify.app", "herokuapp.com",
  "fly.dev", "onrender.com", "railway.app", "up.railway.app", "ngrok.io", "ngrok-free.app",
  "trycloudflare.com", "myshopify.com", "wordpress.com", "wixsite.com",
];
// main's grant-store PUBLIC_SUFFIXES entries that are not above (all are in the
// PSL today; kept so a later PSL can never drop one).
const OLD_SUFFIXES = [
  "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au", "co.nz", "net.nz", "org.nz", "govt.nz",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp", "com.br", "net.br", "org.br", "gov.br",
  "co.in", "net.in", "org.in", "gov.in", "ac.in", "com.cn", "net.cn", "org.cn", "gov.cn",
  "co.za", "org.za", "gov.za", "com.mx", "com.ar", "com.sg", "com.hk", "com.tw", "com.tr",
  "s3.amazonaws.com", "blob.core.windows.net",
];
// main's SECOND_LEVEL rule: "<com|co|org|net|gov|edu|ac>.<two letters>", a country's
// second-level domain, whether or not the PSL lists that one.
const SECOND_LEVEL = new Set(["com", "co", "org", "net", "gov", "edu", "ac"]);
const under = (name, entry) => name === entry || name.endsWith(`.${entry}`);

const secondLevel = (b) => {
  const labels = b.split(".");
  return labels.length === 2 && SECOND_LEVEL.has(labels[0]) && /^[a-z]{2}$/.test(labels[1]);
};
const byList = (b) => ANY_DEPTH.some((e) => under(b, e)) || PLATFORM.includes(b) || OLD_SUFFIXES.includes(b) || secondLevel(b) || registrableDomain(b)?.split(".")[0] === "blogspot";
const byPsl = (b) => isPublicSuffix(b) || hasSuffixUnder(b);

// Which rules refuse a wildcard base, each on its own: the Public Suffix List,
// the hand rules above. For the provider-zone table and its test.
export function wildcardRefusalSources(base) {
  const b = ascii(base);
  return { psl: byPsl(b), list: byList(b) };
}

// A sentence when a wildcard grant "*.<base>" would cover names that belong to
// other people, else null. The one rule for every caller (the create route in
// live-hosts.mjs and the grant store):
//   - a hand rule above (ANY_DEPTH at any depth, a PLATFORM itself, a country's
//     second-level domain, a blogspot country domain);
//   - the base is a public suffix (ICANN or PRIVATE): *.com, *.co.uk, *.vercel.app;
//   - a public suffix lies under the base: *.r.appspot.com, *.run.app.
// A wildcard under one tenant's own name on a platform (*.myapp.vercel.app) is
// that tenant's space: its base is a registrable domain with no suffix under it.
export function sharedWildcardRefusal(base) {
  const b = ascii(base);
  const shown = `*.${b}`;
  const deep = ANY_DEPTH.find((e) => under(b, e));
  if (deep) return `"${shown}" covers hosts that belong to other people: names under ${deep} are shared or resolve to any address. Name the exact hosts instead.`;
  if (registrableDomain(b)?.split(".")[0] === "blogspot") return `"${shown}" covers hosts that belong to other people: every blog gets a name under it. Name the exact hosts instead.`;
  const s = suffixOf(b);
  if (PLATFORM.includes(b) || (s?.suffix === b && s.section === "private")) {
    return `"${shown}" covers hosts that belong to other people: every customer of ${b} gets a name under it. Use your own name, for example *.yourapp.${b}.`;
  }
  if (OLD_SUFFIXES.includes(b) || s?.suffix === b) {
    return `"${shown}" covers hosts that belong to other people: ${b} is a public suffix. Use your own name under it, for example *.example.${b}.`;
  }
  if (secondLevel(b)) {
    return `"${shown}" covers hosts that belong to other people: ${b} is a country's second-level domain. Use your own name under it, for example *.example.${b}.`;
  }
  if (hasSuffixUnder(b)) return `"${shown}" covers hosts that belong to other people: names under ${b} are handed out to customers. Name the exact hosts instead.`;
  return null;
}
