// The real mcp-shield image, run through runTool() against the poisoned fixture
// server on an --internal Docker network (no internet, no model call). It shows
// that the image we build still gives the output the parser test was recorded
// from. It skips when Docker or the images are missing.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runDocker, runTool } from "../lib/wrap.mjs";
import { createLabNetwork, removeLabNetwork } from "../lib/lab-net.mjs";
import { IMAGES, parseShield, scanMcp } from "../packs/ai-mcp/scan.mjs";

// The same digest-pinned base as Dockerfile.shield, so no extra pull.
const NODE = "node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0";
const FIXTURES = new URL("./fixtures/mcp-shield", import.meta.url).pathname;
const id = `${process.pid}-${Date.now()}`;
const net = `ts-shield-test-${id}`;
const server = `ts-shield-poison-${id}`;

const skip = (() => {
  try {
    for (const i of [IMAGES.shield, NODE]) execFileSync("docker", ["image", "inspect", i], { stdio: "ignore" });
    return false;
  } catch { return "Docker or the mcp-shield image is missing (npm run build:labs -- shield)"; }
})();

before(async () => {
  if (skip) return;
  const n = await createLabNetwork(net, ["--internal"], { docker: runDocker });
  if (n.code !== 0) throw new Error(`network create failed: ${n.stderr}`);
  const s = await runDocker([
    "run", "-d", "--rm", "--name", server, "--network", net, "--network-alias", "poison",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", `${process.getuid()}:${process.getgid()}`,
    "-v", `${FIXTURES}:/fx:ro`, "--entrypoint", "node", NODE, "/fx/poisoned-server.mjs",
  ]);
  if (s.code !== 0) throw new Error(`fixture server failed to start: ${s.stderr}`);
  await new Promise((r) => setTimeout(r, 1500));
}, { timeout: 120_000 });

after(async () => {
  if (skip) return;
  await runDocker(["rm", "-f", server]);
  await removeLabNetwork(net, { docker: runDocker });
});

const leadKeys = (leads) => leads.map((l) => `${l.check}|${l.where}|${l.impact}`).sort();

test("the real mcp-shield image finds the planted patterns and matches the recorded output", { skip, timeout: 180_000 }, async () => {
  const out = await scanMcp({ net, baseUrl: "http://poison:8080", token: "tok_fixture", only: ["mcp-shield"] });
  assert.equal(out.coverage[0].status, "ran", out.coverage[0].reason);
  const recorded = parseShield(readFileSync(`${FIXTURES}/poisoned.json`, "utf8"));
  assert.deepEqual(leadKeys(out.leads), leadKeys(recorded.leads));
});

test("the real mcp-shield image reports a refused token as an error, not a clean scan", { skip, timeout: 180_000 }, async () => {
  const r = await runTool({ image: IMAGES.shield, network: net, timeoutMs: 120_000, env: { MCP_TOKEN: "wrong" }, cmd: ["http://poison:8080/mcp"] });
  assert.notEqual(r.code, 0);
  const p = parseShield(r.stdout);
  assert.equal(p.ok, false);
  assert.match(p.error, /unauthorized/);
});
