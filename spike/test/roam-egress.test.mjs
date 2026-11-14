// Tests for the egress log of a free-roam machine (I2): roam/egress-log.mjs
// (the proxy that runs on the machine) and lib/roam-egress.mjs (the host side).
//
// No Daytona call and no outside network. The "machine" is a fake of the I1
// contract, { id, exec, upload }. Its exec runs the real command text with the
// local sh, with the machine's fixed paths and port mapped to a temp folder and
// a free loopback port. So the start command, the pull command and the proxy
// are the real ones.
//
//   node --test spike/test/roam-egress.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EGRESS_ENV, pullEgressLog, startEgressLog } from "../lib/roam-egress.mjs";

const dir = mkdtempSync(join(tmpdir(), "touchstone-egress-test-"));
process.env.EVENTS_FILE = join(dir, "events.jsonl");
const groups = []; // the process group of each start command: the proxy stays in it

after(() => {
  for (const pid of groups) { try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ } }
  rmSync(dir, { recursive: true, force: true });
});

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

function localMachine(id, port = 1) {
  const home = join(dir, id);
  mkdirSync(join(home, "log"), { recursive: true });
  const log = join(home, "log", "egress.jsonl");
  const local = (s) => s.replaceAll("8899", String(port))
    .replaceAll("/tmp/touchstone-egress-log.mjs", join(home, "egress-log.mjs"))
    .replaceAll("/var/log/touchstone/egress.jsonl", log);
  const m = {
    id, log, commands: [], uploads: [], results: [],
    upload: async (path, bytes) => { m.uploads.push(path); writeFileSync(local(path), bytes); },
    exec: (command, seconds) => new Promise((resolve, reject) => {
      m.commands.push({ command, seconds });
      const child = spawn("sh", ["-c", local(command)], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
      if (command.includes("nohup")) groups.push(child.pid);
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { out += d; });
      child.on("error", reject);
      child.on("close", (code) => { m.results.push(out); resolve({ exitCode: code, result: out }); });
    }),
  };
  return m;
}

const line = (over = {}) => JSON.stringify({ t: 1, host: "a.example", method: "GET", url: "http://a.example/", decision: "allow", reason: "free-roam", status: 200, ...over });
const rec = (over = {}) => ({ t: 1, host: "a.example", method: "GET", url: "http://a.example/", decision: "allow", reason: "free-roam", status: 200, ...over });
const events = () => (existsSync(process.env.EVENTS_FILE) ? readFileSync(process.env.EVENTS_FILE, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [])
  .filter((e) => e.ev === "egress-log");

// One request through the proxy. Plain HTTP: the absolute form. Returns { status, body }.
function viaProxy(port, method, url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: url, headers: { host: new URL(url).host }, agent: false }, (res) => {
      let text = "";
      res.on("data", (d) => { text += d; });
      res.on("end", () => resolve({ status: res.statusCode, body: text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

// One CONNECT through the proxy, then one HTTP request inside the tunnel.
// Returns { status, body }: the proxy's answer and the bytes from the tunnel.
function tunnel(port, target) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "CONNECT", path: target, agent: false });
    req.on("error", reject);
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); resolve({ status: res.statusCode, body: "" }); return; }
      let text = "";
      socket.on("data", (d) => { text += d; });
      socket.on("end", () => resolve({ status: res.statusCode, body: text }));
      socket.on("error", reject);
      socket.write("GET /in-tunnel HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    });
    req.end();
  });
}

test("EGRESS_ENV is the fixed string of the contract", () => {
  assert.equal(EGRESS_ENV, "export HTTP_PROXY=http://127.0.0.1:8899 HTTPS_PROXY=http://127.0.0.1:8899 http_proxy=http://127.0.0.1:8899 https_proxy=http://127.0.0.1:8899; ");
});

