// A live script's own console output must reach the agent. Without it the agent
// has to smuggle a summary through a request to the target (the /x/<b64>/z
// scratch-route trick), which pollutes the transcript and the target.
import "./helpers/isolated-env.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const real = await import("../lib/live.mjs");
mock.module("../lib/live.mjs", {
  exports: {
    ...real,
    isLive: () => true,
    runLiveScript: async () => ({ transcript: [{ method: "GET", path: "/", status: 200, reqHeaders: {}, resHeaders: {}, resBody: "ok" }], stdout: "count=3\nhost=app.test", stderr: "", code: 0 }),
  },
});
const realProof = await import("../lib/proof-http.mjs");
mock.module("../lib/proof-http.mjs", {
  exports: { ...realProof, readLabHandle: () => ({ baseUrl: "http://lab.test" }), runRequestScript: async () => ({ transcript: [] }) },
});

const { default: web } = await import("../packs/web/pack.mjs");
const tool = (name) => web.tools({ kind: "live" }, { poc: 0, found: [], passed: new Map(), candidates: [] }).find((t) => t.name === name);
const textOf = (r) => r.output.map((o) => o.text).join("\n");

test("script stdout comes back to the agent, before the verdict text", async () => {
  const out = textOf(await tool("run_request_script").execute({ label: "p1", script: "console.log('x')" }));
  assert.match(out, /script output:\ncount=3\nhost=app\.test/);
  assert.ok(out.indexOf("script output:") < out.indexOf("No known harm pattern"), "output sits above the verdict");
});

test("the tool description names console.log as a return channel", () => {
  assert.match(tool("run_request_script").description, /console\.log\(\) in the script comes back/);
});
