// Capture mode (lib/capture.mjs runCapture): the only path where a pack tool
// gets the network.
//
// The gate reads the run's own saved scope and its own grant from throwaway
// stores (no real store, no real console token). The seam tests call runCapture
// with a stand-in boundary and docker, and record the exact docker argv, so no
// network is built. The last tests build the real boundary and run a real
// container in capture mode (no GitHub request); they skip when an image is
// missing.
//
//   node --experimental-test-module-mocks --test spike/test/capture-mode.test.mjs
import "./helpers/isolated-env.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const storeDir = mkdtempSync(join(tmpdir(), "capture-gate-test-"));
process.env.TOUCHSTONE_SCOPES_FILE = join(storeDir, "scopes.json");
process.env.TOUCHSTONE_GRANTS_FILE = join(storeDir, "grants.json");
process.env.TOUCHSTONE_GRANT_TOKEN = "test-token-not-real";
after(() => rmSync(storeDir, { recursive: true, force: true }));

const { runTool } = await import("../lib/wrap.mjs");
const { captureArgs, captureGrant, CAPTURE_TARGETS, egressSummary, scrub, runNamed, runCapture, holdsSecret, cleanOutput, cleanError, LEAK_REASON, GITHUB_CAPTURE_HOSTS, SECRET_MIN } = await import("../lib/capture.mjs");
const { addLiveScope, readScopes } = await import("../lib/scopes-store.mjs");
const { addGrant, getGrant, removeGrant, readGrants } = await import("../lib/grant-store.mjs");

const FAKE_TOKEN = "ghp_FAKEtokenFAKEtokenFAKEtokenFAKE1234";
const targets = [{ owner: "hemaaanth", repo: "touchstone" }];
// A saved live supply-chain scope, as the console's permission tick makes it.
const supplyScope = (repos = ["hemaaanth/touchstone"]) => addLiveScope({ hosts: repos, pack: "supply-chain", permission: true });
const scopeId = supplyScope().id;
// Hand-edit a stored record (what a damaged or hand-made store looks like).
const editScope = (id, fn) => writeFileSync(process.env.TOUCHSTONE_SCOPES_FILE, JSON.stringify(readScopes().map((s) => (s.id === id ? fn(structuredClone(s)) : s))));
const editGrant = (id, fn) => writeFileSync(process.env.TOUCHSTONE_GRANTS_FILE, JSON.stringify(readGrants().map((g) => (g.id === id ? fn(structuredClone(g)) : g))));

// A stand-in boundary and docker. It records each docker argv and the env the
// docker CLI got, and returns what the "tool" printed.
function seams({ print = "", printErr = "", code = 0, timedOut = false } = {}) {
  const calls = [], built = [];
  return {
    calls, built,
    confine: async (opts) => { built.push(opts); return { netClient: "touchstone-reach-client-test", proxyName: "touchstone-reach-proxy-test", gateUrl: "http://scope-gate:8080", stop: async () => { built.push("stopped"); } }; },
    exec: async (args, { env }) => {
      calls.push({ args, env });
      if (args[0] === "logs") return { code: 0, stdout: "", stderr: '__TOUCHSTONE_SCOPE__ {"host":"api.github.com","decision":"allow"}\n__TOUCHSTONE_SCOPE__ {"host":"api.osv.dev","decision":"block"}\n' };
      if (args[0] === "rm") return { code: 0, stdout: "", stderr: "" };
      return { code, stdout: print.replace("$TOKEN", env.GITHUB_TOKEN ?? ""), stderr: printErr.replace("$TOKEN", env.GITHUB_TOKEN ?? ""), timedOut };
    },
  };
}

const cap = (over = {}) => ({ image: "x:1", cmd: [], user: "1:1", scopeId, targets, hosts: ["api.github.com"], ...over });
// Run one capture with stand-in seams and assert it was refused before any boundary or docker call.
async function refused(over, why) {
  const s = seams();
  const r = await runCapture({ ...cap(over), confine: s.confine, exec: s.exec });
  assert.equal(r.code, -1, why);
  assert.match(r.refused ?? "", why);
  assert.equal(s.built.length, 0, "no boundary built");
  assert.equal(s.calls.length, 0, "no docker call");
  return r;
}

