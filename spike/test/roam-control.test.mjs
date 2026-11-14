import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoamControl } from "../lib/roam-control.mjs";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(overrides = {}) {
  const calls = [], events = [];
  const remote = Object.fromEntries(["pause", "resume", "close"].map((op) => [op, async (agent) => { calls.push([op, agent]); }]));
  const gate = createRoamControl({ epoch: "worker-2", remote, emit: (ack) => events.push(ack),
    isAgent: (agent) => ["a-1", "a-2"].includes(agent), ...overrides });
  return { gate, calls, events };
}
const line = (op, extra = {}) => ({ roamControl: { id: `${op}-1`, epoch: "worker-2", agent: "a-1", op, lease: "lease-1", ...extra } });
const rejects = (promise, code) => assert.rejects(promise, { message: code });

// These fakes prove gate sequencing only, not real browser or shell quiescence.
test("construction does not call remote, emit, or the trusted predicate", () => {
  let count = 0;
  const call = () => { count++; };
  const gate = createRoamControl({ epoch: "worker-2", remote: { pause: call, resume: call, close: call }, emit: call, isAgent: call });
  assert.equal(count, 0);
  gate.dispose();
  assert.equal(count, 0);
});

test("shell and browse share a FIFO gate; another agent proceeds", async () => {
  const { gate } = fixture();
  const held = deferred(), order = [];
  const shell = gate.run("a-1", async () => { order.push("shell"); await held.promise; return "shell-result"; });
  const browse = gate.run("a-1", () => { order.push("browse"); return "browse-result"; });
  assert.equal(await gate.run("a-2", () => "other-agent"), "other-agent");
  assert.deepEqual(order, ["shell"]);
  held.resolve();
  assert.deepEqual(await Promise.all([shell, browse]), ["shell-result", "browse-result"]);
  assert.deepEqual(order, ["shell", "browse"]);
});

test("pause synchronously rejects queued/new work, drains active work, then waits for remote", async () => {
  const active = deferred(), remotePause = deferred(), calls = [];
  const { gate, events } = fixture({ remote: { pause: (agent) => { calls.push(agent); return remotePause.promise; }, resume() {}, close() {} } });
  const running = gate.run("a-1", () => active.promise);
  const queued = rejects(gate.run("a-1", () => assert.fail("queued work ran")), "ROAM_PAUSED");
  const handling = gate.handle(JSON.stringify(line("pause")));
  await rejects(gate.run("a-1", () => assert.fail("new work ran")), "ROAM_PAUSED");
  await queued;
  assert.deepEqual(calls, []);
  assert.deepEqual(events, []);
  active.resolve("done");
  assert.equal(await running, "done");
  await tick();
  assert.deepEqual(calls, ["a-1"]);
  assert.deepEqual(events, []);
  remotePause.resolve();
  assert.equal(await handling, true);
  assert.deepEqual(events[0], { ev: "roam-control", id: "pause-1", epoch: "worker-2", agent: "a-1", op: "pause", lease: "lease-1", ok: true, state: "paused" });
});

test("pause works before the first action, using only trusted membership", async () => {
  const { gate, calls } = fixture();
  assert.deepEqual(await gate.pause("a-1", "lease-1"), { state: "paused", lease: "lease-1" });
  assert.deepEqual(calls, [["pause", "a-1"]]);
  await rejects(gate.run("a-1", () => 1), "ROAM_PAUSED");
  assert.equal(await gate.run("a-2", () => 2), 2);
});

test("duplicate pauses share one operation; foreign lease never changes it", async () => {
  const hold = deferred();
  let pauses = 0;
  const { gate } = fixture({ remote: { pause() { pauses++; return hold.promise; }, resume() {}, close() {} } });
  const first = gate.pause("a-1", "lease-1");
  assert.equal(gate.pause("a-1", "lease-1"), first);
  await rejects(gate.pause("a-1", "foreign"), "ROAM_LEASE_MISMATCH");
  await rejects(gate.resume("a-1", "foreign"), "ROAM_LEASE_MISMATCH");
  await rejects(gate.cancel("a-1", "foreign"), "ROAM_LEASE_MISMATCH");
  await rejects(gate.resume("a-1", "lease-1"), "ROAM_NOT_PAUSED");
  hold.resolve();
  await first;
  assert.equal(gate.pause("a-1", "lease-1"), first);
  assert.equal(pauses, 1);
});

