// The website entries a live scope may be created with, checked at the create
// route (app/server/runs.mjs addScope) BEFORE the scope store and the grant
// store see them.
//
// WHY. The grant store (grant-store.mjs normalizeHost) keeps a wildcard only in
// one spelling, "*.example.com". Any other spelling that holds a star (an
// encoded "%2A.example.com", "https://*.example.com", "*.*.example.com",
// "a.*.example.com") normalizes to nothing and is DROPPED from the grant
// without a word. The operator would believe subdomains are covered when they
// are not. This check refuses those spellings with a sentence instead.
//
// It never widens anything: it only refuses. The grant store still applies its
// own rules after it (two labels after "*.", no public suffix, no private space
// unless opted in, no wildcard in a private lab scope).

// One DNS label: 1 to 63 letters, digits or hyphens, not starting or ending
// with a hyphen.
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// The base of a wildcard entry, or null when the text is not one. Accepted:
// "*." then a plain host name of at least two labels. Nothing else: no scheme,
// no port, no path, no second star, no IP address.
export function wildcardBase(raw) {
  const text = String(raw ?? "").trim().toLowerCase();
  if (!text.startsWith("*.")) return null;
  const base = text.slice(2).replace(/\.$/, "");
  const labels = base.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  if (labels.every((l) => /^[0-9]+$/.test(l))) return null; // an IP address is not a name pattern
  return base;
}

// Does this entry try to be a wildcard? A star in any spelling counts.
const looksWild = (raw) => /\*|%2a/i.test(String(raw ?? ""));

// "*.com": a star and one label covers a whole top-level domain.
const tooBroad = (raw) => /^\*\.[a-z0-9-]+\.?$/i.test(String(raw ?? "").trim());
const tooBroadSentence = (h) => `"${String(h).trim()}" is too broad: a wildcard needs a domain name of at least two labels after "*.", so *.example.com, never *.com.`;

// A sentence that refuses the website list, or null when it may go on to the
// scope store. `hosts` is the list the create route got.
export function liveHostsRefusal(hosts) {
  const list = (Array.isArray(hosts) ? hosts : [hosts]).map((h) => String(h ?? "").trim()).filter(Boolean);
  for (const h of list) {
    if (tooBroad(h)) return tooBroadSentence(h);
    if (looksWild(h) && !wildcardBase(h)) {
      return `"${h.slice(0, 200)}" is not a wildcard entry Touchstone accepts. Write it as *.example.com: a star, a dot and a domain name, with no scheme, port or path.`;
    }
  }
  if (list.length && wildcardBase(list[0])) {
    return "List a plain website before a wildcard entry, for example example.com, then *.example.com. A run sends its requests to the first website.";
  }
  return null;
}
