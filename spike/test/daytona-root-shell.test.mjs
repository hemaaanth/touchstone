import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rootShellCommand } from "../lib/daytona-api.mjs";
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

// These exercise quoting/routing with a fake id and fake sudo. They do not
// elevate the test process; the real root probe is a separate container check.
function route(uid, permission, fn) {
  const dir = mkdtempSync(join(tmpdir(), "daytona-root-route-"));
  const log = join(dir, "calls");
  try {
    symlinkSync("/bin/sh", join(dir, "sh"));
    writeFileSync(join(dir, "id"), `#!/bin/sh\nprintf '%s\\n' \"\${FAKE_ROOT:-${uid}}\"\n`, { mode: 0o755 });
    if (permission !== "missing") writeFileSync(join(dir, "sudo"), `#!/bin/sh\nprintf 'sudo-call\\n' >> ${quote(log)}\n[ "$1" = -n ] || exit 97\nshift\n[ "$ALLOW" = 1 ] || { [ "$ALLOW" = true-only ] && [ "$1" = true ]; } || exit 1\nexport FAKE_ROOT=0\nexec "$@"\n`, { mode: 0o755 });
    const env = { PATH: permission === "missing" ? dir : `${dir}:/usr/bin:/bin`, HOME: "/synthetic-home", ALLOW: permission === "allowed" ? "1" : permission === "true-only" ? "true-only" : "0" };
    fn({ env, log });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("an existing root shell preserves exact quoted command bytes without sudo", () => route(0, "denied", ({ env }) => {
  const expected = `a' b;\n$HOME "literal"`;
  assert.equal(execFileSync("/bin/sh", ["-c", rootShellCommand(`printf %s ${quote(expected)}`)], { env, encoding: "utf8" }), expected);
}));
test("a non-root shell uses only non-interactive sudo and preserves command bytes", () => route(1000, "allowed", ({ env, log }) => {
  const expected = `a' b;\n$HOME "literal"`;
  assert.equal(execFileSync("/bin/sh", ["-c", rootShellCommand(`printf %s ${quote(expected)}`)], { env, encoding: "utf8" }), expected);
  assert.equal(readFileSync(log, "utf8"), "sudo-call\nsudo-call\n");
}));
for (const permission of ["denied", "missing", "true-only"]) test(`${permission} sudo fails closed before dispatching the requested command`, () => route(1000, permission, ({ env }) => {
  const r = spawnSync("/bin/sh", ["-c", rootShellCommand("printf should-not-run")], { env, encoding: "utf8", timeout: 1000 });
  assert.equal(r.status, 76);
  assert.equal(r.stdout, "");
}));

test("payload failures retain their own status after permitted root entry", () => route(1000, "allowed", ({ env }) => {
  const r = spawnSync("/bin/sh", ["-c", rootShellCommand("exit 1")], { env, encoding: "utf8" });
  assert.equal(r.status, 1);
}));