test("rejected active work still drains and a rejected run cannot poison FIFO", async () => {
  const { gate, calls } = fixture();
  const active = deferred();
  const running = rejects(gate.run("a-1", () => active.promise), "ROAM_RUN_FAILED");
  const paused = gate.pause("a-1", "lease-1");
  active.reject(new Error("private remote detail"));
  await running;
  await paused;
  assert.deepEqual(calls, [["pause", "a-1"]]);
  await gate.resume("a-1", "lease-1");
  await rejects(gate.run("a-1", () => { throw new Error("private script"); }), "ROAM_RUN_FAILED");
  assert.equal(await gate.run("a-1", () => 7), 7);
});

test("pause failure remains failed and duplicate calls do not retry or unlock", async () => {
  let pauses = 0;
  const { gate, events } = fixture({ remote: { pause() { pauses++; throw new Error("secret"); }, resume() { assert.fail("must not resume failed pause"); }, close() {} } });
  await gate.handle(line("pause"));
  assert.equal(events[0].error, "ROAM_PAUSE_FAILED");
  assert.equal(events[0].state, "failed");
  await rejects(gate.pause("a-1", "lease-1"), "ROAM_PAUSE_FAILED");
  await rejects(gate.resume("a-1", "lease-1"), "ROAM_NOT_PAUSED");
  await rejects(gate.run("a-1", () => 1), "ROAM_PAUSED");
  assert.equal(pauses, 1);
  assert.equal(JSON.stringify(events).includes("secret"), false);
});

test("resume waits for remote success, is idempotent, and never replays queued work", async () => {
  const hold = deferred();
  let resumes = 0;
  const { gate } = fixture({ remote: { pause() {}, resume() { resumes++; return hold.promise; }, close() {} } });
  await gate.pause("a-1", "lease-1");
  const first = gate.resume("a-1", "lease-1");
  assert.equal(gate.resume("a-1", "lease-1"), first);
  await rejects(gate.run("a-1", () => assert.fail("ran during resume")), "ROAM_PAUSED");
  hold.resolve();
  assert.deepEqual(await first, { state: "running", lease: "lease-1" });
  assert.equal(gate.resume("a-1", "lease-1"), first);
  assert.equal(resumes, 1);
  assert.equal(await gate.run("a-1", () => 5), 5);
});

test("resume failure stays paused, sanitizes error, and accepts cancel", async () => {
  const { gate, events } = fixture({ remote: { pause() {}, resume() { throw new Error("secret"); }, close() {} } });
  await gate.pause("a-1", "lease-1");
  await gate.handle(line("resume"));
  assert.equal(events[0].error, "ROAM_RESUME_FAILED");
  assert.equal(events[0].state, "paused");
  await rejects(gate.run("a-1", () => 1), "ROAM_PAUSED");
  assert.deepEqual(await gate.cancel("a-1", "lease-1"), { state: "closed", lease: "lease-1" });
});

test("old leases cannot affect a later takeover", async () => {
  const { gate, events } = fixture();
  await gate.pause("a-1", "lease-1");
  await gate.resume("a-1", "lease-1");
  await gate.handle(line("pause", { id: "old-pause" }));
  assert.equal(events[0].state, "running");
  await gate.pause("a-1", "lease-2");
  await rejects(gate.resume("a-1", "lease-1"), "ROAM_LEASE_MISMATCH");
  await rejects(gate.pause("a-1", "lease-1"), "ROAM_LEASE_MISMATCH");
  await gate.resume("a-1", "lease-2");
  await rejects(gate.pause("a-1", "lease-1"), "ROAM_LEASE_STALE");
});

test("cancel rejects active and queued callers and closes remote once", async () => {
  const { gate, calls } = fixture();
  const never = new Promise(() => {});
  const active = rejects(gate.run("a-1", () => never), "ROAM_CLOSED");
  const queued = rejects(gate.run("a-1", () => assert.fail("queued")), "ROAM_CLOSED");
  const closed = gate.cancel("a-1", "lease-1");
  assert.equal(gate.cancel("a-1", "lease-1"), closed);
  await Promise.all([active, queued, closed]);
  assert.deepEqual(calls, [["close", "a-1"]]);
  await rejects(gate.run("a-1", () => 1), "ROAM_CLOSED");
});

test("cancel mid-drain settles pause without waiting for active fn and emits no late approval", async () => {
  const { gate, calls, events } = fixture();
  const hold = deferred();
  const active = rejects(gate.run("a-1", () => hold.promise), "ROAM_CLOSED");
  const paused = gate.handle(line("pause"));
  await gate.cancel("a-1", "lease-1");
  await Promise.all([active, paused]);
  assert.equal(events[0].ok, false);
  assert.equal(events[0].state, "closed");
  hold.resolve();
  await tick();
  assert.deepEqual(calls, [["close", "a-1"]]);
  assert.equal(events.length, 1);
});