test("the real proxy on 127.0.0.1: start, one HTTP request and one CONNECT, both logged and pulled", async () => {
  const seen = [];
  const target = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(req.url.startsWith("/teapot") ? 418 : 200, { "content-type": "text/plain" });
    res.end("short and stout");
  });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  const tport = target.address().port;
  const port = await freePort();
  const m = localMachine("m-real", port);
  try {
    // Start: the script is uploaded, then one background start that returns.
    await startEgressLog(m);
    assert.deepEqual(m.uploads, ["/tmp/touchstone-egress-log.mjs"]);
    assert.deepEqual(readFileSync(join(dir, "m-real", "egress-log.mjs")), readFileSync(new URL("../roam/egress-log.mjs", import.meta.url)));
    assert.equal(m.commands.length, 1);
    assert.match(m.commands[0].command, /^sh -c '\(nohup node \/tmp\/touchstone-egress-log\.mjs 8899 \/var\/log\/touchstone\/egress\.jsonl >\/dev\/null 2>&1 &\);/);
    assert.deepEqual(await pullEgressLog(m), [], "no request yet");

    const before = Date.now();
    const plain = await viaProxy(port, "POST", `http://127.0.0.1:${tport}/teapot?x=1`, "the request body");
    assert.deepEqual(plain, { status: 418, body: "short and stout" });
    const tun = await tunnel(port, `127.0.0.1:${tport}`);
    assert.equal(tun.status, 200);
    assert.match(tun.body, /^HTTP\/1\.1 200 OK[\s\S]*short and stout/, "the target's answer came through the tunnel");
    assert.deepEqual(seen, ["POST /teapot?x=1", "GET /in-tunnel"]);

    // The file on the machine: the fixed line shape, and no body.
    const file = readFileSync(m.log, "utf8");
    assert.equal(file.includes("short and stout") || file.includes("the request body"), false);
    for (const l of file.trim().split("\n")) {
      assert.deepEqual(Object.keys(JSON.parse(l)), ["t", "host", "method", "url", "decision", "reason", "status"]);
    }

    const got = await pullEgressLog(m);
    for (const r of got) {
      assert.deepEqual(Object.keys(r), ["t", "host", "method", "url", "decision", "reason", "status"]);
      assert.ok(r.t >= before && r.t <= Date.now(), "t is Date.now() of the request");
    }
    assert.deepEqual(got.map((r) => ({ ...r, t: 1 })), [
      rec({ host: "127.0.0.1", method: "POST", url: `http://127.0.0.1:${tport}/teapot?x=1`, status: 418 }),
      // A tunnel has no status.
      rec({ host: "127.0.0.1", method: "CONNECT", url: `127.0.0.1:${tport}`, status: null }),
    ]);
    assert.deepEqual(events().map(({ requests, hosts }) => ({ requests, hosts })), [{ requests: 2, hosts: ["127.0.0.1"] }]);

    // Only new lines come back. No new line: no event.
    assert.deepEqual(await pullEgressLog(m), []);
    assert.equal(events().length, 1);

    // A request that fails is logged with the proxy's own answer.
    const dead = await freePort();
    assert.equal((await viaProxy(port, "GET", `http://127.0.0.1:${dead}/gone`)).status, 502);
    assert.equal((await tunnel(port, `127.0.0.1:${dead}`)).status, 502);
    assert.deepEqual((await pullEgressLog(m)).map((r) => [r.method, r.url, r.status]), [
      ["GET", `http://127.0.0.1:${dead}/gone`, 502],
      ["CONNECT", `127.0.0.1:${dead}`, 502],
    ]);
    assert.equal(events().at(-1).requests, 4);

    // A request that is not a proxy request is refused and not logged.
    assert.equal((await viaProxy(port, "GET", "/not-a-proxy-request").catch(() => ({ status: 400 }))).status, 400);

    // A second start on the same machine does no harm: the port still answers
    // and the old lines do not come back.
    await startEgressLog(m);
    assert.deepEqual(await pullEgressLog(m), []);
  } finally {
    await new Promise((r) => target.close(r));
  }
});

test("startEgressLog throws when the port does not answer: no log, no shell", async () => {
  const calls = [];
  const m = {
    id: "m-no-node",
    upload: async (path) => { calls.push(["upload", path]); },
    exec: async (command, seconds) => { calls.push(["exec", seconds]); return { exitCode: 1, result: "" }; },
  };
  await assert.rejects(startEgressLog(m), /did not start on machine m-no-node[\s\S]*No log, no shell/);
  assert.deepEqual(calls, [["upload", "/tmp/touchstone-egress-log.mjs"], ["exec", 60]]);
});

test("pullEgressLog drops a line that is not JSON and a line with a wrong shape", async () => {
  const m = localMachine("m-shape");
  const longHost = "h".repeat(253);
  const longUrl = "http://a.example/" + "u".repeat(2000 - 17);
  writeFileSync(m.log, [
    line(),
    "this is not JSON",
    "",
    "null", "42", "[1]", '"text"',
    line({ host: "h".repeat(254) }),
    line({ host: 7 }),
    line({ url: longUrl + "u" }),
    line({ url: null }),
    line({ method: "HACK" }),
    line({ method: "get" }),
    line({ status: "200" }),
    line({ status: 200.5 }),
    line({ t: "now" }),
    line({ t: null }),
    JSON.stringify({ host: "a.example", method: "GET", url: "http://a.example/", status: 200 }), // no t
    // The machine's own words are not kept: decision and reason are set by the host, extra fields go.
    line({ host: "b.example", decision: "block", reason: "the child wrote this", proven: true, extra: { deep: 1 } }),
    line({ host: longHost, url: longUrl, method: "CONNECT", status: null }),
  ].join("\n") + "\n");
  assert.deepEqual(await pullEgressLog(m), [
    rec(),
    rec({ host: "b.example" }),
    rec({ host: longHost, url: longUrl, method: "CONNECT", status: null }),
  ]);
});

