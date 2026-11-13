// startLab (lib/proof-http.mjs) puts the lab on an inner network and the
// script on an outer one, both --internal: the proxy is the only bridge, and
// neither network has a route to the host's LAN or the internet. This reads
// the flag from Docker for both networks of a real lab (labnet-review Major 1:
// no test failed when a call site dropped --internal).
//
//   node --test spike/test/proof-http-lab-net.test.mjs
//
// It uses the local web lab image and node:20-slim. Honest skip when Docker or
// an image is absent; nothing is pulled or built.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { startLab, stopLab } from "../lib/proof-http.mjs";

const IMAGE = "touchstone/web-lab:dev";
const has = (img) => {
  try {
    execFileSync("docker", ["image", "inspect", img], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const skip = has(IMAGE) && has("node:20-slim") ? false : `docker, ${IMAGE} or node:20-slim is not available`;
const inspect = (net, field) => execFileSync("docker", ["network", "inspect", "-f", `{{${field}}}`, net], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

test("a started lab's inner and outer networks are --internal in Docker", { skip, timeout: 180_000 }, async () => {
  const handle = await startLab({ image: IMAGE });
  try {
    assert.equal(handle.net, handle.netOuter, "scripts join the outer network");
    assert.equal(inspect(handle.netInner, ".Internal"), "true", "the lab's own network has no route off the host");
    assert.equal(inspect(handle.net, ".Internal"), "true", "the script's network has no route off the host");
  } finally {
    await stopLab(handle);
  }
  // stopLab removes both networks.
  for (const net of [handle.netInner, handle.netOuter]) {
    assert.throws(() => inspect(net, ".Name"), `${net} is removed`);
  }
});