test("cancel failure remains closed and rejects duplicates with fixed error", async () => {
  const { gate } = fixture({ remote: { pause() {}, resume() {}, close() { throw new Error("secret"); } } });
  await rejects(gate.cancel("a-1", "lease-1"), "ROAM_CANCEL_FAILED");
  await rejects(gate.cancel("a-1", "lease-1"), "ROAM_CANCEL_FAILED");
  await rejects(gate.run("a-1", () => 1), "ROAM_CLOSED");
});

test("dispose mid-drain settles all waiters without running remote pause or replaying work", async () => {
  const { gate, calls, events } = fixture();
  const hold = deferred();
  const active = rejects(gate.run("a-1", () => hold.promise), "ROAM_DISPOSED");
  const queued = rejects(gate.run("a-1", () => assert.fail("queued work")), "ROAM_PAUSED");
  const paused = gate.handle(line("pause"));
  gate.dispose();
  gate.dispose();
  await Promise.all([active, queued, paused]);
  assert.equal(events[0].error, "ROAM_DISPOSED");
  hold.resolve();
  await tick();
  assert.deepEqual(calls, []);
  for (const op of ["pause", "resume", "cancel"]) await rejects(gate[op]("a-1", "lease-1"), "ROAM_DISPOSED");
  await rejects(gate.run("a-1", () => 1), "ROAM_DISPOSED");
});

test("dispose settles remote waiters; late pause and resume completions cannot approve", async () => {
  for (const op of ["pause", "resume", "cancel"]) {
    const remoteWait = deferred();
    const { gate, events } = fixture({ remote: { pause() {}, resume() {}, close() {}, [op === "cancel" ? "close" : op]: () => remoteWait.promise } });
    if (op === "resume") await gate.pause("a-1", "lease-1");
    const handling = gate.handle(line(op));
    await tick();
    gate.dispose();
    await handling;
    assert.equal(events[0].ok, false);
    assert.equal(events[0].error, "ROAM_DISPOSED");
    remoteWait.resolve();
    await tick();
    assert.equal(events.length, 1);
    await rejects(gate.run("a-1", () => assert.fail("late completion reopened disposed gate")), "ROAM_DISPOSED");
  }
});

test("a caller timeout never unlatches pause or authorizes takeover", async () => {
  const hold = deferred();
  const { gate, events } = fixture();
  const active = gate.run("a-1", () => hold.promise);
  const handling = gate.handle(line("pause"));
  // Model an app timeout without any timer-dependent test ordering.
  assert.equal(await Promise.race([handling.then(() => "ack"), Promise.resolve("timeout")]), "timeout");
  await rejects(gate.run("a-1", () => assert.fail("timeout unlocked")), "ROAM_PAUSED");
  assert.deepEqual(events, []);
  hold.resolve();
  await Promise.all([active, handling]);
  assert.equal(events[0].state, "paused");
});

test("wrong epochs, unknown agents, coordinator, and conflicting IDs cannot cause remote actions", async () => {
  const { gate, events, calls } = fixture();
  for (const extra of [{ epoch: "worker-1" }, { agent: "a-999" }, { agent: "coordinator" }]) {
    await gate.handle(line("pause", extra));
  }
  assert.deepEqual(events.map((ack) => ack.error), ["ROAM_EPOCH", "ROAM_AGENT", "ROAM_REQUEST"]);
  assert.deepEqual(calls, []);
  await gate.handle(line("pause"));
  await gate.handle(line("resume", { id: "pause-1" }));
  assert.equal(events.at(-1).error, "ROAM_ID_REUSED");
  assert.deepEqual(calls, [["pause", "a-1"]]);
});

test("worker restart rejects old epoch and cannot resume an old lease even with a fresh epoch", async () => {
  const first = fixture();
  await first.gate.pause("a-1", "lease-1");
  first.gate.dispose();
  const { gate, calls, events } = fixture({ epoch: "worker-3" });
  await gate.handle(line("resume"));
  await gate.handle(line("resume", { id: "fresh-request", epoch: "worker-3" }));
  assert.deepEqual(events.map((ack) => ack.error), ["ROAM_EPOCH", "ROAM_LEASE_MISMATCH"]);
  assert.deepEqual(calls, []);
});

