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

// hostCovers lets a grant entry like "*.example.com" cover a subdomain. We take
// it from the grant store so the proxy and the grant agree on one matching rule.
import { hostCovers } from "./grant-store.mjs";

// The pure rule. Given the allow-list and one request host, allow or block.
// allowSet is any iterable of host entries (exact hosts or "*." wildcards).
// Returns { allowed, reason }. An empty allow-list blocks everything: no grant,
// no reach.
export function decide(allowSet, host) {
  const h = String(host || "").toLowerCase().replace(/:\d+$/, "");
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
//   host          the interface to bind; default 127.0.0.1 (local only).
export function startScopeProxy({ allowedHosts = [], log, host = "127.0.0.1" } = {}) {
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
    // Allowed: forward the request to the target and stream the response back.
    forward(req, res, target, (status) => {
      scopeLog.record({ host: targetHost, method: req.method, url: target, allowed: true, reason: verdict.reason, status });
    });
  });

  // CONNECT handles an https:// target. The gate checks the host, then tunnels
  // the encrypted bytes. It does not read or weaken the TLS session; the log
  // still records the host and the allow/block decision.
  server.on("connect", (req, clientSocket, head) => {
    const [targetHost, portStr] = String(req.url || "").split(":");
    const port = Number(portStr) || 443;
    const verdict = decide(allow, targetHost);
    if (!verdict.allowed) {
      scopeLog.record({ host: targetHost, method: "CONNECT", url: req.url, allowed: false, reason: verdict.reason, status: 403 });
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\nScope gate: blocked by grant.\r\n");
      clientSocket.end();
      return;
    }
    const upstream = net.connect(port, targetHost, () => {
      scopeLog.record({ host: targetHost, method: "CONNECT", url: req.url, allowed: true, reason: verdict.reason, status: 200 });
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => { try { clientSocket.end(); } catch { /* ignore */ } });
    clientSocket.on("error", () => { try { upstream.end(); } catch { /* ignore */ } });
  });

  return new Promise((resolve) => {
    server.listen(0, host, () => {
      const port = server.address().port;
      resolve({
        url: `http://${host}:${port}`,
        port,
        log: scopeLog,
        stop: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// Forward one allowed http request to its target and stream the response back.
// Uses global fetch, so no new dependency. On a target error the gate returns
// 502 and logs that status.
function forward(req, res, target, done) {
  const headers = { ...req.headers };
  delete headers["x-touchstone-url"]; // the gate's own routing header, not the target's
  delete headers.host; // let fetch set the target host
  delete headers["proxy-connection"];
  delete headers.connection;

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0;
    try {
      const upstream = await fetch(target, {
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