test("pullEgressLog reads at most 256 KB per pull, and loses no line of a larger file", async () => {
  const m = localMachine("m-big");
  const all = Array.from({ length: 5000 }, (_, i) => line({ url: `http://a.example/${i}` }));
  writeFileSync(m.log, all.join("\n") + "\n");
  assert.ok(Buffer.byteLength(all.join("\n")) > 2 * 262144, "the file is larger than two pulls");
  const urls = [];
  for (let pulls = 1; ; pulls++) {
    const got = await pullEgressLog(m);
    assert.ok(Buffer.from(m.results.at(-1), "base64").length <= 262144, "one pull is at most 256 KB");
    if (!got.length) { assert.equal(pulls, 4, "three pulls with lines, then an empty one"); break; }
    urls.push(...got.map((r) => r.url));
  }
  assert.deepEqual(urls, all.map((_, i) => `http://a.example/${i}`), "every line once, in file order");
  // The tail command asks for the bytes after the last whole line.
  assert.match(m.commands[0].command, /^sh -c 'tail -c \+1 \/var\/log\/touchstone\/egress\.jsonl 2>\/dev\/null \| head -c 262144 \| base64'$/);
  assert.doesNotMatch(m.commands[1].command, /tail -c \+1 /);
});

test("pullEgressLog skips one line that is longer than a pull, and reads the line after it", async () => {
  const m = localMachine("m-long");
  writeFileSync(m.log, "x".repeat(300_000) + "\n" + line({ host: "after.example" }) + "\n");
  assert.deepEqual(await pullEgressLog(m), []);
  assert.deepEqual(await pullEgressLog(m), [rec({ host: "after.example" })]);
  assert.deepEqual(await pullEgressLog(m), []);
});

test("pullEgressLog leaves a line without its line end for the next pull", async () => {
  const m = localMachine("m-half");
  const second = line({ host: "second.example" });
  writeFileSync(m.log, line() + "\n" + second.slice(0, 40));
  assert.deepEqual(await pullEgressLog(m), [rec()]);
  assert.deepEqual(await pullEgressLog(m), []);
  appendFileSync(m.log, second.slice(40) + "\n");
  assert.deepEqual(await pullEgressLog(m), [rec({ host: "second.example" })]);
});

test("pullEgressLog: no file gives no record; two pulls at the same time return no line twice", async () => {
  const m = localMachine("m-twice");
  assert.deepEqual(await pullEgressLog(m), []);
  writeFileSync(m.log, [line({ status: 1 }), line({ status: 2 }), line({ status: 3 })].join("\n") + "\n");
  const [a, b] = await Promise.all([pullEgressLog(m), pullEgressLog(m)]);
  assert.deepEqual([...a, ...b].map((r) => r.status), [1, 2, 3]);
});

test("pullEgressLog: one machine does not move the offset of another", async () => {
  const a = localMachine("m-a");
  const b = localMachine("m-b");
  writeFileSync(a.log, line({ host: "a.example" }) + "\n");
  writeFileSync(b.log, line({ host: "b.example" }) + "\n");
  assert.deepEqual(await pullEgressLog(a), [rec({ host: "a.example" })]);
  assert.deepEqual(await pullEgressLog(b), [rec({ host: "b.example" })]);
});

test("pullEgressLog uses at most 256 KB of an answer, even when the machine sends more", async () => {
  const one = line() + "\n";
  const m = { id: "m-liar", exec: async () => ({ exitCode: 0, result: Buffer.from(one.repeat(40_000)).toString("base64") }) };
  const got = await pullEgressLog(m);
  assert.ok(got.length > 0 && got.length <= 262144 / one.length, `${got.length} records`);
  // An answer that is not base64 text, or not text at all, gives no record and no error.
  assert.deepEqual(await pullEgressLog({ id: "m-junk", exec: async () => ({ exitCode: 0, result: "\u0000<<<not base64>>>" }) }), []);
  assert.deepEqual(await pullEgressLog({ id: "m-null", exec: async () => ({ exitCode: 1, result: null }) }), []);
});

test("the egress-log event holds the count so far and at most 20 host names", async () => {
  const m = localMachine("m-hosts");
  const count = events().length;
  writeFileSync(m.log, Array.from({ length: 30 }, (_, i) => line({ host: `h${i}.example` })).join("\n") + "\n");
  assert.equal((await pullEgressLog(m)).length, 30);
  appendFileSync(m.log, line({ host: "h0.example" }) + "\n");
  assert.equal((await pullEgressLog(m)).length, 1);
  const mine = events().slice(count);
  assert.deepEqual(mine.map((e) => e.requests), [30, 31]);
  assert.deepEqual(mine[1].hosts, Array.from({ length: 20 }, (_, i) => `h${i}.example`));
  assert.deepEqual(Object.keys(mine[1]), ["t", "ev", "requests", "hosts"]);
});