test("capture argv: network on only through the grant's boundary, --pull=never always, token by name only", async () => {
  const s = seams({ print: "{}" });
  const r = await runCapture({ ...cap({ image: "touchstone/scorecard:5.6.0", cmd: ["--repo=github.com/hemaaanth/touchstone", "--format=json"], user: "1000:1000", secrets: { GITHUB_TOKEN: FAKE_TOKEN } }), confine: s.confine, exec: s.exec });
  assert.equal(r.code, 0);
  assert.equal(r.refused, undefined);
  const { args, env } = s.calls[0];
  assert.equal(args[0], "run");
  assert.ok(args.includes("--pull=never"));
  assert.equal(args[args.indexOf("--network") + 1], "touchstone-reach-client-test");
  assert.equal(args.filter((a) => a === "--network").length, 1);
  assert.ok(!args.includes("none") && !args.includes("host") && !args.includes("bridge"));
  for (const flag of ["--cap-drop", "--security-opt", "--pids-limit", "--memory", "--user"]) assert.ok(args.includes(flag), flag);
  assert.ok(args.includes("HTTPS_PROXY=http://scope-gate:8080"));
  // The token is an env NAME in argv. Its value is only in the docker CLI env.
  assert.equal(args[args.indexOf("GITHUB_TOKEN") - 1], "-e");
  assert.ok(!args.join(" ").includes(FAKE_TOKEN), "token value is never in argv");
  assert.equal(env.GITHUB_TOKEN, FAKE_TOKEN);
  assert.deepEqual(s.built[0], { allowedHosts: ["api.github.com"] });
  assert.equal(s.built.at(-1), "stopped", "the boundary is torn down");
  assert.deepEqual(r.egress, { tunnels: { "api.github.com": 1 }, blocked: { "api.osv.dev": 1 } });
});

