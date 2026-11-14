// The egress log of a free-roam machine. It runs ON the machine, not on the
// host: `node egress-log.mjs <port> <log file>`. Node built-ins only.
// A third argument sets the CONNECT timer in ms (the test uses a short one).
//
// It is a forward proxy that allows every request and writes one line per
// request. It is a log, not a wall: a request that does not use the proxy
// variables is not listed. The lines are "requests seen by the log".
//
// One line is one JSON record in the ScopeLog shape (lib/scope-proxy.mjs):
//   { t, host, method, url, decision: "allow", reason: "free-roam", status }
// No request body and no response body is logged. HTTPS is a CONNECT tunnel:
// the proxy does not read TLS, so the line holds the host and the port only,
// and `status` is null (a tunnel has no status).
import http from "node:http";
import net from "node:net";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const port = Number(process.argv[2]);
const file = process.argv[3];
const timerArg = Number(process.argv[4]);
const connectMs = Number.isFinite(timerArg) && timerArg > 0 && timerArg <= 2_147_483_647 ? timerArg : 30_000;
mkdirSync(dirname(file), { recursive: true });

// The host drops a line with a longer host or URL (lib/roam-egress.mjs), so
// cut here: a long URL must still give a line.
function log(host, method, url, status) {
  const rec = { t: Date.now(), host: host.slice(0, 253), method, url: url.slice(0, 2000), decision: "allow", reason: "free-roam", status };
  appendFileSync(file, JSON.stringify(rec) + "\n");
}

// Plain HTTP: the client sends the absolute form, "GET http://host/path".
const server = http.createServer((req, res) => {
  let target = null;
  try { target = new URL(req.url); } catch { /* not an absolute URL */ }
  if (target?.protocol !== "http:") {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("egress log: send an absolute http:// URL, or CONNECT for https.\n");
    return;
  }
  const headers = { ...req.headers };
  delete headers["proxy-connection"];
  delete headers.connection;
  let logged = false;
  const once = (status) => { if (!logged) { logged = true; log(target.hostname, req.method, req.url, status); } };
  const upstream = http.request(target, { method: req.method, headers }, (r) => {
    once(r.statusCode);
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  upstream.on("error", () => {
    once(502);
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end();
  });
  // A target that never answers gives no response and no error. When the
  // client leaves, end the upstream: its error handler writes the line (502).
  res.on("close", () => { if (!logged) upstream.destroy(); });
  req.pipe(upstream);
});

// HTTPS: "CONNECT host:port". An open tunnel has no status (null). A tunnel
// that did not open is logged with the proxy's own answer, 502.
server.on("connect", (req, client, head) => {
  // "host:port", or "[v6]:port" for an IPv6 literal.
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(req.url || "");
  if (!m) { client.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
  const host = m[1];
  const tport = Number(m[2]) || 443;
  const url = `${host}:${tport}`;
  let open = false;
  const upstream = net.connect(tport, host.replace(/^\[|\]$/g, ""), () => {
    open = true;
    upstream.setTimeout(0);
    log(host, "CONNECT", url, null);
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  // An address that does not answer: do not wait for the OS to give up. The
  // timer is for the connect only; an open tunnel can be silent.
  upstream.setTimeout(connectMs, () => upstream.destroy(new Error("timeout")));
  upstream.on("error", () => {
    if (open) { client.destroy(); return; }
    log(host, "CONNECT", url, 502);
    client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  client.on("error", () => upstream.destroy());
});

// A second copy (the port is taken) must end, not stay as a dead process.
server.on("error", () => process.exit(1));
// One broken socket must not end the log for every later request.
process.on("uncaughtException", () => {});
server.listen(port, "127.0.0.1");
