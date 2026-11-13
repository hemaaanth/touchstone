// A lab starter that makes a temp folder and then throws must remove that
// folder (and whatever else it made) before the throw leaves it. Before this,
// startForkLab left forklab-* when its network create failed, startTxLab left
// txlab-* when its seed copy failed, runForkPoc left forkpoc-*, makeLabCopy
// left its copy, and startLab (proof-http) left the proxy folder, the lab
// container and both networks when the proxy folder setup threw.
//
//   node --experimental-test-module-mocks --test spike/test/lab-temp-cleanup.test.mjs
//
// No Docker and no network: node:child_process is a fake docker that answers
// code 0, lib/lab-net.mjs is a stub, and node:fs throws on one chosen copy or
// write. Each test runs the starter with its own TMPDIR and checks it is empty.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import * as realFs from "node:fs";
import * as realChild from "node:child_process";
import * as realLabNet from "../lib/lab-net.mjs";
import { tmpdir } from "node:os";
import path from "node:path";

// The switches a test sets: which copy or write throws, and the network answer.
const fault = { copyTo: null, writeEnd: null, netCode: 0 };
const dockerCalls = [];
const netsMade = [];
const netsRemoved = [];

const cpSync = (src, dest, ...rest) => {
  if (fault.copyTo && String(dest).includes(fault.copyTo)) throw new Error(`fault: copy into ${fault.copyTo}`);
  return realFs.cpSync(src, dest, ...rest);
};
const writeFileSync = (file, ...rest) => {
  if (fault.writeEnd && String(file).endsWith(fault.writeEnd)) throw new Error(`fault: write ${fault.writeEnd}`);
  return realFs.writeFileSync(file, ...rest);
};
mock.module("node:fs", { exports: { ...realFs, default: { ...realFs, cpSync, writeFileSync }, cpSync, writeFileSync } });

const execFile = (cmd, args, opts, cb) => {
  dockerCalls.push(args);
  (typeof opts === "function" ? opts : cb)(null, "", "");
};
mock.module("node:child_process", { exports: { ...realChild, default: { ...realChild, execFile }, execFile } });

mock.module("../lib/lab-net.mjs", {
  exports: {
    ...realLabNet,
    createLabNetwork: async (name) => {
      netsMade.push(name);
      return fault.netCode === 0 ? { code: 0, stdout: "", stderr: "" } : { code: fault.netCode, stdout: "", stderr: "fault: no network" };
    },
    removeLabNetwork: async (name) => {
      netsRemoved.push(name);
      return { code: 0, stdout: "", stderr: "" };
    },
  },
});

const { startForkLab, runForkPoc } = await import("../lib/fork-proof.mjs");
const { startTxLab } = await import("../lib/txreplay-proof.mjs");
const { startLab } = await import("../lib/proof-http.mjs");
const { makeLabCopy } = await import("../packs/domains/labctl.mjs");

// Run start with its own TMPDIR. It must throw, and leave that folder empty.
async function leavesNothing(start, set = {}) {
  Object.assign(fault, { copyTo: null, writeEnd: null, netCode: 0 }, set);
  dockerCalls.length = 0;
  netsMade.length = 0;
  netsRemoved.length = 0;
  const own = realFs.mkdtempSync(path.join(tmpdir(), "lab-temp-cleanup-"));
  const prev = process.env.TMPDIR;
  process.env.TMPDIR = own;
  try {
    await assert.rejects(Promise.resolve().then(start));
    assert.deepEqual(realFs.readdirSync(own), [], "the starter's temp folder is removed");
  } finally {
    if (prev === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prev;
    realFs.rmSync(own, { recursive: true, force: true });
    Object.assign(fault, { copyTo: null, writeEnd: null, netCode: 0 });
  }
}

test("startForkLab removes forklab-* when its network create fails", async () => {
  await leavesNothing(() => startForkLab({ image: "touchstone/not-started:0" }), { netCode: 1 });
  assert.equal(netsMade.length, 1);
});

test("startForkLab removes forklab-* when its seed copy fails", async () => {
  await leavesNothing(() => startForkLab({ image: "touchstone/not-started:0" }), { copyTo: "forklab-" });
  assert.equal(netsMade.length, 0, "it stopped before the network");
});

test("runForkPoc removes forkpoc-* when its seed copy fails", async () => {
  await leavesNothing(() => runForkPoc({ net: "n", labName: "l" }, "contract X {}", { contract: "X" }), { copyTo: "forkpoc-" });
  assert.equal(dockerCalls.length, 0, "no forge run started");
});

test("startTxLab removes txlab-* when its seed copy fails", async () => {
  await leavesNothing(() => startTxLab({ image: "touchstone/not-started:0" }), { copyTo: "txlab-" });
  assert.equal(netsMade.length, 0);
});

test("makeLabCopy removes its copy when the copy fails", async () => {
  await leavesNothing(() => makeLabCopy(path.join(tmpdir(), "no-such-lab-folder"), { web: "10.208.0.2" }));
});

test("startLab (proof-http) removes the proxy folder, the lab and both networks when the proxy setup fails", async () => {
  await leavesNothing(() => startLab({ image: "touchstone/not-started:0" }), { writeEnd: "recorder.mjs" });
  assert.equal(netsMade.length, 2, "inner and outer were made");
  assert.deepEqual([...netsRemoved].sort(), [...netsMade].sort(), "both networks are removed");
  const removed = dockerCalls.filter((a) => a[0] === "rm" && a[1] === "-f").map((a) => a[2]);
  assert.ok(removed.some((n) => /^touchstone-lab-/.test(n)), "the lab container is removed");
});
