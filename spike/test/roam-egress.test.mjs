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
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Wait until `ok()` is true; fail after 5 s.
async function until(ok, what) {
  for (let i = 0; i < 250; i++) { if (await ok()) return; await sleep(20); }
  assert.fail(`timed out: ${what}`);
}
const answers = (port) => new Promise((resolve) => {
  const s = net.connect(port, "127.0.0.1", () => { s.destroy(); resolve(true); }).on("error", () => resolve(false));
});

function localMachine(id, port = 1, env = process.env) {
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
      const child = spawn("sh", ["-c", local(command)], { detached: true, stdio: ["ignore", "pipe", "pipe"], env });
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
// `wait` keeps the open tunnel silent for that many ms first.
function tunnel(port, target, wait = 0) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "CONNECT", path: target, agent: false });
    let ownedSocket, sendTimer;
    const finish = (error, result) => {
      clearTimeout(deadline);
      clearTimeout(sendTimer);
      req.destroy();
      ownedSocket?.destroy();
      if (error) reject(error); else resolve(result);
    };
    // Bound the wait even when the production connect timer is missing.
    const deadline = setTimeout(() => finish(new Error("CONNECT helper deadline exceeded")), 5000);
    req.on("error", (error) => finish(error));
    req.on("connect", (res, socket) => {
      ownedSocket = socket;
      if (res.statusCode !== 200) { finish(null, { status: res.statusCode, body: "" }); return; }
      let text = "";
      socket.on("data", (d) => { text += d; });
      socket.on("end", () => finish(null, { status: res.statusCode, body: text }));
      socket.on("error", (error) => finish(error));
      sendTimer = setTimeout(() => socket.write("GET /in-tunnel HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"), wait);
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
    assert.match(m.commands[0].command, /^sh -c '\(nohup node \/tmp\/touchstone-egress-log\.mjs 8899 \/var\/log\/touchstone\/egress\.jsonl >\/dev\/null 2>&1 &\); command -v base64 >\/dev\/null \|\| exit 1; for /);
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

test("nonstandard upstream statuses survive the proxy, log file and pull", async () => {
  const target = http.createServer((req, res) => { res.writeHead(Number(req.url.slice(1))); res.end("odd"); });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  const port = await freePort();
  const m = localMachine("m-status", port);
  try {
    await startEgressLog(m);
    for (const status of [600, 999]) {
      assert.deepEqual(await viaProxy(port, "GET", `http://127.0.0.1:${target.address().port}/${status}`), { status, body: "odd" });
    }
    assert.deepEqual(readFileSync(m.log, "utf8").trim().split("\n").map((l) => JSON.parse(l).status), [600, 999]);
    assert.deepEqual((await pullEgressLog(m)).map((r) => r.status), [600, 999]);
  } finally {
    await new Promise((r) => target.close(r));
  }
});

test("invalid CONNECT timer arguments still answer a refused loopback connection", async () => {
  const dead = await freePort();
  for (const arg of ["-5", "Infinity", "0", "2147483648"]) {
    const port = await freePort();
    const log = join(dir, `invalid-timer-${arg}.jsonl`);
    const proxy = spawn(process.execPath, [fileURLToPath(new URL("../roam/egress-log.mjs", import.meta.url)), String(port), log, arg], { stdio: "ignore" });
    try {
      await until(() => answers(port), `the proxy listens with timer ${arg}`);
      assert.equal((await tunnel(port, `127.0.0.1:${dead}`)).status, 502, arg);
      assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l).status), [502], arg);
    } finally {
      const ended = new Promise((r) => proxy.once("close", r));
      proxy.kill();
      await ended;
    }
  }
});

