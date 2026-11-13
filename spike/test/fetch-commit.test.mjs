// A fetch records the commit it read, and a pinned fetch reads that commit again.
//
//   node --experimental-test-module-mocks --test spike/test/fetch-commit.test.mjs
//
// Real git, on local repos in a temp folder. No network: git rewrites
// https://github.com/ to that folder (GIT_CONFIG_* below), DNS is mocked, and
// globalThis.fetch is a stub for single files.
import "./helpers/isolated-env.mjs";
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as realDns from "node:dns/promises";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const lookup = async () => [{ address: "140.82.112.3", family: 4 }];
mock.module("node:dns/promises", { exports: { ...realDns, default: { ...realDns, lookup }, lookup } });

const dir = mkdtempSync(path.join(tmpdir(), "fetch-commit-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const REMOTE = path.join(dir, "remote");
Object.assign(process.env, {
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: `url.file://${REMOTE}/.insteadOf`,
  GIT_CONFIG_VALUE_0: "https://github.com/",
  GIT_CONFIG_KEY_1: "protocol.file.allow",
  GIT_CONFIG_VALUE_1: "always",
});

// One local repo that stands for https://github.com/<owner>/<repo>.
const git = (repo, ...args) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
function remote(name) {
  const repo = path.join(REMOTE, `${name}.git`);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  return repo;
}
function commit(repo, files) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), text);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "change");
  return git(repo, "rev-parse", "HEAD");
}
// Rewrite history so that `sha` is no longer in the repo: a force-push.
function forcePushAway(repo, files) {
  git(repo, "checkout", "-q", "--orphan", "fresh");
  const head = commit(repo, files);
  git(repo, "branch", "-q", "-M", "main");
  git(repo, "reflog", "expire", "--expire=now", "--all");
  git(repo, "gc", "-q", "--prune=now");
  return head;
}

const blobs = new Map(); // raw URL -> body
globalThis.fetch = async (url) => (blobs.has(String(url)) ? new Response(blobs.get(String(url)), { status: 200 }) : new Response("nope", { status: 404 }));

const { fetchSource, restoreSource } = await import("../lib/fetch.mjs");

// A workspace whose config lists these member links, and these pins.
function scopeWs(links, pins) {
  const ws = mkdtempSync(path.join(dir, "ws-"));
  mkdirSync(path.join(ws, "vendor"));
  writeFileSync(path.join(ws, ".touchstone.json"), JSON.stringify({ kind: "brief", links, ...(pins === undefined ? {} : { pins }) }));
  return ws;
}
// The `source-fetch` events of one call.
async function events(fn) {
  const file = path.join(dir, `events-${Math.random().toString(36).slice(2)}.jsonl`);
  process.env.EVENTS_FILE = file;
  let error = null;
  try {
    await fn();
  } catch (e) {
    error = e;
  } finally {
    delete process.env.EVENTS_FILE;
  }
  const evs = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.ev === "source-fetch") : [];
  return { evs, error };
}
const read = (ws, rel) => readFileSync(path.join(ws, rel), "utf8");

const URL_LIB = "https://github.com/acme/lib";
const lib = remote("acme/lib");
const first = commit(lib, { "src/Lib.sol": "contract Lib { uint v = 1; }\n" });

test("a fetch records the commit it read in its source-fetch event", async () => {
  const ws = scopeWs([URL_LIB]);
  const { evs, error } = await events(() => fetchSource(ws, URL_LIB));
  assert.equal(error, null);
  assert.deepEqual([evs.length, evs[0].ok, evs[0].where, evs[0].commit], [1, true, "vendor/acme__lib", first]);
  assert.match(read(ws, "vendor/acme__lib/src/Lib.sol"), /v = 1/);
  assert.ok(!existsSync(path.join(ws, "vendor/acme__lib/.git")), "the tree is kept, not its history");
});

test("a pinned member is fetched at its commit, not at the branch head of today", async () => {
  const second = commit(lib, { "src/Lib.sol": "contract Lib { uint v = 2; }\n", "src/New.sol": "contract New {}\n" });
  assert.notEqual(second, first);
  // No pin: the head of today.
  const fresh = scopeWs([URL_LIB]);
  let got = await events(() => fetchSource(fresh, URL_LIB));
  assert.equal(got.evs[0].commit, second);
  assert.match(read(fresh, "vendor/acme__lib/src/Lib.sol"), /v = 2/);
  // Pinned: the code this run read before, and the event says the same commit.
  const pinned = scopeWs([URL_LIB], { [URL_LIB]: { commit: first } });
  got = await events(() => fetchSource(pinned, URL_LIB));
  assert.equal(got.error, null);
  assert.equal(got.evs[0].commit, first);
  assert.match(read(pinned, "vendor/acme__lib/src/Lib.sol"), /v = 1/);
  assert.ok(!existsSync(path.join(pinned, "vendor/acme__lib/src/New.sol")), "a file of a later commit is not there");
  // The server's restore is the same fetch, with no event.
  const restored = scopeWs([URL_LIB], { [URL_LIB]: { commit: first } });
  got = await events(async () => assert.equal((await restoreSource(restored, URL_LIB)).commit, first));
  assert.deepEqual([got.error, got.evs.length], [null, 0]);
  assert.match(read(restored, "vendor/acme__lib/src/Lib.sol"), /v = 1/);
});