// wrap.mjs is main's file: runTool has no capture option. A `capture` key is
// ignored and the run keeps `--network none`. Every docker call goes to a PATH
// shim that logs it and does nothing.
test("runTool has no capture path: a capture key is ignored and the run stays --network none", async () => {
  const dir = mkdtempSync(join(tmpdir(), "touchstone-cap-shim-"));
  const log = join(dir, "argv.jsonl");
  writeFileSync(join(dir, "docker"), `#!/usr/bin/env node\nrequire("fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
  chmodSync(join(dir, "docker"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try {
    await runTool({ image: "x:1", cmd: [], user: "1:1", ws: dir, capture: { scopeId, targets, hosts: ["api.github.com"], secrets: { GITHUB_TOKEN: FAKE_TOKEN } } });
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
    const run = calls.find((a) => a[0] === "run");
    assert.equal(run[run.indexOf("--network") + 1], "none");
    assert.ok(!calls.some((a) => a[0] === "network"), "no boundary was built");
    assert.ok(!JSON.stringify(calls).includes(FAKE_TOKEN));
  } finally { process.env.PATH = path; rmSync(dir, { recursive: true, force: true }); }
});

test("capture argv has no token flag when the tool needs no secret", async () => {
  const s = seams({ print: "{}" });
  await runCapture({ ...cap(), confine: s.confine, exec: s.exec });
  assert.ok(!s.calls[0].args.includes("GITHUB_TOKEN"));
});

// ---- The gate. Each refusal below passes every other check, so each test
// fails when its own check is removed. ----

test("gate: no scope id, or an id that is not a saved scope, is refused", async () => {
  await refused({ scopeId: undefined }, /needs the run's own saved scope/);
  await refused({ scopeId: "live-nope-00000000" }, /is not a saved scope/);
});

test("gate: a scope that is not a live supply-chain scope is refused, even when its grant covers api.github.com", async () => {
  const web = addLiveScope({ hosts: ["api.github.com"], pack: "web", permission: true });
  editScope(web.id, (s) => ({ ...s, github: ["hemaaanth/touchstone"] }));
  await refused({ scopeId: web.id }, /not a live supply-chain scope/);
});

test("gate (1h binding): with its own grant removed, another grant that covers the host does not count", async () => {
  const sc = supplyScope();
  addGrant({ hosts: ["api.github.com", "raw.githubusercontent.com"], kind: "operator-owned", ownership: true });
  removeGrant(sc.permission.grantId);
  await refused({ scopeId: sc.id }, /no active grant of its own/);
});

test("gate: an expired own grant, or a scope with no saved permission, is refused", async () => {
  const sc = supplyScope();
  editGrant(sc.permission.grantId, (g) => ({ ...g, expiresAt: Date.now() - 1000 }));
  await refused({ scopeId: sc.id }, /no active grant of its own/);
  const bare = supplyScope();
  editScope(bare.id, (s) => { delete s.permission; return s; });
  await refused({ scopeId: bare.id }, /no active grant of its own/);
});

test("gate: a scope that points at another scope's grant is refused", async () => {
  const a = supplyScope(), b = supplyScope();
  editScope(a.id, (s) => ({ ...s, permission: { ...s.permission, grantId: b.permission.grantId } }));
  await refused({ scopeId: a.id }, /belongs to another scope/);
});

test("gate (1h binding): a scope whose hosts its own grant does not cover is refused", async () => {
  const sc = supplyScope();
  editScope(sc.id, (s) => ({ ...s, hosts: [...s.hosts, "evil.example.com"] }));
  await refused({ scopeId: sc.id }, /own grant does not cover evil\.example\.com/);
});

test("gate: the repo must be one the scope lists; an owner-wide scope does not cover a repo", async () => {
  await refused({ scopeId: supplyScope(["hemaaanth/other"]).id }, /hemaaanth\/touchstone is not a repo of this scope/);
  await refused({ scopeId: supplyScope(["hemaaanth"]).id }, /is not a repo of this scope/);
});

test("gate: only hemaaanth/touchstone, whatever the scope lists: another owner, a fork, an owner-wide target", async () => {
  assert.deepEqual(CAPTURE_TARGETS, ["hemaaanth/touchstone"]);
  for (const [repos, t] of [[["torvalds/linux"], { owner: "torvalds", repo: "linux" }], [["someone/touchstone"], { owner: "someone", repo: "touchstone" }],
    [["hemaaanth/touchstone-fork"], { owner: "hemaaanth", repo: "touchstone-fork" }]]) {
    await refused({ scopeId: supplyScope(repos).id, targets: [t] }, /not a capture target/);
  }
  await refused({ scopeId: supplyScope(["hemaaanth"]).id, targets: [{ owner: "hemaaanth", repo: null }] }, /a whole owner is never captured/);
});

test("gate: case is folded; a target that is not plain strings is refused; tricks never match", async () => {
  const s = seams({ print: "{}" });
  const ok = await runCapture({ ...cap({ targets: [{ owner: "HEMAAANTH", repo: "TouchStone" }] }), confine: s.confine, exec: s.exec });
  assert.equal(ok.refused, undefined);
  // An object owner that prints as "hemaaanth" passes every string compare.
  let n = 0;
  const shifty = { toString: () => (n++ < 8 ? "hemaaanth" : "evil") };
  await refused({ targets: [{ owner: shifty, repo: "touchstone" }] }, /must be owner\/repo strings/);
  await refused({ targets: [{ owner: ["hemaaanth"], repo: "touchstone" }] }, /must be owner\/repo strings/);
  // URL and path tricks are not the listed repo, so they never match.
  for (const t of [{ owner: "hemaaanth", repo: "touchstone/../other" }, { owner: "hemaaanth/touchstone", repo: "x" }, { owner: "github.com@evil.com/hemaaanth", repo: "touchstone" },
    { owner: "hemaaanth", repo: "touchstone.git" }, { owner: "hemaaanth", repo: "touchstone%2F..%2Fother" }, { owner: "hemaaanth", repo: "touchstone " }, { owner: "hemaaanth", repo: "t\u043euchstone" }]) {
    await refused({ targets: [t] }, /not a repo of this scope/);
  }
});

test("gate: no target, or more than allowed, is refused", async () => {
  await refused({ targets: [] }, /at least one target/);
  await refused({ targets: [...targets, { owner: "torvalds", repo: "linux" }] }, /torvalds\/linux is not a repo of this scope/);
});

test("gate: hosts must be capture hosts that the scope's own grant covers", async () => {
  assert.deepEqual(GITHUB_CAPTURE_HOSTS, ["api.github.com"]);
  await refused({ hosts: [] }, /egress allow-list/);
  await refused({ hosts: ["api.github.com", "codeload.github.com"] }, /codeload\.github\.com is not a capture host/);
  await refused({ hosts: ["raw.githubusercontent.com"] }, /is not a capture host/);
  const sc = supplyScope();
  editGrant(sc.permission.grantId, (g) => ({ ...g, hosts: ["raw.githubusercontent.com"] }));
  editScope(sc.id, (s) => ({ ...s, hosts: ["raw.githubusercontent.com"] }));
  await refused({ scopeId: sc.id }, /own grant does not cover api\.github\.com/);
});

test("gate: a secret that is missing or shorter than SECRET_MIN is refused", async () => {
  assert.equal(SECRET_MIN, 24);
  for (const v of ["", undefined, "x".repeat(SECRET_MIN - 1)]) await refused({ secrets: { GITHUB_TOKEN: v } }, /secret GITHUB_TOKEN is missing/);
  const s = seams({ print: "{}" });
  assert.equal((await runCapture({ ...cap({ secrets: { GITHUB_TOKEN: "x".repeat(SECRET_MIN) } }), confine: s.confine, exec: s.exec })).refused, undefined);
});

// A damaged store still refuses, and the reason says the store cannot be read
// (not "not a saved scope" or "no grant of its own"). A missing file is an
// empty store, so that case still says the scope is not saved.
test("gate: a damaged scope store or grant store refuses with a reason that says so", async () => {
  for (const [file, what] of [[process.env.TOUCHSTONE_SCOPES_FILE, "scope"], [process.env.TOUCHSTONE_GRANTS_FILE, "grant"]]) {
    const saved = readFileSync(file, "utf8");
    try {
      for (const junk of ["{not json", "{}", "null", ""]) {
        writeFileSync(file, junk);
        await refused({}, new RegExp(`the ${what} store cannot be read`));
      }
    } finally { writeFileSync(file, saved); }
  }
  const s = seams({ print: "{}" });
  assert.equal((await runCapture({ ...cap(), confine: s.confine, exec: s.exec })).refused, undefined, "the restored stores work again");
});

test("captureGrant returns the scope and its own grant", () => {
  const { scope, grant } = captureGrant(scopeId, targets, ["api.github.com"]);
  assert.equal(scope.id, scopeId);
  assert.equal(grant.id, scope.permission.grantId);
  assert.equal(getGrant(grant.id).scopeId, scopeId);
});

test("the token value never appears in what a capture returns, even when the tool prints it", async () => {
  const s = seams({ print: 'token is $TOKEN {"ok":1}', printErr: "auth $TOKEN failed" });
  const r = await runCapture({ ...cap({ secrets: { GITHUB_TOKEN: FAKE_TOKEN } }), confine: s.confine, exec: s.exec });
  assert.ok(!JSON.stringify(r).includes(FAKE_TOKEN));
  assert.match(r.stdout, /\[REDACTED\]/);
  assert.match(r.stderr, /\[REDACTED\]/);
});

test("a refusal or a boundary error never carries the token in its text", async () => {
  const s = seams();
  const r = await runCapture({ ...cap({ secrets: { GITHUB_TOKEN: FAKE_TOKEN } }), confine: async () => { throw new Error(`proxy failed with ${Buffer.from(FAKE_TOKEN).toString("base64")}`); }, exec: s.exec });
  assert.match(r.refused, /could not build the egress boundary/);
  assert.ok(!holdsSecret(JSON.stringify(r), [FAKE_TOKEN]));
  assert.equal(cleanError(`bad ${FAKE_TOKEN.slice(3, 20)}`, [FAKE_TOKEN]), `error text dropped: ${LEAK_REASON}`);
});

test("every capture removes its container by name, even one that ended on its own", async () => {
  const s = seams({ code: 1, timedOut: true });
  const r = await runCapture({ ...cap(), confine: s.confine, exec: s.exec });
  assert.equal(r.timedOut, true);
  const name = s.calls[0].args[s.calls[0].args.indexOf("--name") + 1];
  assert.deepEqual(s.calls.find((c) => c.args[0] === "rm").args, ["rm", "-f", name]);
});

// A docker CLI that never returns until its container is removed: the real
// shape when PID 1 ignores SIGTERM. Our own timer must remove it.
test("runNamed: at timeoutMs the container is removed by name and the call reports timedOut", async () => {
  let release;
  const calls = [];
  const exec = async (args) => {
    calls.push(args);
    if (args[0] === "rm") { release?.(); return { code: 0, stdout: "", stderr: "" }; }
    return new Promise((r) => { release = () => r({ code: 137, stdout: "", stderr: "", timedOut: false }); });
  };
  const t0 = Date.now();
  const r = await runNamed(["run", "--name", "n1", "x:1"], "n1", { timeoutMs: 200, exec });
  assert.ok(Date.now() - t0 < 2_000);
  assert.equal(r.timedOut, true);
  assert.deepEqual(calls.filter((a) => a[0] === "rm")[0], ["rm", "-f", "n1"]);
});

// On a busy host the container can appear after the first rm. The rm repeats
// until the docker CLI returns.
test("runNamed: a container created after the first rm is still removed", async () => {
  let rms = 0, release;
  const exec = async (args) => {
    if (args[0] === "rm") { rms++; if (rms >= 3) release?.(); return { code: 1, stdout: "", stderr: "No such container" }; }
    return new Promise((r) => { release = () => r({ code: 137, stdout: "", stderr: "" }); });
  };
  const r = await runNamed(["run", "--name", "n2", "x:1"], "n2", { timeoutMs: 100, exec });
  assert.equal(r.timedOut, true);
  assert.ok(rms >= 3);
});

test("captureArgs refuses an open network and a secret passed as a plain env value", () => {
  const base = { name: "n", image: "i", cmd: [], network: "touchstone-reach-client-x", gate: "http://scope-gate:8080", user: "1:1" };
  for (const network of ["none", "host", "bridge", "default", "container:abc", ""]) assert.throws(() => captureArgs({ ...base, network }));
  assert.throws(() => captureArgs({ ...base, env: { GITHUB_TOKEN: "x" }, secretNames: ["GITHUB_TOKEN"] }), /secret/);
  assert.throws(() => captureArgs({ ...base, env: { "A=B": "x" } }));
  assert.ok(captureArgs(base).includes("--pull=never"));
});

test("egress parse and scrub", () => {
  assert.deepEqual(egressSummary("junk\n__TOUCHSTONE_SCOPE__ {bad\n"), { tunnels: {}, blocked: {} });
  assert.equal(scrub("a SECRETVALUE b SECRETVALUE", ["SECRETVALUE"]), "a [REDACTED] b [REDACTED]");
});

// A scrub only replaces the whole value. Encoded or split copies must still be
// caught, and then the whole output is dropped.
test("leak check: base64, base64url, split and URL-encoded copies of the token are caught", () => {
  const b64 = (s) => Buffer.from(s).toString("base64");
  const half = FAKE_TOKEN.length >> 1;
  const leaks = [
    b64(FAKE_TOKEN),
    Buffer.from(FAKE_TOKEN).toString("base64url"),
    b64(`x-access-token:${FAKE_TOKEN}`), b64(`a:${FAKE_TOKEN}`), b64(`ab:${FAKE_TOKEN}`),
    `${FAKE_TOKEN.slice(0, half)}\n${FAKE_TOKEN.slice(half)}`,
    FAKE_TOKEN.slice(5, 17),
  ];
  for (const l of leaks) assert.equal(holdsSecret(`out ${l} end`, [FAKE_TOKEN]), true, l);
  const odd = "tok/en+with=chars&more/and/more";
  assert.equal(holdsSecret(`?t=${encodeURIComponent(odd)}`, [odd]), true);
  assert.equal(holdsSecret(`?t=${encodeURIComponent(FAKE_TOKEN + "/")}`, [FAKE_TOKEN]), true);
  assert.equal(holdsSecret('{"ok":true,"score":7} [REDACTED]', [FAKE_TOKEN]), false);
  assert.equal(holdsSecret(FAKE_TOKEN.slice(0, 11), [FAKE_TOKEN]), false, "an 11-character piece is too short to be sure");
  const c = cleanOutput({ stdout: `fine\n${b64(FAKE_TOKEN)}`, stderr: "x" }, [FAKE_TOKEN]);
  assert.deepEqual(c, { stdout: "", stderr: "", leaked: LEAK_REASON });
  assert.deepEqual(cleanOutput({ stdout: `a ${FAKE_TOKEN}`, stderr: "" }, [FAKE_TOKEN]), { stdout: "a [REDACTED]", stderr: "" });
});

test("leak check: hex copies (lower and upper case), whole or in part, are caught", () => {
  const hex = Buffer.from(FAKE_TOKEN).toString("hex");
  for (const h of [hex, hex.toUpperCase(), hex.slice(6, 6 + 2 * 12), hex.toUpperCase().slice(10, 10 + 2 * 12)]) {
    assert.equal(holdsSecret(`dump: ${h} end`, [FAKE_TOKEN]), true, h);
  }
  assert.equal(cleanOutput({ stdout: `0x${hex}`, stderr: "" }, [FAKE_TOKEN]).leaked, LEAK_REASON);
  // 11 bytes of hex (22 characters) is too short to be sure, the same rule as a plain piece.
  assert.equal(holdsSecret(hex.slice(0, 22), [FAKE_TOKEN]), false);
});

// The two chunks are the two streams the tool writes. At every split point one
// side holds SECRET_MIN / 2 = 12 or more characters, so the drop always fires.
test("a token split across stdout and stderr is caught at every split point", () => {
  for (const tok of [FAKE_TOKEN, "s".repeat(SECRET_MIN - 1).replace(/s/g, (_, i) => "abcdefghijklmnopqrstuvwxyz"[i % 26]) + "Z"]) {
    for (let k = 1; k < tok.length; k++) {
      const c = cleanOutput({ stdout: `head ${tok.slice(0, k)}`, stderr: `${tok.slice(k)} tail` }, [tok]);
      assert.equal(c.leaked, LEAK_REASON, `split at ${k} of ${tok.length}`);
    }
    // Not split: the whole value in one stream is replaced, not dropped.
    assert.deepEqual(cleanOutput({ stdout: "head ", stderr: `${tok} tail` }, [tok]), { stdout: "head ", stderr: "[REDACTED] tail" });
  }
});

test("runCapture drops all output when a part of the token is left after the scrub", async () => {
  const half = FAKE_TOKEN.length >> 1;
  // A secret with characters that URL encoding changes. (A GitHub token is
  // [A-Za-z0-9_] only: its URL-encoded form is itself, and the scrub replaces it.)
  const ODD = "tok/en+with=chars&more/and/more";
  const forms = [
    [FAKE_TOKEN, (t) => ({ stdout: Buffer.from(t).toString("base64"), stderr: "" })],
    [FAKE_TOKEN, (t) => ({ stdout: Buffer.from(`x-access-token:${t}`).toString("base64url"), stderr: "" })],
    [FAKE_TOKEN, (t) => ({ stdout: Buffer.from(t).toString("hex"), stderr: "" })],
    [FAKE_TOKEN, (t) => ({ stdout: "", stderr: Buffer.from(t).toString("hex").toUpperCase() })],
    [ODD, (t) => ({ stdout: `GET /?t=${encodeURIComponent(t)}`, stderr: "" })],
    [FAKE_TOKEN, (t) => ({ stdout: `ok ${t.slice(0, half)}\n${t.slice(half)}`, stderr: "" })],
    [FAKE_TOKEN, (t) => ({ stdout: `{"a":"${t.slice(0, 9)}`, stderr: `${t.slice(9)}"}` })],
  ];
  for (const [secret, form] of forms) {
    const s = seams();
    const exec = async (args, o) => (args[0] === "run" ? { code: 0, ...form(o.env.GITHUB_TOKEN), timedOut: false } : s.exec(args, o));
    const r = await runCapture({ ...cap({ secrets: { GITHUB_TOKEN: secret } }), confine: s.confine, exec });
    assert.equal(r.leaked, LEAK_REASON, String(form));
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
    assert.ok(!holdsSecret(JSON.stringify(r), [secret]));
  }
  // The plain URL-encoded GitHub token is the token itself: replaced, nothing left.
  const s = seams();
  const exec = async (args, o) => (args[0] === "run" ? { code: 0, stdout: `GET /?t=${encodeURIComponent(o.env.GITHUB_TOKEN)}`, stderr: "", timedOut: false } : s.exec(args, o));
  const r = await runCapture({ ...cap({ secrets: { GITHUB_TOKEN: FAKE_TOKEN } }), confine: s.confine, exec });
  assert.equal(r.stdout, "GET /?t=[REDACTED]");
});

const hasDocker = (() => {
  try { for (const i of ["alpine:3.20", "node:20-slim"]) execFileSync("docker", ["image", "inspect", i], { stdio: "ignore" }); return true; } catch { return false; }
})();
const SKIP_REAL = !hasDocker && "image alpine:3.20 or node:20-slim is missing on this host (never pulled by a test)";

// Real boundary, real container, no GitHub request. The container gets the
// token by env name, prints it (scrubbed), and finds no raw route off its
// network. The raw-socket probe aims at 192.0.2.1 (TEST-NET-1, RFC 5737): no
// real host, even if a route existed.
test("real capture container: token arrives by env name, output is scrubbed, a raw socket has no route", { skip: SKIP_REAL, timeout: 90_000 }, async () => {
  const script = 'echo "len=${#GITHUB_TOKEN}"; echo "$GITHUB_TOKEN"; if nc -w 3 192.0.2.1 443 </dev/null; then echo raw-open; else echo raw-blocked; fi';
  const r = await runCapture({ image: "alpine:3.20", cmd: ["sh", "-c", script], timeoutMs: 60_000, scopeId, targets, hosts: ["api.github.com"], secrets: { GITHUB_TOKEN: FAKE_TOKEN } });
  assert.equal(r.refused, undefined, r.refused);
  assert.match(r.stdout, new RegExp(`len=${FAKE_TOKEN.length}`));
  assert.match(r.stdout, /\[REDACTED\]/);
  assert.match(r.stdout, /raw-blocked/);
  assert.ok(!JSON.stringify(r).includes(FAKE_TOKEN));
});

// The real fault: `docker run` of a PID 1 that ignores SIGTERM. A plain
// execFile timeout leaves the CLI and the container running for a minute.
// Capture mode must return near timeoutMs and leave no container.
test("real capture timeout: returns near timeoutMs and leaves no container", { skip: SKIP_REAL, timeout: 90_000 }, async () => {
  const before = execFileSync("docker", ["ps", "-aq", "--filter", "name=touchstone-capture-"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const t0 = Date.now();
  const r = await runCapture({ image: "alpine:3.20", cmd: ["sleep", "60"], timeoutMs: 3_000, scopeId, targets, hosts: ["api.github.com"] });
  const took = Date.now() - t0;
  assert.equal(r.refused, undefined, r.refused);
  assert.equal(r.timedOut, true);
  assert.ok(took < 20_000, `took ${took} ms`);
  const after = execFileSync("docker", ["ps", "-aq", "--filter", "name=touchstone-capture-"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  assert.deepEqual(after.filter((id) => !before.includes(id)), []);
});
