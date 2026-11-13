// The chain-watch lab network gets its own small subnet (review of L29): it was
// the last `docker network create` outside lib/lab-net.mjs, so Docker gave it a
// whole default address pool. Now startWatchLab uses createLabNetwork: a free /28
// per run, removed by stopWatchLab, and on SIGTERM with every container on it
// (lab-net) and the lab workspace (lib/temp-dirs.mjs).
//
// Real Docker; skips with a reason when the monitor or chain-tools image is missing.
//
//   node --test spike/test/oz-monitor-net.test.mjs
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OZ_LAB_IMAGE, OZ_MONITOR_DEFAULT_IMAGE, runMonitors, startWatchLab, stopWatchLab } from "../lib/oz-monitor.mjs";

const sh = (args) => { try { return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };
const needs = (sh(["image", "inspect", OZ_MONITOR_DEFAULT_IMAGE]) === null || sh(["image", "inspect", OZ_LAB_IMAGE]) === null)
  && "monitor or chain-tools image not built";
const CHAIN_LAB = fileURLToPath(new URL("../packs/chain-watch/lab", import.meta.url));
const newTag = () => randomBytes(4).toString("hex");
const subnetOf = (net) => sh(["network", "inspect", "-f", "{{range .IPAM.Config}}{{.Subnet}}{{end}}", net]);
const leftOf = (tag) => [
  ...(sh(["ps", "-a", "--format", "{{.Names}}"]) ?? "").split("\n"),
  ...(sh(["network", "ls", "--format", "{{.Name}}"]) ?? "").split("\n"),
].filter((n) => n.includes(tag));

test("two chain-watch labs at once: each on its own /28 from the lab range, both monitored, both removed", { skip: needs, timeout: 600_000 }, async () => {
  const [ta, tb] = [newTag(), newTag()];
  const [a, b] = await Promise.all([startWatchLab(CHAIN_LAB, { tag: ta }), startWatchLab(CHAIN_LAB, { tag: tb })]);
  try {
    const [sa, sb] = [subnetOf(a.net), subnetOf(b.net)];
    for (const s of [sa, sb]) assert.match(s, /^10\.(20[89]|21\d|22[0-3])\.\d+\.\d+\/28$/, `subnet ${s} is not a lab /28`);
    assert.notEqual(sa, sb);
    const [ra, rb] = await Promise.all([runMonitors(a), runMonitors(b)]);
    assert.equal(ra.available, true, ra.reason);
    assert.equal(rb.available, true, rb.reason);
  } finally { await stopWatchLab(a); await stopWatchLab(b); }
  for (const [h, t] of [[a, ta], [b, tb]]) {
    assert.deepEqual(leftOf(t), [], `lab ${t} left a container or network`);
    assert.equal(existsSync(h.labWs), false, `lab ${t} left its workspace`);
  }
});

test("a process killed by SIGTERM leaves no chain-watch network, container or workspace", { skip: needs, timeout: 600_000 }, async () => {
  const tag = newTag();
  const mod = fileURLToPath(new URL("../lib/oz-monitor.mjs", import.meta.url));
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    `const m = await import(${JSON.stringify(mod)}); const h = await m.startWatchLab(${JSON.stringify(CHAIN_LAB)}, { tag: ${JSON.stringify(tag)} });` +
    `console.log(h.labWs); m.runMonitors(h); setInterval(() => {}, 1000);`],
  { stdio: ["ignore", "pipe", "inherit"], env: process.env });
  const labWs = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (d) => { out += d; if (out.includes("\n")) resolve(out.trim()); });
    child.on("exit", (code) => reject(new Error(`child exited ${code} before the lab was ready`)));
  });
  assert.ok(existsSync(labWs));
  assert.ok(leftOf(tag).length >= 2, "the lab network and container are up");
  await new Promise((r) => setTimeout(r, 1500)); // let the monitor container start on the network
  const end = new Promise((resolve) => child.on("exit", (code, signal) => resolve(signal ?? code)));
  child.kill("SIGTERM");
  assert.equal(await end, "SIGTERM", "the process still dies by the signal");
  assert.deepEqual(leftOf(tag), [], "a container or the network was left");
  assert.equal(existsSync(labWs), false, "the lab workspace was left");
});
