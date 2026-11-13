// One rule for a configured URL that may hold a secret: a provider base URL
// or the Daytona server URL can carry a user name, password, query or #part.
// publicUrl() is what a page may show. scrubUrl() and scrubError() take that
// raw URL out of any text that leaves the server or reaches a log: an error,
// its cause, its stack, or a response body that echoes the request URL.

// Scheme, host, port and path. A user name, password, query or #part is cut,
// and `cut` says so. A plain http or https URL comes back as it is. Not a URL,
// or another scheme: nothing is shown.
export function publicUrl(raw) {
  if (!raw) return { url: "", cut: false };
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return { url: "", cut: true };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { url: "", cut: true };
  const cut = Boolean(u.username || u.password || u.search || u.hash);
  return { url: cut ? `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, "") : String(raw), cut };
}

// The scheme, host and port of a URL ("" when it is not a URL). A saved key
// is bound to this.
export function originOf(raw) {
  try {
    const u = new URL(String(raw));
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : "";
  } catch {
    return "";
  }
}

const HIDDEN = "[hidden]";
// A part this short would match ordinary words; the whole-URL and user-info
// passes below still take it out where it sits in a URL.
const MIN_PART = 3;

// Text with each raw URL replaced by its public form, and each hidden part
// (user name, password, query, #part, as typed and decoded) replaced by
// "[hidden]". Any user name or password in any URL in the text goes too.
export function scrubUrl(text, ...raws) {
  let t = String(text ?? "");
  for (const raw of raws) {
    if (!raw) continue;
    const shown = publicUrl(raw).url || HIDDEN;
    let u = null;
    try {
      u = new URL(String(raw));
    } catch {}
    const wholes = [String(raw), u?.href, u?.href.replace(/\/+$/, "")].filter(Boolean).sort((a, b) => b.length - a.length);
    for (const w of wholes) t = t.split(w).join(shown);
    if (!u) continue;
    const parts = [u.username, u.password, u.search, u.search.slice(1), u.hash, u.hash.slice(1), ...[...u.searchParams.values()]];
    const all = new Set();
    for (const p of parts) {
      if (!p) continue;
      all.add(p);
      try {
        all.add(decodeURIComponent(p));
      } catch {}
    }
    for (const p of [...all].sort((a, b) => b.length - a.length)) if (p.length >= MIN_PART) t = t.split(p).join(HIDDEN);
  }
  return t.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi, "$1");
}

// The same for an error: its message, its stack and each cause. The error
// keeps its type, name and fields (a caller may read err.status or err.name).
export function scrubError(err, ...raws) {
  if (!err || typeof err !== "object") return new Error(scrubUrl(err, ...raws));
  for (let e = err, i = 0; e && typeof e === "object" && i < 5; e = e.cause, i++) {
    try {
      if (typeof e.message === "string") e.message = scrubUrl(e.message, ...raws);
      if (typeof e.stack === "string") e.stack = scrubUrl(e.stack, ...raws);
    } catch {}
  }
  return err;
}

// An error and its causes as one line, scrubbed. Node's fetch puts the reason
// (and sometimes the URL) in err.cause.
export function errorText(err, ...raws) {
  const out = [];
  for (let e = err, i = 0; e != null && i < 5; e = e?.cause, i++) out.push(String(e?.message ?? e));
  return scrubUrl(out.join(": "), ...raws);
}
