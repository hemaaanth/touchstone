// The compaction status of the cognition watch: a summarization task writes no
// message, so the stream must carry its life on its own. Fake harness, no
// Docker, no model.
//
//   node --experimental-test-module-mocks --test test/cognition-compaction.test.mjs
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { watchCognition } from "../lib/cognition.mjs";

// Watch one conversation whose LiveDoc walks `values`; return the events the
// watch printed and the feed step that pushes the next value.
function run(t, values, args = {}, conversationId = "root") {
  const seen = [];
  t.mock.method(console, "log", (line) => {
    if (String(line).startsWith("EVENT ")) seen.push(JSON.parse(String(line).slice(6)));
  });
  let push;
  const handle = { value: values[0], start(fn) { push = fn; } };
  const harness = { watchDoc: async () => handle };
  return watchCognition(harness, conversationId, args, {}).then(() => ({
    seen,
    feed: () => values.slice(1).forEach((value) => push({ kind: "value", value })),
    compaction: () => seen.filter((e) => e.ev === "compaction").map(({ t, ...e }) => e),
  }));
}

test("a blocking compaction reports once, its retry once, and one done when it lands", async (t) => {
  const compaction = { taskId: 1, trigger: "threshold", blocking: true, attempt: 1 };
  const { feed, compaction: got } = await run(t, [
    { compactions: [compaction] },
    { compactions: [{ ...compaction, attempt: 2, retry: { at: 7, error: "gateway" } }] },
    { compactions: [] },
  ]);
  feed();
  assert.deepEqual(got(), [
    { ev: "compaction", conv: "root", active: true, blocking: true, trigger: "threshold", attempt: 1 },
    { ev: "compaction", conv: "root", active: true, blocking: true, trigger: "threshold", attempt: 2, retryAt: 7 },
    { ev: "compaction", conv: "root", active: false, done: true },
  ]);
})

test("a failed compaction clears without the done note, and names the child agent", async (t) => {
  const on = { compactions: [{ taskId: 2, trigger: "overflow", blocking: true, attempt: 1 }] };
  const { feed, compaction: got } = await run(t, [
    on,
    { compactions: [], compactionFailure: { taskId: 2, trigger: "overflow", error: "boom" } },
  ], { agent: "a-1" }, "conv-1");
  feed();
  assert.deepEqual(got(), [
    { ev: "compaction", conv: "conv-1", agent: "a-1", active: true, blocking: true, trigger: "overflow", attempt: 1 },
    { ev: "compaction", conv: "conv-1", agent: "a-1", active: false },
  ])
})

test("a background tidy-up clears without a note and does not repeat an unchanged status", async (t) => {
  const on = { compactions: [{ taskId: 3, trigger: "threshold", blocking: false, attempt: 1 }] };
  const { feed, compaction: got } = await run(t, [on, on, { compactions: [] }]);
  feed()
  assert.deepEqual(got(), [
    { ev: "compaction", conv: "root", active: true, blocking: false, trigger: "threshold", attempt: 1 },
    { ev: "compaction", conv: "root", active: false },
  ])
})
