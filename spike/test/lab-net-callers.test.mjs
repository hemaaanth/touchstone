// Every place that makes a Docker network goes through createLabNetwork
// (lib/lab-net.mjs). The helper keeps the flags its caller passes, so a call
// site that drops "--internal" gives a lab network a route to the host's LAN
// and the internet, and no Docker test notices (labnet-review Major 1).
//
//   node --experimental-test-module-mocks --test spike/test/lab-net-callers.test.mjs
//
// Two checks, with no Docker:
//   1. Source: every createLabNetwork call in lib/ and packs/ passes
//      "--internal", or is listed below with the flag it uses instead. A new
//      call site that is not internal fails until it is listed here.
//   2. Run time: lib/lab-net.mjs is stubbed, and each of the nine callers is
//      really called. The stub records the flags the caller passes and throws,
//      so no network or container is made. This checks what the code does, not
//      only its text (for example a flag built in a variable).
// The Docker tests (reach-confine, proof-http-lab-net) read .Internal from a
// real network for two of the callers.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The run-time seam: every importer of lib/lab-net.mjs gets this stub.
const realLabNet = await import("../lib/lab-net.mjs");
const made = [];
// How many creates the stub lets through (it answers code 0) before it throws.
let letThrough = 0;
class Stopped extends Error {}
mock.module("../lib/lab-net.mjs", {
  exports: {
    ...realLabNet,
    createLabNetwork: async (name, args = []) => {
      made.push({ name, args: [...args] });
      if (made.length <= letThrough) return { code: 0, stdout: "", stderr: "" };
      throw new Stopped(`stub: ${name} was not made`);
    },
    removeLabNetwork: async () => ({ code: 0, stdout: "", stderr: "" }),
  },
});

const SPIKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A caller that cannot be --internal, with the flag that isolates it instead.
const EXCEPTIONS = {
  // startTxLab publishes the chain on a host-only loopback port (-p 127.0.0.1::8545),
  // which an --internal network cannot do. ICC off keeps every other container off it.
  "lib/txreplay-proof.mjs": "com.docker.network.bridge.enable_icc=false",
};

function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "node_modules" || name === "test" || name.startsWith(".")) continue;
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

// The text of each createLabNetwork(...) call, up to its closing bracket.
function calls(src) {
  const found = [];
  for (let i = src.indexOf("createLabNetwork("); i !== -1; i = src.indexOf("createLabNetwork(", i + 1)) {
    if (/(?:function|import|export)\s*\{?[^(]*$/.test(src.slice(Math.max(0, i - 40), i))) continue; // the definition or an import
    let depth = 0;
    let j = i + "createLabNetwork".length;
    for (; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")" && --depth === 0) break;
    }
    found.push(src.slice(i, j + 1));
  }
  return found;
}

const callers = [...sources(path.join(SPIKE, "lib")), ...sources(path.join(SPIKE, "packs"))]
  .filter((f) => !f.endsWith(`${path.sep}lab-net.mjs`))
  .map((f) => ({ file: path.relative(SPIKE, f).split(path.sep).join("/"), calls: calls(readFileSync(f, "utf8")) }))
  .filter((c) => c.calls.length);

test("every lab network is made --internal, or is a listed exception with its own isolation flag", () => {
  assert.ok(callers.length >= 8, `found only ${callers.length} callers of createLabNetwork`);
  for (const { file, calls: cs } of callers) {
    for (const call of cs) {
      const flag = EXCEPTIONS[file];
      if (flag) assert.ok(call.includes(flag), `${file}: ${call} must keep ${flag}`);
      else assert.match(call, /["']--internal["']/, `${file}: ${call} does not pass --internal`);
    }
  }
});

test("the known lab network makers are all found", () => {
  const files = callers.map((c) => c.file);
  for (const f of [
    "lib/reach-confine.mjs", "lib/proof-http.mjs", "lib/fork-proof.mjs", "lib/oz-monitor.mjs",
    "lib/txreplay-proof.mjs", "packs/infra-cloud/cloud.mjs", "packs/phishing/labctl.mjs", "packs/domains/labctl.mjs",
  ]) assert.ok(files.includes(f), `${f} is not seen as a caller`);
  // proof-http makes two networks, inner and outer.
  assert.equal(callers.find((c) => c.file === "lib/proof-http.mjs").calls.length, 2);
});

// Call a caller, and return the flags it passed to createLabNetwork. The stub
// throws, so each caller stops at its first network. Not every caller cleans
// its temp folder on that error (startForkLab leaves forklab-*), so each call
// gets its own TMPDIR, removed after.
async function flagsOf(start) {
  made.length = 0;
  const own = mkdtempSync(path.join(tmpdir(), "lab-net-callers-tmp-"));
  const prev = process.env.TMPDIR;
  process.env.TMPDIR = own;
  try {
    await Promise.resolve().then(start).catch(() => {});
  } finally {
    if (prev === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prev;
    rmSync(own, { recursive: true, force: true });
  }
  assert.ok(made.length > 0, "the caller made no lab network");
  return made.map((m) => m.args);
}

test("at run time, every caller passes --internal (or its listed isolation flag)", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "lab-net-callers-"));
  try {
    const { confineReach } = await import("../lib/reach-confine.mjs");
    const { startLab } = await import("../lib/proof-http.mjs");
    const { startForkLab } = await import("../lib/fork-proof.mjs");
    const { startWatchLab } = await import("../lib/oz-monitor.mjs");
    const { startTxLab } = await import("../lib/txreplay-proof.mjs");
    const { runCloudPosture } = await import("../packs/infra-cloud/cloud.mjs");
    const { captureSnapshot, makeLabWorkspace } = await import("../packs/infra-cloud/snapshot.mjs");
    const phishing = await import("../packs/phishing/labctl.mjs");
    const domains = await import("../packs/domains/labctl.mjs");
    const cloudWs = makeLabWorkspace();
    const snapshot = captureSnapshot(cloudWs);
    rmSync(cloudWs, { recursive: true, force: true });
    const internal = {
      "reach-confine client": () => confineReach({ allowedHosts: ["granted.test"], allowPrivate: true, egressNetwork: "none", proxyPort: 8080 }),
      "proof-http inner": () => startLab({ image: "touchstone/not-started:0" }),
      "fork-proof": () => startForkLab({ image: "touchstone/not-started:0" }),
      "oz-monitor": () => startWatchLab(ws),
      "infra-cloud moto": () => runCloudPosture(snapshot),
      "phishing lab": () => phishing.startLab(),
      "domains lab": () => domains.startLab(),
    };
    for (const [who, start] of Object.entries(internal)) {
      const [first] = await flagsOf(start);
      assert.ok(first.includes("--internal"), `${who} passed ${JSON.stringify(first)}`);
    }
    // txreplay-proof publishes a loopback port, so it is the listed exception.
    const [tx] = await flagsOf(() => startTxLab({ image: "touchstone/not-started:0" }));
    assert.ok(!tx.includes("--internal") && tx.includes("com.docker.network.bridge.enable_icc=false"), `txreplay passed ${JSON.stringify(tx)}`);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("at run time, proof-http's outer network is --internal too", async () => {
  // Let the inner create through, so startLab goes on to the outer one.
  const { startLab } = await import("../lib/proof-http.mjs");
  letThrough = 1;
  try {
    const flags = await flagsOf(() => startLab({ image: "touchstone/not-started:0" }));
    assert.equal(flags.length, 2, "inner, then outer");
    assert.ok(flags.every((f) => f.includes("--internal")), JSON.stringify(flags));
  } finally {
    letThrough = 0;
  }
});
