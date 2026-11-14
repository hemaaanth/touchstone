// Tests for the Foundry sandbox on the Daytona backend (lib/sandbox.mjs).
//
// A fake Daytona API answers every call. It runs each solc warm script for
// real with `sh`, but with a stub `docker` first on PATH. So a value that
// breaks out of the script's quoting would really run, and leave a marker
// file. No machine, no network, no cost.
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEYS = ["TOUCHSTONE_EXEC", "DAYTONA_API_KEY", "DAYTONA_PENDING", "DAYTONA_RETRY_MS"];

function fakeDaytona(dir, back = {}) {
  const log = [];
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // The result tar: forge output, plus the files the "container" wrote.
  const tarDir = join(dir, "res");
  mkdirSync(join(tarDir, "meta"), { recursive: true });
  writeFileSync(join(tarDir, "meta", "code"), "0\n");
  writeFileSync(join(tarDir, "meta", "out"), "ok");
  for (const [p, body] of Object.entries(back)) {
    mkdirSync(join(tarDir, "ws"), { recursive: true });
    writeFileSync(join(tarDir, "ws", p), body);
  }
  const resTar = execFileSync("tar", ["-cf", "-", "-C", tarDir, "."]);
  let n = 0;
  const json = (o) => new Response(JSON.stringify(o), { status: 200 });
  const fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    if (u.includes("/snapshots/")) return json({ state: "active" });
    if (method === "POST" && u.endsWith("/api/sandbox")) {
      log.push(`create m-${++n}`);
      return json({ id: `m-${n}`, toolboxProxyUrl: "https://tb.test" });
    }
    if (method === "DELETE") {
      // A real delete takes a while. A caller that does not wait misses it.
      await new Promise((r) => setTimeout(r, 30));
      log.push(`delete ${u.split("/").pop()}`);
      return new Response("", { status: 200 });
    }
    if (u.includes("/files/upload")) return new Response("", { status: 200 });
    if (u.includes("/files/download")) return new Response(resTar, { status: 200 });
    if (u.includes("/process/execute")) {
      const cmd = JSON.parse(init.body).command;
      log.push(cmd);
      const b64 = cmd.match(/echo (\S+) \| base64 -d/);
      if (b64) log.push(Buffer.from(b64[1], "base64").toString("utf8"));
      if (cmd.includes("foundry-svm")) {
        log.push("warm");
        execFileSync("sh", ["-c", cmd], { cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      }
      return json({ exitCode: 0, result: "" });
    }
    return new Response("unexpected", { status: 500 });
  };
  return { fetch, log };
}

async function withFake(back, fn) {
  const d = mkdtempSync(join(tmpdir(), "dtn-sbx-"));
  const saved = { env: Object.fromEntries(KEYS.map((k) => [k, process.env[k]])), fetch: globalThis.fetch, log: console.log };
  const fake = fakeDaytona(d, back);
  try {
    process.env.TOUCHSTONE_EXEC = "daytona";
    process.env.DAYTONA_API_KEY = "test-key-not-real";
    process.env.DAYTONA_PENDING = join(d, "pending.json");
    process.env.DAYTONA_RETRY_MS = "1";
    globalThis.fetch = fake.fetch;
    console.log = () => {};
    await fn({ d, fake });
  } finally {
    globalThis.fetch = saved.fetch;
    console.log = saved.log;
    for (const [k, v] of Object.entries(saved.env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(d, { recursive: true, force: true });
  }
}

// A workspace like makeWorkspace makes: a redteam-run-* dir in tmp.
function workspace(cfg) {
  const ws = mkdtempSync(join(tmpdir(), "redteam-run-"));
  mkdirSync(join(ws, "src"));
  writeFileSync(join(ws, "src", "A.sol"), "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.19;\ncontract A {}\n");
  writeFileSync(join(ws, ".touchstone.json"), JSON.stringify(cfg));
  return ws;
}

const payload = (marker) => `0.8.20'; touch ${marker}; echo '`;

test("A: pinnedSolc and warmFor pass only a plain x.y.z", async () => {
  const { pinnedSolc, warmFor } = await import("../lib/sandbox.mjs");
  const ws = workspace({ solc: "0.8.20'; touch /tmp/t6rev-pwn; echo '" });
  try {
    assert.equal(pinnedSolc(ws), "auto");
    // Treated as "auto": only the checked pragma floors are warmed.
    assert.deepEqual(warmFor(ws), ["0.8.19"]);
    for (const [solc, want] of [["0.8.20", "0.8.20"], ["=0.8.20", "0.8.20"], [undefined, "0.8.38"], ["auto", "auto"], ["^0.8.20", "auto"], ["0.8.20 ", "0.8.20"], [8, "auto"]]) {
      writeFileSync(join(ws, ".touchstone.json"), JSON.stringify(solc === undefined ? {} : { solc }));
      assert.equal(pinnedSolc(ws), want, String(solc));
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// Vector 1: the target ships its own .touchstone.json.
test("A: a target's .touchstone.json cannot run shell on the Daytona machine", async () => {
  await withFake({}, async ({ d, fake }) => {
    const { forgeTest, cleanupWorkspace } = await import("../lib/sandbox.mjs");
    const marker = join(d, "pwn");
    const ws = workspace({ kind: "lab", solc: payload(marker) });
    try {
      await forgeTest(ws);
      assert.ok(fake.log.includes("warm"), "the warm script ran (for the pragma floor)");
      assert.ok(!existsSync(marker), "the payload ran");
      assert.ok(!fake.log.some((l) => l.includes(marker)), "the payload reached a remote command");
    } finally {
      await cleanupWorkspace(ws);
    }
  });
});

// Vector 2: a container writes /work/.touchstone.json, which comes back to
// the host. The next forge run reads it.
test("A: a .touchstone.json written by a container cannot run shell on the next call", async () => {
  const marker = join(tmpdir(), `t6-pwn-${process.pid}`);
  rmSync(marker, { force: true });
  await withFake({ ".touchstone.json": JSON.stringify({ kind: "lab", solc: payload(marker) }) }, async ({ fake }) => {
    const { forgeTest, cleanupWorkspace } = await import("../lib/sandbox.mjs");
    const ws = workspace({ kind: "lab", solc: "0.8.19" });
    try {
      await forgeTest(ws);
      // The pull-back really wrote the bad config to the host workspace.
      assert.match(readFileSync(join(ws, ".touchstone.json"), "utf8"), /touch/);
      await forgeTest(ws);
      assert.ok(!existsSync(marker), "the payload ran");
      assert.ok(!fake.log.some((l) => l.includes(marker)), "the payload reached a remote command");
    } finally {
      await cleanupWorkspace(ws);
      rmSync(marker, { force: true });
    }
  });
});

// F: cleanupWorkspace waits for the machine deletes.
test("F: cleanupWorkspace resolves after the run's machines are deleted", async () => {
  await withFake({}, async ({ fake }) => {
    const { forgeTest, cleanupWorkspace } = await import("../lib/sandbox.mjs");
    const ws = workspace({ kind: "lab", solc: "0.8.19" });
    await forgeTest(ws);
    assert.ok(existsSync(`${ws}.daytona.json`));
    await cleanupWorkspace(ws);
    assert.ok(fake.log.includes("delete m-1"));
    assert.ok(!existsSync(`${ws}.daytona.json`));
    assert.ok(!existsSync(ws));
  });
});