test("all direct APIs recheck trusted membership, including revocation and thrown predicates", async () => {
  let trusted = true;
  const { gate } = fixture({ isAgent: () => trusted });
  await gate.run("a-1", () => 1);
  trusted = false;
  for (const op of ["pause", "resume", "cancel"]) await rejects(gate[op]("a-1", "lease-1"), "ROAM_AGENT");
  await rejects(gate.run("a-1", () => 2), "ROAM_AGENT");
  const denied = fixture({ isAgent() { throw new Error("secret"); } });
  await rejects(denied.gate.run("a-1", () => 2), "ROAM_AGENT");
  const closedByDefault = fixture({ isAgent: undefined });
  await rejects(closedByDefault.gate.pause("a-1", "lease-1"), "ROAM_AGENT");
});

test("malformed tagged lines are consumed, unrelated input and stale ack are not commands", async () => {
  const { gate, calls, events } = fixture();
  for (const value of ["invalid json", "{}", { text: "steer" }, { ev: "roam-control", id: "old", ok: true, state: "paused" }]) assert.equal(await gate.handle(value), false);
  for (const value of [{ roamControl: null }, { roamControl: {} }, { roamControl: { id: "bad\nsecret" } }]) assert.equal(await gate.handle(value), true);
  assert.deepEqual(events, []);
  await gate.handle(line("pause", { lease: "secret\nunsafe" }));
  assert.equal(events[0].error, "ROAM_REQUEST");
  assert.equal(events[0].lease, null);
  assert.deepEqual(calls, []);
});

test("status reports pending and closed state without unlocking", async () => {
  const { gate, events } = fixture();
  const active = deferred();
  const run = rejects(gate.run("a-1", () => active.promise), "ROAM_CLOSED");
  const pause = rejects(gate.pause("a-1", "lease-1"), "ROAM_CLOSED");
  await gate.handle(line("status"));
  assert.equal(events[0].state, "pausing");
  await gate.cancel("a-1", "lease-1");
  await gate.handle(line("status", { id: "status-2" }));
  assert.equal(events[1].state, "closed");
  await Promise.all([run, pause]);
  active.resolve();
});

test("cancel during a remote operation rejects its ack; late rejection cannot reopen or leak", async () => {
  for (const op of ["pause", "resume"]) {
    const hold = deferred(), calls = [];
    const { gate, events } = fixture({ remote: {
      pause() {}, resume() {}, [op]: () => hold.promise,
      close() { calls.push("closed"); },
    } });
    if (op === "resume") await gate.pause("a-1", "lease-1");
    const handling = gate.handle(line(op));
    await tick();
    await gate.cancel("a-1", "lease-1");
    await handling;
    assert.equal(events[0].ok, false);
    assert.equal(events[0].error, "ROAM_CLOSED");
    hold.reject(new Error("private remote failure"));
    await tick();
    assert.equal(events.length, 1);
    assert.deepEqual(calls, ["closed"]);
    await rejects(gate.run("a-1", () => 1), "ROAM_CLOSED");
  }
});

test("queued actions reject when trusted membership is false or throws at dispatch", async () => {
  for (const revoked of [() => false, () => { throw new Error("private board failure"); }]) {
    let trusted = () => true;
    const { gate } = fixture({ isAgent: (agent) => agent === "a-2" || trusted() });
    const hold = deferred();
    const active = gate.run("a-1", () => hold.promise);
    const queued = [1, 2].map(() => rejects(
      gate.run("a-1", () => assert.fail("revoked queued action ran")), "ROAM_AGENT",
    ));
    trusted = revoked;
    hold.resolve("active result");
    assert.equal(await active, "active result");
    await Promise.all(queued);
    assert.equal(await gate.run("a-2", () => "unaffected"), "unaffected");
    trusted = () => true;
    assert.equal(await gate.run("a-1", () => "restored"), "restored");
  }
});

test("late pause and resume success after cancel cannot reopen the closed latch", async () => {
  for (const op of ["pause", "resume"]) {
    const hold = deferred();
    const { gate, events } = fixture({ remote: { pause() {}, resume() {}, close() {}, [op]: () => hold.promise } });
    if (op === "resume") await gate.pause("a-1", "lease-1");
    const handling = gate.handle(line(op));
    await tick();
    await gate.cancel("a-1", "lease-1");
    await handling;
    assert.equal(events[0].ok, false);
    assert.equal(events[0].error, "ROAM_CLOSED");
    hold.resolve();
    await tick();
    assert.equal(events.length, 1);
    await rejects(gate.run("a-1", () => assert.fail("late completion reopened canceled gate")), "ROAM_CLOSED");
    await gate.handle(line("status"));
    assert.equal(events[1].state, "closed");
  }
});
