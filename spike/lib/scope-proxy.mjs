// The scope proxy — one gate all target-bound traffic passes through.
//
// WHY THIS EXISTS. A live module must reach only the hosts a grant names, and
// nothing else. The proxy is that one gate. It holds an allow-list (the hosts
// from the active grants, see lib/grant-store.mjs allowedHosts). Every request
// is decided against the list: a request to a listed host is forwarded; a
// request to any other host is blocked with 403 and never leaves the gate. The
// gate writes one log line per request. The log is the evidence that a run
// stayed in bounds: it shows exactly which hosts a run reached, and which it was
// stopped from reaching.
//
// TWO PARTS, used together:
//   - decide(allowSet, host): the pure rule. No I/O. Easy to test, and the same
//     rule the browser seam uses before it opens a page (lib/browser.mjs).
//   - startScopeProxy({ allowedHosts }): a running HTTP forward proxy. A module's
//     network seam points at it. It forwards allowed requests and records every
//     one. It is the gate for script traffic (the http-proof request script, a
//     tool that makes requests).
//
// THE SEAM. A module never calls this directly. The platform points the module's
// network at the proxy and starts the proxy from the grant. Swapping a direct
// network for this gated one happens here, behind the seam, with no change to
// any module (WAVE2.md SEAM rule).
//
// WHAT IT IS NOT. This gate does not weaken TLS. For an `https://` target it
// uses CONNECT and checks the host, then tunnels the bytes it cannot read; the
// log still records the host and that it was allowed. For an `http://` target it
// reads the request line and forwards it, recording the method, URL, and status.
// Either way the host decision happens before any byte reaches the target.
import http from "node:http";
import net from "node:net";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// hostCovers lets a grant entry like "*.example.com" cover a subdomain. We take
// it from the grant store so the proxy and the grant agree on one matching rule.
import { hostCovers, ipKind } from "./grant-store.mjs";

// --- SSRF / DNS-rebinding guard ---------------------------------------------
//
// A grant names a public host. A name is not an address: a granted name can
// resolve (now, or on a second lookup) to a loopback, a private LAN, or the
// cloud metadata address 169.254.169.254. So the allow-list match (decide) is
// not enough — the gate must also check the ADDRESS the host resolves to, and
// then connect to THAT address, so a rebind between the check and the connect
// cannot slip through. This predicate marks the addresses the gate refuses.
// Same ranges as lib/fetch.mjs isBlockedAddress; kept here as a small pure copy
// so the proxy depends on nothing heavy. `allowPrivate` opts a run into private
// space on purpose (a grant for the operator's own LAN, or a test's 127.0.0.1).
function isBlockedAddress(addr) {
  const fam = isIP(addr);
  if (fam === 4) {
    const p = addr.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = p;
    if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
    if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
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
    const m = a.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isBlockedAddress(m[1]); // IPv4-mapped — re-check the embedded v4
    return false;
  }
  return true; // not a recognizable IP literal
}

// Resolve a request host to a single address to connect to, refusing any host
// that resolves to a blocked address (unless allowPrivate). Returns
// { ok, address, family, reason }. A bare IP literal is checked directly with no
// lookup. When ALL resolved addresses pass, the first one is PINNED and returned,
// so the caller connects to exactly the address that was checked — never a second
// lookup that could answer differently (DNS rebinding).
// Even with allowPrivate, these are never reached: cloud metadata, link-local,
// the unspecified address, and multicast/reserved space. The opt-in is for a
// loopback or private lab only. ipKind decides on the parsed address.
const NEVER = new Set(["metadata", "link-local", "unspecified", "reserved"]);
const neverReach = (addr) => NEVER.has(ipKind(addr));
// Without the opt-in, only a public address passes. ipKind also catches the
// spellings isBlockedAddress does not parse, like ::ffff:7f00:1.
const blocked = (addr) => isBlockedAddress(addr) || ipKind(addr) !== "public";

