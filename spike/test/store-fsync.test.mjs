// saveStore fsyncs the folder after the rename, so a crash right after a write
// cannot bring the old store file back.
//
//   node --experimental-test-module-mocks --test spike/test/store-fsync.test.mjs
import { TEST_STORE_DIR } from "./helpers/isolated-env.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import * as realFs from "node:fs";
import path from "node:path";

const calls = [];
let folderFsyncFails = null; // an error code the folder fsync throws, for one test
const fds = new Map(); // fd -> the path it was opened on
const fs = {
  ...realFs,
  openSync: (p, ...rest) => {
    const fd = realFs.openSync(p, ...rest);
    fds.set(fd, String(p));
    calls.push(["open", String(p)]);
    return fd;
  },
  fsyncSync: (fd) => {
    calls.push(["fsync", fds.get(fd)]);
    if (folderFsyncFails && fds.get(fd) === TEST_STORE_DIR) throw Object.assign(new Error(`${folderFsyncFails}: fsync failed`), { code: folderFsyncFails });
    return realFs.fsyncSync(fd);
  },
  renameSync: (a, b) => {
    calls.push(["rename", String(b)]);
    return realFs.renameSync(a, b);
  },
};
mock.module("node:fs", { exports: { ...fs, default: fs } });
const { saveStore } = await import("../lib/grant-store.mjs");

test("after the rename, the folder itself is fsynced", () => {
  const file = path.join(TEST_STORE_DIR, "fsync-store.json");
  calls.length = 0;
  saveStore(file, [{ id: 1 }]);
  const renamed = calls.findIndex(([op, p]) => op === "rename" && p === file);
  assert.ok(renamed >= 0, "the file was renamed into place");
  const synced = calls.findIndex(([op, p], i) => i > renamed && op === "fsync" && p === TEST_STORE_DIR);
  assert.ok(synced > renamed, `the folder ${TEST_STORE_DIR} is fsynced after the rename: ${JSON.stringify(calls)}`);
  assert.deepEqual(JSON.parse(realFs.readFileSync(file, "utf8")), [{ id: 1 }]);
});

test("a real fsync error on the folder is thrown; a system that cannot fsync a folder is not an error", () => {
  const file = path.join(TEST_STORE_DIR, "fsync-error.json");
  folderFsyncFails = "EIO";
  try {
    assert.throws(() => saveStore(file, [{ id: 2 }]), /EIO: fsync failed/);
    for (const code of ["EINVAL", "EISDIR", "EPERM", "EBADF"]) {
      folderFsyncFails = code;
      assert.doesNotThrow(() => saveStore(file, [{ id: code }]), code);
    }
  } finally {
    folderFsyncFails = null;
  }
});
