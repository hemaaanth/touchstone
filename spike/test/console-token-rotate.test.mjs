// Rotating the console token (L11), at the grant-store level. Every case uses a
// throwaway token file through TOUCHSTONE_GRANT_TOKEN_FILE, never spike/data.
// No token value is printed: a failed assertion names only lengths and states.
//
//   node --test spike/test/console-token-rotate.test.mjs
import "./helpers/isolated-env.mjs";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { consoleToken, consoleTokenFile, rotateConsoleToken } from "../lib/grant-store.mjs";

const STORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../lib/grant-store.mjs");
let dir, file;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "console-token-rotate-"));
  file = path.join(dir, "console-token");
  // The helper pins a token; a rotate needs the file-backed one.
  delete process.env.TOUCHSTONE_GRANT_TOKEN;
  process.env.TOUCHSTONE_GRANT_TOKEN_FILE = file;
});
afterEach(() => {
  try { chmodSync(dir, 0o700); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

// The token a fresh process reads from the file: the path a grant CLI takes.
function tokenInNewProcess() {
  const env = { ...process.env, TOUCHSTONE_GRANT_TOKEN_FILE: file };
  delete env.TOUCHSTONE_GRANT_TOKEN;
  return execFileSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(STORE)}); process.stdout.write(m.consoleToken())`], { env, encoding: "utf8" });
}
const same = (a, b) => a === b; // compared here, never printed

test("the token comes from the file named by TOUCHSTONE_GRANT_TOKEN_FILE", () => {
  assert.equal(consoleTokenFile(), file);
  const t = consoleToken();
  assert.match(t, /^[0-9a-f-]{36}$/);
  assert.ok(same(readFileSync(file, "utf8").trim(), t));
});

test("a rotate replaces the token at once: the old one is no longer current, the file holds the new one, mode 0600", () => {
  const old = consoleToken();
  const next = rotateConsoleToken(old);
  assert.equal(typeof next, "string");
  assert.ok(!same(next, old), "a new token");
  assert.ok(same(consoleToken(), next), "the running process uses the new token at once");
  assert.ok(same(readFileSync(file, "utf8"), next + "\n"));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ["console-token"], "no temp file is left");
});

test("the grant CLI path (a new process reading the file) gets the new token", () => {
  const old = consoleToken();
  assert.ok(same(tokenInNewProcess(), old));
  const next = rotateConsoleToken(old);
  assert.ok(same(tokenInNewProcess(), next), "a process started after the rotate reads the new token");
});

test("a rotate without the current token changes nothing", () => {
  const old = consoleToken();
  for (const given of [undefined, "", "x".repeat(36), old.slice(0, -1) + (old.at(-1) === "a" ? "b" : "a")]) {
    assert.equal(rotateConsoleToken(given), null);
  }
  assert.ok(same(consoleToken(), old));
});

test("two rotates at once with the same token: one wins, the other is refused, the file holds the winner", async () => {
  const old = consoleToken();
  const results = await Promise.all([0, 1].map(() => Promise.resolve().then(() => rotateConsoleToken(old))));
  const won = results.filter((r) => typeof r === "string");
  assert.equal(won.length, 1, "exactly one rotate succeeds");
  assert.equal(results.filter((r) => r === null).length, 1);
  assert.ok(same(consoleToken(), won[0]));
  assert.ok(same(readFileSync(file, "utf8"), won[0] + "\n"), "the file is whole and holds the one valid token");
  assert.deepEqual(readdirSync(dir), ["console-token"]);
});

test("a failed write leaves the old token valid and no temp file", () => {
  const old = consoleToken();
  chmodSync(dir, 0o500); // the folder cannot take the temp file
  assert.throws(() => rotateConsoleToken(old), (e) => /was not changed/.test(e.message) && !e.message.includes(old));
  chmodSync(dir, 0o700);
  assert.ok(same(consoleToken(), old), "the old token still works");
  assert.ok(same(readFileSync(file, "utf8").trim(), old));
  assert.deepEqual(readdirSync(dir), ["console-token"]);
});

test("a token pinned by TOUCHSTONE_GRANT_TOKEN cannot be rotated", () => {
  process.env.TOUCHSTONE_GRANT_TOKEN = "pinned-for-test";
  try {
    assert.throws(() => rotateConsoleToken("pinned-for-test"), /pinned by TOUCHSTONE_GRANT_TOKEN/);
    assert.equal(consoleToken(), "pinned-for-test");
  } finally {
    delete process.env.TOUCHSTONE_GRANT_TOKEN;
  }
});

test("a token file removed by hand gets a new token, saved once (the old way to rotate still works)", () => {
  const old = consoleToken();
  rmSync(file);
  const fresh = consoleToken();
  assert.ok(!same(fresh, old));
  assert.ok(same(consoleToken(), fresh), "the same new token on the next call");
  writeFileSync(file, "  \n"); // an empty file is no token either: it is replaced
  const again = consoleToken();
  assert.match(again, /^[0-9a-f-]{36}$/);
  assert.ok(same(readFileSync(file, "utf8").trim(), again), "saved, so every process reads the same token");
});
