import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";

// Execute the runner's exact functions without importing its provider/bootstrap.
const source = readFileSync(new URL("../agent-run.mjs", import.meta.url), "utf8");
const steers = source.slice(source.indexOf("function readSteers("), source.indexOf("// ---- Follow-up worker"));
const child = source.slice(source.indexOf("async function child("), source.indexOf("// Spawn a worker"));
const stdin = () => Object.assign(new EventEmitter(), { setEncoding() {}, resume() {} });

test("stdin consumes all Ask-tagged objects before text and drops malformed JSON", async () => {
  const input = stdin(), asked = [], submitted = [], events = [];
  const root = { submit: async (m) => { submitted.push(m); } };
  const read = runInNewContext(`${steers}; readSteers`, {
    process: { stdin: input }, ctx: {}, answerAsk: (m) => { asked.push(m); return false; }, event: (...e) => events.push(e),
  });
  read(root);
  const lines = [
    '{bad JSON', 'null', '[]', '"text"',
    JSON.stringify({ ask: "stale", done: true }),
    JSON.stringify({ ask: "invalid", text: "Never steer this reply" }),
    JSON.stringify({ ask: null, text: "Never steer malformed ask" }),
    JSON.stringify({ text: "Ordinary steer", id: "s1" }),
  ].join("\n") + "\n";
  input.emit("data", lines.slice(0, 17));
  input.emit("data", lines.slice(17));
  await Promise.resolve();
  assert.equal(asked.length, 3);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].content, "Ordinary steer");
  assert.equal(events[0][0], "operator-message");
  assert.equal(events[0][1].id, "s1");
  assert.ok(!JSON.stringify(events).includes("Never steer"));
});

function worker(overrides = {}) {
  const order = [], input = stdin(), proc = new EventEmitter();
  Object.assign(proc, { stdin: input, env: { TOUCHSTONE_PARENT_PIPE: "1" }, exit: (c) => order.push(`exit:${c}`) });
  const opened = {
    harness: { close: async () => order.push("harness-close") },
    fleet: { close: async () => order.push("fleet-close"), drain: async () => ({ status: "done" }) },
    root: { submit: async () => ({ wait: async () => ({ status: "done" }) }) },
    pack: { kickoff: () => "Start", nudge: () => null }, reports: [],
  };
  const env = {
    process: proc, ctx: {}, disposeAsks: () => order.push("dispose"), exitAfterEvents: (c) => order.push(`exit:${c}`),
    auditState: () => ({ found: [], candidates: [] }), openHarness: async () => opened,
    event: () => {}, chat: async () => {}, streamCognition: async () => {}, readSteers: () => {},
    summarize: async () => ({}), flushFinal: () => {}, chargeUsage: async () => ({}), ...overrides,
  };
  return { order, proc, input, opened, run: runInNewContext(`${child}; child`, env) };
}

test("normal run and follow-up dispose asks before closing fleet and harness", async () => {
  for (const mode of ["run", "chat"]) {
    const w = worker();
    await w.run([null, null, null, mode, "fake.sqlite", "fake-workspace"]);
    assert.deepEqual(w.order, ["dispose", "fleet-close", "harness-close", "exit:0"]);
  }
});

test("startup and turn failures dispose asks and close any opened harness", async () => {
  const failed = worker({ openHarness: async () => { throw new Error("startup test"); } });
  await assert.rejects(failed.run([null, null, null, "run"]), /startup test/);
  assert.deepEqual(failed.order, ["dispose"]);
  const turn = worker({ chat: async () => { throw new Error("turn test"); } });
  await assert.rejects(turn.run([null, null, null, "chat"]), /turn test/);
  assert.deepEqual(turn.order, ["dispose", "fleet-close", "harness-close"]);
});

test("fleet close failure still closes the harness after disposing asks", async () => {
  const w = worker();
  w.opened.fleet.close = async () => { w.order.push("fleet-close"); throw new Error("close test"); };
  await assert.rejects(w.run([null, null, null, "chat"]), /close test/);
  assert.deepEqual(w.order, ["dispose", "fleet-close", "harness-close"]);
});

test("stop and parent-pipe end dispose pending asks before exit", async () => {
  for (const [event, code] of [["SIGTERM", 143], ["SIGINT", 130], ["end", 1]]) {
    const w = worker({ openHarness: () => new Promise(() => {}) });
    void w.run([null, null, null, "run"]);
    (event === "end" ? w.input : w.proc).emit(event);
    assert.deepEqual(w.order, ["dispose", `exit:${code}`]);
  }
});

test("runner supplies shared Ask separately from pack and roam tools", () => {
  assert.match(source, /import \{ askHumanTool, answerAsk, disposeAsks \} from "\.\/lib\/ask\.mjs"/);
  assert.match(source, /createFleet\(\{[^\n]*sharedTools: \[askHumanTool\]/);
  assert.match(source, /else registry\.install\(defineExtension\(\{ name: "shared", tools: \[askHumanTool\] \}\)\)/);
});
