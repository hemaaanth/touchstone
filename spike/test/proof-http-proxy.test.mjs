// The recording proxy writes the path the ORIGIN received, not a normalised one.
// It runs the real proxy source (RECORDER) as a child process on a loopback
// origin, so no Docker is needed.
//
//   node --experimental-test-module-mocks --test test/proof-http-proxy.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { RECORDER, REC_MARKER } from "../lib/proof-http.mjs";

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const rawGet = (port, path) => new Promise((res, rej) => {
  const c = net.connect(port, "127.0.0.1", () => c.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
  let buf = ""; c.on("data", (d) => (buf += d)); c.on("end", () => res(buf)); c.on("error", rej);
});

test("the proxy records the raw path (no // or /../ collapsing), without ?query or #fragment", async () => {
  const seen = [];
  const origin = http.createServer((req, res) => { seen.push(req.url); res.end("ok"); });
  await new Promise((r) => origin.listen(0, "127.0.0.1", r));
  const port = await freePort();
  const src = RECORDER.replace(/\.listen\(\d+, "0\.0\.0\.0"\)/, `.listen(${port}, "127.0.0.1")`);
  const proxy = spawn(process.execPath, ["--input-type=module", "-e", src], { env: { ...process.env, ORIGIN_BASE_URL: `http://127.0.0.1:${origin.address().port}`, PROBE_SECRET: "" } });
  let out = ""; proxy.stdout.on("data", (d) => (out += d));
  try {
    for (let i = 0; i < 50; i++) { try { await rawGet(port, "/ready"); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    out = "";
    await rawGet(port, "//x/mcp");
    await rawGet(port, "/a/../mcp?x=1");
    await rawGet(port, "/mcp?y=2");
    await new Promise((r) => setTimeout(r, 300));
    const paths = out.split("\n").filter((l) => l.startsWith(REC_MARKER)).map((l) => JSON.parse(l.slice(REC_MARKER.length)));
    // Negative: a normalised path would read "/mcp" for the first two.
    assert.deepEqual(paths.map((e) => e.path), ["//x/mcp", "/a/../mcp", "/mcp"]);
    // Positive: the query stays in url, and a plain path is unchanged.
    assert.match(paths[1].url, /\?x=1$/);
    assert.match(paths[2].url, /\/mcp\?y=2$/);
  } finally { proxy.kill(); origin.close(); }
});

// An upstream MITM proxy (lib/intercept.mjs) forwards in absolute-form. The
// origin must still receive the origin-form path, and the transcript must hold
// that same path -- never the absolute URL.
test("an absolute-form proxy request is recorded and forwarded as origin-form", async () => {
  const seen = [];
  const origin = http.createServer((req, res) => { seen.push(req.url); res.end("ok"); });
  await new Promise((r) => origin.listen(0, "127.0.0.1", r));
  const port = await freePort();
  const src = RECORDER.replace(/\.listen\(\d+, "0\.0\.0\.0"\)/, `.listen(${port}, "127.0.0.1")`);
  const proxy = spawn(process.execPath, ["--input-type=module", "-e", src], { env: { ...process.env, ORIGIN_BASE_URL: `http://127.0.0.1:${origin.address().port}`, PROBE_SECRET: "" } });
  let out = ""; proxy.stdout.on("data", (d) => (out += d));
  try {
    for (let i = 0; i < 50; i++) { try { await rawGet(port, "/ready"); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    out = "";
    await rawGet(port, `http://lab:8080/api/v1/rpc?k=1`);
    await new Promise((r) => setTimeout(r, 300));
    const paths = out.split("\n").filter((l) => l.startsWith(REC_MARKER)).map((l) => JSON.parse(l.slice(REC_MARKER.length)));
    assert.equal(seen.at(-1), "/api/v1/rpc?k=1", "the origin saw the origin-form path");
    assert.equal(paths.at(-1).path, "/api/v1/rpc");
    assert.match(paths.at(-1).url, /\/api\/v1\/rpc\?k=1$/);
  } finally { proxy.kill(); origin.close(); }
});
