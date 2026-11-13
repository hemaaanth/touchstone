import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const calls = [];
mock.module("node:child_process", { exports: { execFile: (_command, args, _opts, cb) => {
  calls.push(args);
  const output = args[0] === "network" && args[1] === "inspect"
    ? JSON.stringify({ "scan-container-id": { Name: "leftover-scan" } }) : "";
  queueMicrotask(() => cb(null, output, ""));
} } });
const { writeLabHandle, writeScanHandle, teardownPersistedLab } = await import("../lib/proof-http.mjs");

test("restart removes a scanner container before removing its private network", async () => {
  const ws = mkdtempSync(join(tmpdir(), "scan-restart-"));
  try {
    writeLabHandle(ws, { labName: "main-lab", proxyName: "main-proxy", netInner: "main-inner", netOuter: "main-outer" });
    writeScanHandle(ws, { labName: "scan-lab", proxyName: "scan-proxy", netInner: "scan-inner", netOuter: "scan-outer" });
    await teardownPersistedLab(ws);
    const scanRemoved = calls.findIndex((a) => a[0] === "rm" && a[2] === "scan-container-id");
    const netRemoved = calls.findIndex((a) => a[0] === "network" && a[1] === "rm" && a[2] === "scan-outer");
    assert.ok(scanRemoved >= 0 && netRemoved > scanRemoved);
    assert.ok(calls.some((a) => a[0] === "network" && a[1] === "rm" && a[2] === "main-inner"));
    assert.ok(!existsSync(join(ws, ".touchstone-http-scan.json")));
    assert.ok(!existsSync(join(ws, ".touchstone-http-lab.json")));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