// A localhost name (RFC 6761): "localhost" or "*.localhost", in any case, with
// or without trailing dots. A grant for "localhost" covers "localhost." too, and
// the resolver may send that form to DNS. So a localhost name is pinned to
// loopback at run time: every answer must be a loopback address, whatever DNS
// says, or the request is refused.
const isLocalhostName = (h) => {
  const n = String(h || "").toLowerCase().replace(/\.+$/, "");
  return n === "localhost" || n.endsWith(".localhost");
};

// `resolve` is the DNS lookup; a test passes a stand-in to fake the answers.
export async function resolvePinned(host, allowPrivate, resolve = lookup) {
  // A URL hostname keeps IPv6 brackets ("[::1]"); the address is inside them.
  const h = String(host || "").replace(/^\[(.*)\]$/, "$1");
  if (isIP(h)) {
    if (!allowPrivate && blocked(h)) return { ok: false, reason: `non-public address ${h}` };
    if (neverReach(h)) return { ok: false, reason: `never-reachable address ${h}` };
    return { ok: true, address: h, family: isIP(h) };
  }
  let addrs;
  try {
    addrs = await resolve(h, { all: true });
  } catch {
    return { ok: false, reason: `could not resolve ${h}` };
  }
  if (!addrs.length) return { ok: false, reason: `${h} resolved to nothing` };
  const localName = isLocalhostName(h);
  for (const { address } of addrs) {
    if (localName && ipKind(address) !== "loopback") return { ok: false, reason: `${h} is a localhost name but resolves to a non-loopback address (${address})` };
    if (!allowPrivate && blocked(address)) return { ok: false, reason: `${h} resolves to a non-public address (${address})` };
    if (neverReach(address)) return { ok: false, reason: `${h} resolves to a never-reachable address (${address})` };
  }
  const first = addrs[0];
  return { ok: true, address: first.address, family: first.family };
}

// The pure rule. Given the allow-list and one request host, allow or block.
// allowSet is any iterable of host entries (exact hosts or "*." wildcards).
// Returns { allowed, reason }. An empty allow-list blocks everything: no grant,
// no reach.
export function decide(allowSet, host) {
  // Strip a ":port", but never from a bare IPv6 literal like "fd00::1".
  const raw = String(host || "").toLowerCase();
  const h = isIP(raw) ? raw : raw.replace(/:\d+$/, "");
  if (!h) return { allowed: false, reason: "no host" };
  const entries = [...(allowSet || [])];
  if (!entries.length) return { allowed: false, reason: "empty allow-list (no grant)" };
  for (const e of entries) {
    if (hostCovers(e, h)) return { allowed: true, reason: `allowed by ${e}` };
  }
  return { allowed: false, reason: `not on allow-list (${entries.length} host${entries.length === 1 ? "" : "s"} allowed)` };
}

// The log. One line per request. The line is the evidence. We keep the lines in
// memory and also write each as one JSON line to a sink (default stderr), so a
// run can read the gate's own record out of band, the way the http-proof
// recorder does. A record never carries a request body or a response body: the
// host, the method, the URL, the decision, and the status are the evidence; the
// payloads are the module's own to record if it needs them.
export class ScopeLog {
  constructor({ sink } = {}) {
    this.records = [];
    // sink is a function that takes one formatted line. Default: write to
    // stderr with a fixed prefix, so a parent can grep it apart from other
    // output, like the http-proof recorder's __TOUCHSTONE_REC__ prefix.
    this.sink = sink || ((line) => { try { process.stderr.write(line + "\n"); } catch { /* ignore a closed pipe */ } });
  }

  record(entry) {
    const rec = {
      t: Date.now(),
      host: entry.host ?? null,
      method: entry.method ?? null,
      url: entry.url ?? null,
      decision: entry.allowed ? "allow" : "block",
      reason: entry.reason ?? null,
      status: entry.status ?? null,
    };
    this.records.push(rec);
    this.sink("__TOUCHSTONE_SCOPE__ " + JSON.stringify(rec));
    return rec;
  }

  // The hosts a run actually reached (allowed), deduplicated, in first-seen
  // order. This is the "where did it go" summary for a report.
  reached() {
    const seen = [];
    for (const r of this.records) if (r.decision === "allow" && r.host && !seen.includes(r.host)) seen.push(r.host);
    return seen;
  }