test("startEgressLog twice on one machine: the first proxy keeps serving and the log file is not cut", async () => {
  const target = http.createServer((req, res) => res.end("ok"));
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${target.address().port}`;
  const port = await freePort();
  const m = localMachine("m-again", port);
  // The processes that run this machine's proxy script on this port.
  const copies = () => spawnSync("ps", ["-eo", "args"], { encoding: "utf8" }).stdout.split("\n")
    .filter((l) => l.includes(`${join(dir, "m-again", "egress-log.mjs")} ${port} `)).length;
  try {
    await startEgressLog(m);
    assert.equal((await viaProxy(port, "GET", `${base}/before`)).status, 200);
    const old = readFileSync(m.log, "utf8");
    assert.equal(old.trim().split("\n").length, 1);
    assert.equal(copies(), 1);

    await startEgressLog(m); // the port answers, so the call returns
    assert.deepEqual(m.uploads, ["/tmp/touchstone-egress-log.mjs", "/tmp/touchstone-egress-log.mjs"]);
    await until(() => copies() === 1, "the second copy ended");
    assert.equal((await viaProxy(port, "GET", `${base}/after`)).status, 200);

    const file = readFileSync(m.log, "utf8");
    assert.ok(file.startsWith(old), "the old line is still there, unchanged");
    assert.deepEqual(file.trim().split("\n").map((l) => JSON.parse(l).url), [`${base}/before`, `${base}/after`]);
    assert.deepEqual((await pullEgressLog(m)).map((r) => r.url), [`${base}/before`, `${base}/after`]);
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

test("startEgressLog throws when the machine has no base64: no log, no shell", async () => {
  // A PATH with the other tools of the start command, and no base64.
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const which = (tool) => process.env.PATH.split(":").map((d) => join(d, tool)).find((f) => existsSync(f));
  symlinkSync(process.execPath, join(bin, "node"));
  for (const tool of ["sh", "nohup", "seq", "sleep"]) symlinkSync(which(tool), join(bin, tool));
  const m = localMachine("m-no-base64", await freePort(), { ...process.env, PATH: bin });
  await assert.rejects(startEgressLog(m), /did not start on machine m-no-base64 \(exit 1\)[\s\S]*No log, no shell/);
  // The same PATH with base64 starts: base64 was the only thing that was missing.
  symlinkSync(which("base64"), join(bin, "base64"));
  await startEgressLog(m);
});

test("a plain request to a target that never answers is logged when the client leaves", async () => {
  const seen = [];
  const target = http.createServer((req) => { seen.push(`${req.method} ${req.url}`); req.resume(); }); // no answer
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${target.address().port}/hangs`;
  const port = await freePort();
  const m = localMachine("m-hung", port);
  try {
    await startEgressLog(m);
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: url, headers: { host: new URL(url).host }, agent: false });
    req.on("error", () => {});
    req.end("a payload that hangs the target");
    await until(() => seen.length === 1, "the target got the request");
    req.destroy(); // the client leaves
    await until(() => existsSync(m.log) && readFileSync(m.log, "utf8").includes("\n"), "a line in the log");
    await sleep(100);
    assert.deepEqual((await pullEgressLog(m)).map((r) => [r.method, r.url, r.status]), [["POST", url, 502]], "one line");
    assert.deepEqual(seen, ["POST /hangs"]);
  } finally {
    target.closeAllConnections();
    await new Promise((r) => target.close(r));
  }
});

