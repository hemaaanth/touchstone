import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { setImmediate as tick } from "node:timers/promises";
import { createRoamControl } from "../lib/roam-control.mjs";

const source = readFileSync(new URL("../agent-run.mjs", import.meta.url), "utf8");
const steers = source.slice(source.indexOf("function readSteers("), source.indexOf("// ---- Follow-up worker"));
const request = (op, id, extra = {}) => ({ roamControl: { id, epoch: "worker-epoch", agent: "a-2", op, lease: "viewer-lease", ...extra } });

function reader(control) {
  const stdin = Object.assign(new EventEmitter(), { setEncoding() {}, resume() {} });
  const asks = [], steered = [];
  const read = runInNewContext(`${steers}; readSteers`, {
    process: { stdin }, ctx: {}, answerAsk: (line) => asks.push(line), event() {},
  });
  read({ submit: async (line) => steered.push(line) }, control);
  return { asks, steered, send: (line) => stdin.emit("data", `${JSON.stringify(line)}\n`) };
}

test("stdin allows Ask, status and cancellation while a real gate pause waits", async () => {
  let finishPause;
  const paused = new Promise((resolve) => { finishPause = resolve; });
  const calls = [], acks = [];
  const gate = createRoamControl({ epoch: "worker-epoch", isAgent: (id) => id === "a-2", emit: (ack) => acks.push(ack), remote: {
    pause: async () => { calls.push("pause"); await paused; },
    resume: async () => calls.push("resume"), close: async () => calls.push("close"),
  } });
  const r = reader(gate);
  try {
    r.send(request("pause", "pause1"));
    await tick();
    assert.deepEqual(calls, ["pause"]);
    r.send({ ask: "answer1", done: false });
    r.send(request("status", "status1"));
    r.send(request("cancel", "cancel1"));
    await tick();
    assert.equal(r.asks.length, 1);
    assert.deepEqual(calls, ["pause", "close"]);
    assert.ok(acks.some((a) => a.id === "status1" && a.state === "pausing"));
    assert.ok(acks.some((a) => a.id === "cancel1" && a.state === "closed" && a.ok));
    finishPause();
    await tick();
    assert.ok(acks.some((a) => a.id === "pause1" && !a.ok && a.state === "closed"));
    assert.ok(acks.every((a) => a.ev === "roam-control" && a.epoch === "worker-epoch"));
    assert.deepEqual(r.steered, []);
  } finally { finishPause(); gate.dispose(); }
});

test("tagged malformed or stale gate input never steers or reaches remote", async () => {
  const acks = [];
  const nope = async () => assert.fail("invalid input reached remote");
  const gate = createRoamControl({ epoch: "worker-epoch", isAgent: (id) => id === "a-2", emit: (a) => acks.push(a), remote: { pause: nope, resume: nope, close: nope } });
  const r = reader(gate);
  try {
    r.send({ roamControl: null, text: "Never steer" });
    r.send({ roamControl: {}, text: "Never steer" });
    r.send({ ...request("pause", "stale", { epoch: "old-worker" }), text: "Never steer" });
    r.send(request("pause", "unknown", { agent: "a-99" }));
    await tick();
    assert.deepEqual(r.steered, []);
    assert.deepEqual(acks.map((a) => a.error), ["ROAM_EPOCH", "ROAM_AGENT"]);
    const unattached = reader(undefined);
    unattached.send({ roamControl: {}, text: "Never steer before attachment" });
    assert.deepEqual(unattached.steered, []);
  } finally { gate.dispose(); }
});
