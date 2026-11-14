// The real garak image, run through scanMcp()/runTool() against the echo stub
// (test/fixtures/garak/echo-server.py). The stub runs in its own container with
// --network none and listens on 127.0.0.1. garak joins that container's network
// namespace, so no request can leave the host and no model is called. It shows
// that the image we build still gives the output the parser test was recorded
// from, and that the relay holds the budget. Skips when the image is missing.
import "./helpers/isolated-env.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runDocker } from "../lib/wrap.mjs";
import { IMAGES, parseGarak, scanMcp } from "../packs/ai-mcp/scan.mjs";

const FIXTURES = new URL("./fixtures/garak", import.meta.url).pathname;
const stub = `ts-garak-stub-${process.pid}-${Date.now()}`;

const skip = (() => {
  try { execFileSync("docker", ["image", "inspect", IMAGES.garak], { stdio: "ignore" }); return false; }
  catch { return "Docker or the garak image is missing (npm run build:labs -- garak)"; }
})();

const count = async () => {
  const r = await runDocker(["exec", stub, "python", "-c", "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8080/count').read().decode())"]);
  return JSON.parse(r.stdout);
};

before(async () => {
  if (skip) return;
  const s = await runDocker([
    "run", "-d", "--rm", "--name", stub, "--network", "none",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", `${process.getuid()}:${process.getgid()}`,
    "-v", `${FIXTURES}:/fx:ro`, "--entrypoint", "python", IMAGES.garak, "-I", "/fx/echo-server.py",
  ]);
  if (s.code !== 0) throw new Error(`stub failed to start: ${s.stderr}`);
  await new Promise((r) => setTimeout(r, 1500));
}, { timeout: 60_000 });

after(async () => { if (!skip) await runDocker(["rm", "-f", stub]); });

const net = `container:${stub}`;

test("the real garak image stays inside its budget and its leads match the recorded output", { skip, timeout: 600_000 }, async () => {
  const before = await count();
  const out = await scanMcp({ net, baseUrl: "http://127.0.0.1:8080", token: "tok_fixture", garak: { path: "/agent/chat", budget: 16 }, only: ["garak"] });
  const after = await count();
  assert.equal(out.coverage[0].status, "ran", out.coverage[0].reason);
  assert.ok(after.chat - before.chat <= 16, `the stub answered ${after.chat - before.chat} requests, budget 16`);
  const recorded = parseGarak(readFileSync(`${FIXTURES}/echo.json`, "utf8"), { path: "/agent/chat" });
  const keys = (leads) => leads.map((l) => `${l.check}|${l.where}`).sort();
  assert.deepEqual(keys(out.leads), keys(recorded.leads));
});

test("the real garak image reports a refused token as an error and stops after one request", { skip, timeout: 600_000 }, async () => {
  const before = await count();
  const out = await scanMcp({ net, baseUrl: "http://127.0.0.1:8080", token: "wrong", garak: { path: "/agent/chat", budget: 16 }, only: ["garak"] });
  const after = await count();
  assert.equal(out.coverage[0].status, "unavailable");
  assert.match(out.coverage[0].reason, /garak failed: no reply came back from the endpoint \(1 requests/);
  assert.equal(after.refused - before.refused, 1);
  assert.equal(after.chat, before.chat);
});
