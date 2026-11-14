import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { auditState } from "../lib/audit-state.mjs";
import { recordSession, sessionLookup } from "../lib/candidate.mjs";
import { withAgent } from "../lib/event.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "session-persistence-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "audit.json");
}
const browser = (state, agent = "a-1") => recordSession(state, { agent, kind: "browser", action: "read", output: "private transient cite text", sandbox: "test-machine" });

test("action sequence survives restart; prior cite text and secrets do not", (t) => {
  const file = fixture(t);
  const first = auditState(file);
  first.sessionSecrets = ["fake secret not for disk"];
  assert.equal(browser(first).poc, "session:a-1:1");
  recordSession(first, { agent: "a-1", kind: "ask", id: "q1", ask_kind: "human", answer: "reply", reply: "raw private reply" });
  recordSession(first, { agent: "a-1", kind: "egress", method: "GET", url: "https://example.org/", status: 200 });
  assert.equal(first.sessionSequence.get("a-1"), 2);
  assert.equal(browser(first, "a-11").poc, "session:a-11:1");
  const disk = readFileSync(file, "utf8");
  for (const v of ["private transient", "fake secret", "raw private reply", "example.org"]) assert.ok(!disk.includes(v));
  const next = auditState(file);
  assert.equal(next.sessionSequence.get("a-1"), 2);
  assert.equal(withAgent("a-1", () => sessionLookup(next)("session:a-1:2")), null);
  const moved = browser(next);
  assert.equal(moved.poc, "session:a-1:3");
  assert.equal(withAgent("a-1", () => sessionLookup(next)("session:a-1:2")), null);
  assert.ok(withAgent("a-1", () => sessionLookup(next)(moved.poc)));
  assert.equal(withAgent("a-11", () => sessionLookup(next)(moved.poc)), null);
  assert.equal(auditState(file).sessionSequence.get("a-1"), 3);
});

test("old audit files without counters remain readable", (t) => {
  const file = fixture(t);
  writeFileSync(file, JSON.stringify({ poc: 5, passed: [], found: [], candidates: [] }));
  const state = auditState(file);
  assert.equal(state.poc, 5);
  assert.equal(browser(state).poc, "session:a-1:1");
});

test("legacy candidate ids seed the counter without restoring cite text", (t) => {
  const file = fixture(t);
  writeFileSync(file, JSON.stringify({ candidates: [{ n: 1, poc: "session:a-1:7", title: "Prior candidate" }] }));
  const state = auditState(file);
  assert.equal(state.sessionSequence.get("a-1"), 7);
  assert.equal(withAgent("a-1", () => sessionLookup(state)("session:a-1:7")), null);
  assert.equal(browser(state).poc, "session:a-1:8");
});

test("corrupt counters fail closed instead of reusing an old candidate id", (t) => {
  const file = fixture(t);
  for (const sessionSequence of [{}, [["a-1", 5], ["a-1", 1]], [["a-1", -1]], [["a-1", "4"]], [["../a", 1]], [["a-1", Number.MAX_SAFE_INTEGER + 1]]]) {
    writeFileSync(file, JSON.stringify({ sessionSequence }));
    assert.throws(() => auditState(file), /invalid saved session sequence/);
  }
});

test("failed persistence does not publish an entry or advance its counter", (t) => {
  const file = fixture(t);
  const state = auditState(file);
  browser(state);
  rmSync(file);
  rmSync(dirname(file), { recursive: true });
  assert.throws(() => browser(state));
  assert.equal(state.sessionSequence.get("a-1"), 1);
  assert.equal(state.session.get("a-1").length, 1);
});
