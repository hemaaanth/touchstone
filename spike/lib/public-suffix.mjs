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

// Names the PSL does not hold, where every name under them can belong to
// someone else. Kept by hand, small, at any depth:
//   - "resolves anything": 1.2.3.4.nip.io resolves to 1.2.3.4, *.lvh.me to 127.0.0.1.
//   - shared namespaces the PSL lacks (from the 2d review): Kudu sites under
//     scm.azurewebsites.net, Azure VMs under <region>.cloudapp.azure.com.
const NOT_IN_PSL = ["nip.io", "sslip.io", "xip.io", "localtest.me", "lvh.me", "scm.azurewebsites.net", "cloudapp.azure.com"];
const under = (name, entry) => name === entry || name.endsWith(`.${entry}`);

// A sentence when a wildcard grant "*.<base>" would cover names that belong to
// other people, else null. The one rule for every caller (the create route in
// live-hosts.mjs and the grant store):
//   - the base is a public suffix (ICANN or PRIVATE): *.com, *.co.uk, *.vercel.app;
//   - a public suffix lies under the base: *.amazonaws.com, *.r.appspot.com;
//   - the base is in the small NOT_IN_PSL list, at any depth;
//   - the base is a blogspot country domain (blogspot.co.uk): the PSL keeps only blogspot.com.
// A wildcard under one tenant's own name on a platform (*.myapp.vercel.app) is
// that tenant's space: its base is a registrable domain with no suffix under it.
export function sharedWildcardRefusal(base) {
  const b = ascii(base);
  const shown = `*.${b}`;
  const gap = NOT_IN_PSL.find((e) => under(b, e));
  if (gap) return `"${shown}" covers hosts that belong to other people: names under ${gap} are shared or resolve to any address. Name the exact hosts instead.`;
  if (registrableDomain(b)?.split(".")[0] === "blogspot") return `"${shown}" covers hosts that belong to other people: every blog gets a name under it. Name the exact hosts instead.`;
  const s = suffixOf(b);
  if (s?.suffix === b) {
    return s.section === "private"
      ? `"${shown}" covers hosts that belong to other people: every customer of ${b} gets a name under it. Use your own name, for example *.yourapp.${b}.`
      : `"${shown}" covers hosts that belong to other people: ${b} is a public suffix. Use your own name under it, for example *.example.${b}.`;
  }
  if (hasSuffixUnder(b)) return `"${shown}" covers hosts that belong to other people: names under ${b} are handed out to customers. Name the exact hosts instead.`;
  return null;
}
