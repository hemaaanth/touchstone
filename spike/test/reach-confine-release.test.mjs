import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { docker, dockerReady } from "../lib/reach-confine.mjs";
import { createLabNetwork, removeLabNetwork } from "../lib/lab-net.mjs";

const IMAGE = "node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0";
const MODULES = ["reach-confine.mjs", "lab-net.mjs", "scope-proxy.mjs", "grant-store.mjs", "public-suffix.mjs"];

test("a sealed release proxy reaches a granted lab and still blocks other hosts", { timeout: 90_000 }, async (t) => {
  const ready = await dockerReady();
  if (!ready.ok) return t.skip(ready.reason);
  if (process.getuid() === 0) return t.skip("requires a non-root source owner to catch capability-dropped root losing source access");

  // Source only: no backend import, real stores, credentials, or external hosts.
  const root = mkdtempSync(join(tmpdir(), "touchstone-sealed-proxy-"));
  const lib = join(root, "lib");
  const tag = randomBytes(4).toString("hex");
  const network = `touchstone-release-target-${tag}`;
  const origin = `touchstone-release-origin-${tag}`;
  let networkCreated = false;
  let confine;
  try {
    mkdirSync(lib);
    for (const name of MODULES) {
      const dest = join(lib, name);
      copyFileSync(new URL(`../lib/${name}`, import.meta.url), dest);
      chmodSync(dest, 0o400);
    }
    chmodSync(lib, 0o500);
    const sealed = await import(pathToFileURL(join(lib, "reach-confine.mjs")).href);
    const created = await createLabNetwork(network, ["--internal"], { docker });
    assert.equal(created.code, 0, created.stderr);
    networkCreated = true;
    const started = await docker([
      "run", "-d", "--pull=never", "--name", origin,
      "--network", network, "--network-alias", "allowed.test",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--pids-limit", "64", "--memory", "128m", "--entrypoint", "node", IMAGE,
      "-e", "require('http').createServer((q,s)=>s.end('SEALED-LAB')).listen(8080,'0.0.0.0')",
    ]);
    assert.equal(started.code, 0, started.stderr);
    confine = await sealed.confineReach({ allowedHosts: ["allowed.test"], allowPrivate: true, egressNetwork: network });
    const reply = await confine.runClient(["--input-type=module", "-e", `
      const ask = async host => {
        const r = await fetch(${JSON.stringify(confine.gateUrl)}, {
          headers: {'x-touchstone-url': 'http://' + host + ':8080/'},
          signal: AbortSignal.timeout(5000)
        });
        return {status:r.status, text:await r.text()};
      };
      const allowed = await ask('allowed.test');
      const blocked = await ask('blocked.test');
      console.log(JSON.stringify({allowed,blocked}));
    `]);
    assert.equal(reply.code, 0, reply.stderr);
    const result = JSON.parse(reply.stdout.trim());
    assert.deepEqual(result.allowed, { status: 200, text: "SEALED-LAB" });
    assert.equal(result.blocked.status, 403);
    assert.equal(statSync(lib).mode & 0o777, 0o500);
    for (const name of MODULES) assert.equal(statSync(join(lib, name)).mode & 0o777, 0o400);
  } finally {
    await confine?.stop();
    await docker(["rm", "-f", origin]);
    if (networkCreated) await removeLabNetwork(network, { docker });
    chmodSync(lib, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});
