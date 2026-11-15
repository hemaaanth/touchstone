// Tests for the capture seam (lib/intercept.mjs). Two parts:
//   1. pure: HAR -> transcript filtering, so the parser is covered with no Docker;
//   2. live: an origin, the run recorder and mitmdump on two internal networks,
//      and one client container that only reaches the origin through the proxy.
// The live part skips HONESTLY when its two images are absent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harEntries, captureThrough, keepHar, MITM_IMAGE } from "../lib/intercept.mjs";
import { startLab, stopLab } from "../lib/proof-http.mjs";

const NODE_IMAGE = "node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0";
const PROBE = "probe-secret-123";

function have(image) {
  try { execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" }); return true; } catch { return false; }
}
const haveBoth = have(MITM_IMAGE) && have(NODE_IMAGE);
const skip = haveBoth ? false : `missing image: ${!have(MITM_IMAGE) ? MITM_IMAGE : NODE_IMAGE}`;

test("harEntries keeps real calls, drops probes, splits path from query", () => {
  const har = JSON.stringify({ log: { entries: [
    { request: { method: "GET", url: "http://lab:8080/healthz", headers: [{ name: "x-touchstone-probe", value: PROBE }] },
      response: { status: 200, headers: [], content: { text: "ok" } } },
    { request: { method: "POST", url: "http://lab:8080/api/rpc?trace=1", headers: [{ name: "x-wallet-session", value: "s1" }],
      postData: { text: JSON.stringify({ method: "eth_signTypedData_v4" }) } },
      response: { status: 200, headers: [], content: { mimeType: "application/json",
        text: Buffer.from(JSON.stringify({ ok: true })).toString("base64"), encoding: "base64" } } },
    { request: { method: "GET", url: "https://cdn.example/x.js", headers: [] }, response: { status: 200, headers: [], content: {} } },
  ] } });

  const out = harEntries(har, { probeSecret: PROBE, origin: "http://lab:8080" });
  assert.equal(out.length, 2, "the probe is dropped, the CDN call stays");
  const call = out[0];
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/api/rpc", "the query is cut from path");
  assert.equal(call.url, "http://lab:8080/api/rpc?trace=1", "the query survives in url");
  assert.equal(call.reqHeaders["x-wallet-session"], "s1");
  assert.equal(call.reqBody.method, "eth_signTypedData_v4");
  assert.equal(call.status, 200);
  assert.deepEqual(call.resBody, { ok: true }, "a base64 body is decoded");
  assert.equal(out[1].path, "/x.js");
  assert.deepEqual(harEntries("not json", {}), []);
});

// Runs inside the client container. undici's fetch ignores HTTP_PROXY, so the
// calls use an explicit proxy request line: that is what HTTP_PROXY means.
const CLIENT = `
const http = require("node:http");
const call = (path, init = {}) => new Promise((resolve, reject) => {
  const body = init.body ? Buffer.from(init.body) : null;
  const r = http.request({ host: "mitm", port: 8080, path: "http://lab:8080" + path, method: init.method || "GET",
    headers: { host: "lab:8080", "content-type": "application/json", ...(init.headers || {}),
               ...(body ? { "content-length": body.length } : {}) } }, (res) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
  });
  r.on("error", reject);
  if (body) r.write(body);
  r.end();
});
(async () => {
  const a = await call("/api/rpc", { method: "POST", headers: { "x-wallet-session": "sess-abc" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_signTypedData_v4", params: [] }) });
  const b = await call("/api/private", { headers: { "x-wallet-session": "sess-abc" } });
  console.log(JSON.stringify({ a: a.status, b: b.status }));
})().catch((e) => { console.error(e.message); process.exit(1); });
`;

// A tiny origin. /healthz answers the readiness probe; everything else echoes.
const ORIGIN = `
const http = require("node:http");
http.createServer((req, res) => { const c = []; req.on("data", (b) => c.push(b)); req.on("end", () => {
  if (req.url === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok"); }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ path: req.url, session: req.headers["x-wallet-session"] || null, body: c.length ? JSON.parse(Buffer.concat(c)) : null }));
}) }).listen(8080, "0.0.0.0");
`;

test("a client is recorded through the proxy and the client never reaches the origin directly", { skip }, async () => {
  const handle = await startLab({ image: NODE_IMAGE, labEntrypoint: "node", labCmd: ["-e", ORIGIN], readyPath: "/healthz" });
  const dir = mkdtempSync(join(tmpdir(), "cap-"));
  const ws = mkdtempSync(join(tmpdir(), "capws-"));
  try {
    const run = await captureThrough({ net: handle.net, upstream: handle.netBaseUrl, probeSecret: handle.probeSecret, origin: handle.netBaseUrl }, { image: NODE_IMAGE, cmd: ["-e", CLIENT] }, { dir, timeoutMs: 60_000 });
    assert.equal(run.proxied, true, "a HAR was written");
    assert.equal(run.dropped, 0, "readiness is a bare TCP connect, so no probe entry exists");
    assert.equal(run.transcript.length, 2, `two calls recorded, probe excluded: ${JSON.stringify(run.transcript.map((e) => e.path))}`);
    const [rpc, priv] = run.transcript;
    assert.equal(rpc.method, "POST");
    assert.equal(rpc.path, "/api/rpc");
    assert.equal(rpc.reqBody.method, "eth_signTypedData_v4");
    assert.equal(rpc.reqHeaders["x-wallet-session"], "sess-abc");
    assert.equal(rpc.status, 200);
    assert.equal(priv.path, "/api/private");
    assert.equal(run.transcript.some((e) => e.path === "/healthz"), false);

    const har = readFileSync(run.harPath, "utf8");
    assert.match(har, /eth_signTypedData_v4/);
    const kept = keepHar(ws, dir, "proof/one");
    assert.ok(kept && existsSync(kept));
    assert.match(kept, /captures\/proof-one\.har$/);
  } finally {
    await stopLab(handle);
    rmSync(dir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});
