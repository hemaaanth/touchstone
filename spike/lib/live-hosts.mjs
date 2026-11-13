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
//
// It also refuses a wildcard over names that belong to other people: a shared
// hosting platform, a cloud provider's namespace, a domain that resolves any
// name to any address, or a country's second-level domain. The grant store's
// public-suffix list is short, so these got through.
import { domainToASCII } from "node:url";

// STOP-GAP until the full Public Suffix List is used (task L25). Two groups:
//   ANY_DEPTH  every name under it can belong to someone else, at any depth: a
//              "resolves anything" domain (1.2.3.4.nip.io is 1.2.3.4), or a
//              provider namespace whose levels are regions and services
//              (*.eu-west-1.amazonaws.com, *.blob.core.windows.net).
//   TENANT     a platform that gives each customer one name under it. The
//              wildcard of the platform itself is refused. A wildcard UNDER one
//              tenant's own name (*.myapp.vercel.app: at least one label more
//              than the platform) is that tenant's space, so it is allowed.
const ANY_DEPTH = ["nip.io", "sslip.io", "xip.io", "localtest.me", "lvh.me", "amazonaws.com", "windows.net", "cloudapp.net", "googleusercontent.com"];
const TENANT = [
  "cloudfront.net", "azurewebsites.net", "appspot.com", "web.app", "firebaseapp.com", "blogspot.com",
  "github.io", "gitlab.io", "pages.dev", "workers.dev", "vercel.app", "netlify.app", "herokuapp.com",
  "fly.dev", "onrender.com", "railway.app", "up.railway.app", "ngrok.io", "ngrok-free.app",
  "trycloudflare.com", "myshopify.com", "wordpress.com", "wixsite.com",
];
// A country's second-level domain: "com.de", "co.nz", "org.uk".
const SECOND_LEVEL = new Set(["com", "co", "org", "net", "gov", "edu", "ac"]);
const under = (base, entry) => base === entry || base.endsWith(`.${entry}`);

// A sentence when a wildcard base covers names that belong to other people, else null.
export function sharedBaseRefusal(base) {
  const shown = `*.${base}`;
  const any = ANY_DEPTH.find((e) => under(base, e));
  if (any) return `"${shown}" covers hosts that belong to other people: names under ${any} are shared or resolve to any address. Name the exact hosts instead.`;
  // The longest match: up.railway.app is listed itself, so railway.app does not hide it.
  const platform = TENANT.filter((e) => under(base, e)).sort((a, b) => b.length - a.length)[0];
  if (platform && base === platform) return `"${shown}" covers hosts that belong to other people: every customer of ${platform} gets a name under it. Use your own name, for example *.yourapp.${platform}.`;
  const labels = base.split(".");
  if (labels.length === 2 && SECOND_LEVEL.has(labels[0]) && /^[a-z]{2}$/.test(labels[1])) {
    return `"${shown}" covers hosts that belong to other people: ${base} is a country's second-level domain. Use your own name under it, for example *.example.${base}.`;
  }
  return null;
}

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
    // A name with letters outside plain ASCII: say the punycode form.
    if (looksWild(h) && [...h].some((c) => c.charCodeAt(0) > 127)) {
      const ascii = h.trim().startsWith("*.") ? domainToASCII(h.trim().slice(2).toLowerCase()) : "";
      return `"${h.slice(0, 200)}" has letters outside plain ASCII. Write the punycode form${ascii ? `: *.${ascii}` : ", for example *.xn--bcher-kva.de for *.bücher.de"}.`;
    }
    const base = wildcardBase(h);
    if (base) {
      const shared = sharedBaseRefusal(base);
      if (shared) return shared;
    }
    if (looksWild(h) && !base) {
      return `"${h.slice(0, 200)}" is not a wildcard entry Touchstone accepts. Write it as *.example.com: a star, a dot and a domain name, with no scheme, port or path.`;
    }
  }
  if (list.length && wildcardBase(list[0])) {
    return "List a plain website before a wildcard entry, for example example.com, then *.example.com. A run sends its requests to the first website.";
  }
  return null;
}
