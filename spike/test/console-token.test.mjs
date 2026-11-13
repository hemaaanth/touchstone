// The console token is saved once, so a server restart keeps it. Each case
// loads grant-store in a fresh process, as a server start does.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../lib/grant-store.mjs");

function tokenOf(env) {
  const code = `const m = await import(${JSON.stringify(STORE)}); process.stdout.write(m.consoleToken())`;
  const clean = { ...process.env, ...env };
  if (!("TOUCHSTONE_GRANT_TOKEN" in env)) delete clean.TOUCHSTONE_GRANT_TOKEN;
  return execFileSync(process.execPath, ["--input-type=module", "-e", code], { env: clean, encoding: "utf8" });
}

test("the token is saved on first start and is the same on the next start", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-token-"));
  const file = path.join(dir, "nested", "console-token");
  try {
    const first = tokenOf({ TOUCHSTONE_GRANT_TOKEN_FILE: file });
    assert.match(first, /^[0-9a-f-]{36}$/);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(tokenOf({ TOUCHSTONE_GRANT_TOKEN_FILE: file }), first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TOUCHSTONE_GRANT_TOKEN pins the token and saves no file", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-token-"));
  const file = path.join(dir, "console-token");
  try {
    assert.equal(tokenOf({ TOUCHSTONE_GRANT_TOKEN: "pinned", TOUCHSTONE_GRANT_TOKEN_FILE: file }), "pinned");
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