  // The hosts a run was stopped from reaching, deduplicated. This is the "what
  // did the gate block" summary: an empty list is the clean case.
  blocked() {
    const seen = [];
    for (const r of this.records) if (r.decision === "block" && r.host && !seen.includes(r.host)) seen.push(r.host);
    return seen;
  }

  summary() {
    return {
      total: this.records.length,
      allowed: this.records.filter((r) => r.decision === "allow").length,
      blocked: this.records.filter((r) => r.decision === "block").length,
      reached: this.reached(),
      blockedHosts: this.blocked(),
    };
  }
}

// Read the target host from a proxied request. A forward-proxy client sends the
// absolute form: "GET http://host/path HTTP/1.1". Some clients that cannot set a
// proxy instead send the full URL in an x-touchstone-url header to the gate root.
// Support both, so the gate works for a standard HTTP_PROXY client and for a
// plain fetch that sets the header.
function httpTarget(req) {
  if (/^https?:\/\//i.test(req.url || "")) return req.url;
  const h = req.headers["x-touchstone-url"];
  if (h && /^https?:\/\//i.test(h)) return Array.isArray(h) ? h[0] : h;
  return null;
}

// Start the gate. Returns { url, port, log, stop }.
//   allowedHosts  the allow-list (from grant-store.allowedHosts()). Required to
//                 reach anything; an empty list blocks every request.
//   log           an optional ScopeLog to record into; one is made if omitted.
//   host          the interface to bind; default 127.0.0.1 (local only). The
//                 confinement sidecar (lib/reach-confine.mjs) binds 0.0.0.0 so
//                 the client container can reach it across the Docker network.
//   port          the port to bind; default 0 (an ephemeral port). The sidecar
//                 passes a fixed port so the client can name a stable gateway.
//   allowPrivate  reach hosts that resolve to loopback/private/link-local space.
//                 Off by default (an SSRF and DNS-rebinding defense); a grant for
//                 the operator's own LAN, or a test, opts in. The covering grant
//                 carries this, and lib/reach.mjs passes it here.
//   resolve       the DNS lookup; default node:dns lookup. Tests only.
export function startScopeProxy({ allowedHosts = [], log, host = "127.0.0.1", port = 0, allowPrivate = false, resolve = lookup } = {}) {
  const allow = [...allowedHosts];
  const scopeLog = log || new ScopeLog();

  const server = http.createServer((req, res) => {
    const target = httpTarget(req);
    if (!target) {
      scopeLog.record({ host: null, method: req.method, url: req.url, allowed: false, reason: "no target url", status: 400 });
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("Scope gate: no target URL. Send an absolute-form request or an x-touchstone-url header.\n");
      return;
    }
    let targetHost;
    try { targetHost = new URL(target).hostname; } catch {
      scopeLog.record({ host: null, method: req.method, url: target, allowed: false, reason: "bad target url", status: 400 });
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("Scope gate: bad target URL.\n");
      return;
    }
    const verdict = decide(allow, targetHost);
    if (!verdict.allowed) {
      scopeLog.record({ host: targetHost, method: req.method, url: target, allowed: false, reason: verdict.reason, status: 403 });
      res.writeHead(403, { "content-type": "text/plain" });
      res.end(`Scope gate: blocked ${targetHost}. ${verdict.reason}. No grant covers this host.\n`);
      return;
    }
    // Allowed by name — now check the ADDRESS and pin it, so a granted name that
    // resolves to private/metadata space is refused, and the forward connects to
    // exactly the address we checked.
    resolvePinned(targetHost, allowPrivate, resolve).then((pin) => {
      if (!pin.ok) {
        scopeLog.record({ host: targetHost, method: req.method, url: target, allowed: false, reason: pin.reason, status: 403 });
        res.writeHead(403, { "content-type": "text/plain" });
        res.end(`Scope gate: blocked ${targetHost}. ${pin.reason}.\n`);
        return;
      }
      forward(req, res, target, pin.address, (status) => {
        scopeLog.record({ host: targetHost, method: req.method, url: target, allowed: true, reason: verdict.reason, status });
      });
    });
  });

  // CONNECT handles an https:// target. The gate checks the host, then tunnels
  // the encrypted bytes. It does not read or weaken the TLS session; the log
  // still records the host and the allow/block decision.
  server.on("connect", (req, clientSocket, head) => {
    // "host:port", or "[v6]:port" for an IPv6 literal.
    const m = String(req.url || "").match(/^(\[[^\]]*\]|[^:]*)(?::(\d+))?$/);
    const [targetHost, portStr] = m ? [m[1], m[2]] : ["", ""];
    const tport = Number(portStr) || 443;
    const verdict = decide(allow, targetHost);
    if (!verdict.allowed) {
      scopeLog.record({ host: targetHost, method: "CONNECT", url: req.url, allowed: false, reason: verdict.reason, status: 403 });
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\nScope gate: blocked by grant.\r\n");
      clientSocket.end();
      return;
    }
    resolvePinned(targetHost, allowPrivate, resolve).then((pin) => {
      if (!pin.ok) {
        scopeLog.record({ host: targetHost, method: "CONNECT", url: req.url, allowed: false, reason: pin.reason, status: 403 });
        clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\nScope gate: blocked by address.\r\n");
        clientSocket.end();
        return;
      }
      // Connect to the PINNED address, not the name, so no second lookup can
      // rebind the tunnel to a different host.
      const upstream = net.connect(tport, pin.address, () => {
        scopeLog.record({ host: targetHost, method: "CONNECT", url: req.url, allowed: true, reason: verdict.reason, status: 200 });
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head && head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on("error", () => { try { clientSocket.end(); } catch { /* ignore */ } });
      clientSocket.on("error", () => { try { upstream.end(); } catch { /* ignore */ } });
    });
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const boundPort = server.address().port;
      resolve({
        url: `http://${host}:${boundPort}`,
        port: boundPort,
        log: scopeLog,
        stop: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// Forward one allowed http request to its target and stream the response back.
// Uses global fetch, so no new dependency. `pinnedAddress` is the address the
// gate already resolved and approved: we connect to THAT (by rewriting the URL
// host to the pinned IP and setting the original Host header), so fetch cannot
// re-resolve the name to a different, unchecked address. On a target error the
// gate returns 502 and logs that status.
function forward(req, res, target, pinnedAddress, done) {
  const headers = { ...req.headers };
  delete headers["x-touchstone-url"]; // the gate's own routing header, not the target's
  delete headers["proxy-connection"];
  delete headers.connection;
  // fetch frames the body itself from the buffer. A client's own chunked
  // framing must not ride along as a header, or fetch rejects the request.
  delete headers["transfer-encoding"];
  delete headers["content-length"];

  // Pin: send the request to the checked IP, but keep the original Host so the
  // target serves the right virtual host and TLS/SNI is moot (http only here).
  let pinnedUrl = target;
  try {
    const u = new URL(target);
    headers.host = u.host; // the name:port the client asked for
    u.hostname = isIP(pinnedAddress) === 6 ? `[${pinnedAddress}]` : pinnedAddress;
    pinnedUrl = u.toString();
  } catch {
    delete headers.host; // malformed — let fetch decide (it will fail safely)
  }

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0;
    try {
      const upstream = await fetch(pinnedUrl, {
        method: req.method,
        headers,
        body: hasBody ? Buffer.concat(chunks) : undefined,
        redirect: "manual",
      });
      const buf = Buffer.from(await upstream.arrayBuffer());
      const outHeaders = {};
      upstream.headers.forEach((v, k) => {
        if (k === "content-encoding" || k === "transfer-encoding" || k === "content-length") return;
        outHeaders[k] = v;
      });
      res.writeHead(upstream.status, outHeaders);
      res.end(buf);
      done(upstream.status);
    } catch (err) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`Scope gate: upstream error reaching the target. ${err?.message || ""}\n`);
      done(502);
    }
  });
}