test("a folder member is fetched at its pinned commit too", async () => {
  const url = "https://github.com/acme/mono/tree/main/pkg/a";
  const mono = remote("acme/mono");
  const old = commit(mono, { "pkg/a/A.sol": "contract A { uint v = 1; }\n", "pkg/b/B.sol": "contract B {}\n" });
  commit(mono, { "pkg/a/A.sol": "contract A { uint v = 2; }\n" });
  const ws = scopeWs([url], { [url]: { commit: old } });
  const { evs, error } = await events(() => fetchSource(ws, url));
  assert.equal(error, null);
  assert.equal(evs[0].commit, old);
  assert.match(read(ws, "vendor/acme__mono@main/pkg/a/A.sol"), /v = 1/);
  assert.ok(!existsSync(path.join(ws, "vendor/acme__mono@main/pkg/b")), "only the member's folder");
});

test("a pinned commit that is gone is refused in plain words, and no other code takes its place", async () => {
  const url = "https://github.com/acme/moved";
  const repo = remote("acme/moved");
  const old = commit(repo, { "src/M.sol": "contract M { uint v = 1; }\n" });
  const ws = scopeWs([url], { [url]: { commit: old } });
  await fetchSource(ws, url); // the code is there
  forcePushAway(repo, { "src/M.sol": "contract M { uint v = 99; }\n" });
  let got = await events(() => fetchSource(ws, url));
  assert.match(got.error.message, new RegExp(`^could not fetch commit ${old.slice(0, 12)} of acme/moved, the commit this run read before: .+\\. The fetch is refused, so this run does not read other code in its place\\. If the commit is gone \\(a force-push, or a deleted repository\\), start a new run`));
  assert.deepEqual([got.evs.length, got.evs[0].ok, got.evs[0].url], [1, false, url]);
  assert.match(got.evs[0].error, /acme\/moved/);
  assert.match(read(ws, "vendor/acme__moved/src/M.sol"), /v = 1/, "the earlier copy stays; the new head is not read");
  // The same in an empty workspace: nothing lands.
  const empty = scopeWs([url], { [url]: { commit: old } });
  got = await events(() => fetchSource(empty, url));
  assert.ok(got.error);
  assert.ok(!existsSync(path.join(empty, "vendor/acme__moved")));
  // A deleted repository.
  rmSync(repo, { recursive: true, force: true });
  got = await events(() => fetchSource(empty, url));
  assert.match(got.error.message, /^could not fetch commit .* of acme\/moved, the commit this run read before/);
  assert.ok(!existsSync(path.join(empty, "vendor/acme__moved")));
});

test("a pin that cannot be read is not 'no pin': the fetch is refused and git gets nothing from it", async () => {
  const flag = path.join(dir, "ran-as-a-command");
  const bad = {
    "pins is not a record": "abc",
    "pins is a list": [first],
    "the pin is not a record": first,
    "the pin has no commit": {},
    "the commit is a number": { commit: 7 },
    "the commit is short": { commit: first.slice(0, 12) },
    "the commit is a git option": { commit: `--upload-pack=touch ${flag}` },
    "a file hash on a repo": { sha256: "a".repeat(64) },
    "the pin is null": null,
  };
  for (const [why, pin] of Object.entries(bad)) {
    const pins = why.startsWith("pins is") ? pin : { [URL_LIB]: pin };
    const ws = scopeWs([URL_LIB], pins);
    const { error, evs } = await events(() => fetchSource(ws, URL_LIB));
    assert.match(error?.message ?? "", /the record of what this run read before for this source cannot be read, so it is not fetched/, why);
    assert.equal(evs[0].ok, false, why);
    assert.ok(!existsSync(path.join(ws, "vendor/acme__lib")), `${why}: nothing was fetched`);
  }
  assert.ok(!existsSync(flag));
  // A pin for another member only: this member has none, and is fetched as today.
  const other = scopeWs([URL_LIB], { "https://github.com/acme/other": { commit: first } });
  assert.equal((await events(() => fetchSource(other, URL_LIB))).error, null);
});

test("a single file records its content hash, and a pinned file is taken only when it is the same", async () => {
  const url = "https://github.com/acme/lib/blob/main/src/One.sol";
  const raw = "https://raw.githubusercontent.com/acme/lib/main/src/One.sol";
  const body = "contract One { uint v = 1; }\n";
  const hash = createHash("sha256").update(body).digest("hex");
  blobs.set(raw, body);
  const ws = scopeWs([url]);
  let got = await events(() => fetchSource(ws, url));
  assert.deepEqual([got.error, got.evs[0].ok, got.evs[0].sha256, got.evs[0].commit], [null, true, hash, undefined]);
  // Pinned and the same: taken.
  const same = scopeWs([url], { [url]: { sha256: hash } });
  assert.equal((await events(() => fetchSource(same, url))).error, null);
  // Pinned and changed: refused, and the changed file is not written.
  blobs.set(raw, "contract One { uint v = 2; }\n");
  const changed = scopeWs([url], { [url]: { sha256: hash } });
  got = await events(() => fetchSource(changed, url));
  assert.match(got.error.message, /^refused src\/One\.sol of acme\/lib: the file changed since this run read it .* This run does not read other code in its place\./);
  assert.ok(!existsSync(path.join(changed, "vendor/files")));
  // A commit pin on a single file cannot be read as its pin.
  const wrong = scopeWs([url], { [url]: { commit: first } });
  assert.match((await events(() => fetchSource(wrong, url))).error.message, /cannot be read/);
});