test("a CONNECT to an address that does not answer is logged when the connect timer ends; an open tunnel has no timer", async (t) => {
  // A silent address on loopback: a child that listens with a short queue and
  // then blocks, so it never accepts. When the queue is full, the kernel drops
  // a new SYN.
  const silent = spawn(process.execPath, ["-e", `require("net").createServer().listen({ port: 0, host: "127.0.0.1", backlog: 1 }, function () {
    require("fs").writeSync(1, this.address().port + "\\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  })`], { stdio: ["ignore", "pipe", "ignore"] });
  const target = http.createServer((req, res) => res.end("short and stout"));
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  const port = await freePort();
  const log = join(dir, "m-timer.jsonl");
  // The real proxy, with a connect timer of 300 ms (the third argument).
  const proxy = spawn(process.execPath, [fileURLToPath(new URL("../roam/egress-log.mjs", import.meta.url)), String(port), log, "300"], { stdio: "ignore" });
  const fill = [];
  try {
    const sport = Number(await new Promise((resolve) => silent.stdout.once("data", (d) => resolve(String(d)))));
    for (let i = 0; i < 8; i++) fill.push(net.connect(sport, "127.0.0.1").on("error", () => {}));
    await sleep(300);
    if (fill.every((s) => !s.connecting)) { t.skip("this OS does not drop a SYN for a full queue"); return; }
    await until(() => answers(port), "the proxy listens");

    const start = Date.now();
    assert.equal((await tunnel(port, `127.0.0.1:${sport}`)).status, 502);
    const took = Date.now() - start;
    assert.ok(took >= 250 && took < 5000, `the timer ended the connect, not the OS (${took} ms)`);
    const lines = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((r) => [r.method, r.url, r.status]);
    assert.deepEqual(lines(), [["CONNECT", `127.0.0.1:${sport}`, 502]]);

    // The timer is for the connect only: a tunnel that is silent for longer still works.
    const tun = await tunnel(port, `127.0.0.1:${target.address().port}`, 700);
    assert.equal(tun.status, 200);
    assert.match(tun.body, /short and stout/);
    assert.deepEqual(lines().at(-1), ["CONNECT", `127.0.0.1:${target.address().port}`, null]);
  } finally {
    for (const s of fill) s.destroy();
    const ended = [proxy, silent].map((child) => new Promise((r) => child.once("close", r)));
    proxy.kill();
    silent.kill();
    await Promise.all(ended);
    await new Promise((r) => target.close(r));
  }
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
    line({ status: 99 }),
    line({ status: 600 }),
    line({ status: -1 }),
    line({ status: 1e21 }),
    line({ t: "now" }),
    line({ t: null }),
    line({ t: -5 }),
    line({ t: 8.64e15 + 1 }),
    line({ t: 1e300 }),
    // One record must stay one text line: no line end, space, control character or non-ASCII character.
    line({ url: "http://a.example/ 200\n> GET http://forged.example/ 200" }),
    line({ url: "http://a.example/\u2028" }),
    line({ url: "http://a.example/a b" }),
    line({ host: "a.example\r\n" }),
    line({ host: "a\u001b[2J.example" }),
    line({ host: "a\u0000.example" }),
    JSON.stringify({ host: "a.example", method: "GET", url: "http://a.example/", status: 200 }), // no t
    // The machine's own words are not kept: decision and reason are set by the host, extra fields go.
    line({ host: "b.example", decision: "block", reason: "the child wrote this", proven: true, extra: { deep: 1 } }),
    line({ host: longHost, url: longUrl, method: "CONNECT", status: null }),
    // The ends of the timestamp range are kept.
    line({ host: "low.example", t: 0, status: 100 }),
    line({ host: "high.example", t: 8.64e15, status: 599 }),
  ].join("\n") + "\n");
  assert.deepEqual(await pullEgressLog(m), [
    rec(),
    ...[99, 600, -1, 1e21].map((status) => rec({ status })), // integer or null, not a standard-status range
    rec({ host: "b.example" }),
    rec({ host: longHost, url: longUrl, method: "CONNECT", status: null }),
    rec({ host: "low.example", t: 0, status: 100 }),
    rec({ host: "high.example", t: 8.64e15, status: 599 }),
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
  writeFileSync(m.log, [line({ status: 201 }), line({ status: 202 }), line({ status: 203 })].join("\n") + "\n");
  const [a, b] = await Promise.all([pullEgressLog(m), pullEgressLog(m)]);
  assert.deepEqual([...a, ...b].map((r) => r.status), [201, 202, 203]);
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
