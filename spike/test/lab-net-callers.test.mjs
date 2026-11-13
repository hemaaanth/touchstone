// Every place that makes a Docker network goes through createLabNetwork
// (lib/lab-net.mjs). The helper keeps the flags its caller passes, so a call
// site that drops "--internal" gives a lab network a route to the host's LAN
// and the internet, and no Docker test notices (labnet-review Major 1).
//
//   node --test spike/test/lab-net-callers.test.mjs
//
// This reads the source of every caller, with no Docker. Each call must pass
// "--internal", or be listed below with the flag it uses instead and why. A new
// call site that is not internal fails until it is listed here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
