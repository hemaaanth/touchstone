// Two console processes rotating the token at once: the check and the write
// run under the store lock of the token file, so exactly one wins.
//
//   node --test spike/test/console-token-rotate-lock.test.mjs
import { TEST_STORE_DIR } from "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const STORE = new URL("../lib/grant-store.mjs", import.meta.url).href;
const FILE = path.join(TEST_STORE_DIR, "rotate-token");
const GO = path.join(TEST_STORE_DIR, "rotate-go");

// One process that waits for the go file, then rotates with `old`, and prints
// "won" or "refused" (or the error).
function rotator(old) {
  const code = `
    const { existsSync } = await import("node:fs");
    const g = await import(${JSON.stringify(STORE)});
    const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const until = Date.now() + 10000;
    while (!existsSync(${JSON.stringify(GO)}) && Date.now() < until) pause(1);
    try { console.log(g.rotateConsoleToken(${JSON.stringify(old)}) ? "won" : "refused"); }
    catch (e) { console.log("error: " + e.message); }`;
  const env = { ...process.env, TOUCHSTONE_GRANT_TOKEN_FILE: FILE, TOUCHSTONE_STORE_LOCK_WAIT_MS: "10000" };
  delete env.TOUCHSTONE_GRANT_TOKEN;
  const c = spawn(process.execPath, ["--input-type=module", "-e", code], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  c.stdout.on("data", (d) => (out += d));
  return { ready: new Promise((res) => setTimeout(res, 0)), done: new Promise((res) => c.on("exit", () => res(out.trim()))) };
}

test("six processes rotate with the same token at once: exactly one wins, five are refused, the file holds the winner", async () => {
  for (let round = 0; round < 3; round++) {
    const old = `old-token-${round}-0123456789abcdef0123`;
    writeFileSync(FILE, old + "\n", { mode: 0o600 });
    rmSync(GO, { force: true });
    const procs = Array.from({ length: 6 }, () => rotator(old));
    await new Promise((res) => setTimeout(res, 400)); // all six are waiting for the go file
    writeFileSync(GO, "");
    const results = await Promise.all(procs.map((p) => p.done));
    assert.equal(results.filter((r) => r === "won").length, 1, `round ${round}: ${JSON.stringify(results)}`);
    assert.equal(results.filter((r) => r === "refused").length, 5, `round ${round}: ${JSON.stringify(results)}`);
    const now = readFileSync(FILE, "utf8").trim();
    assert.notEqual(now, old);
    assert.match(now, /^[0-9a-f-]{36}$/);
    assert.ok(!existsSync(`${FILE}.lock`) && !readdirSync(TEST_STORE_DIR).some((f) => f.endsWith(".tmp")), "no lock or temp file is left");
  }
  rmSync(GO, { force: true });
});
