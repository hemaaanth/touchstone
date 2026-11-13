// The engine worker must not exit before the server has its last event.
//
//   node --test spike/test/event-exit.test.mjs
//
// The fault: the worker printed a long `settled` event and called
// process.exit(). Its stdout is a pipe, and a write to a pipe is asynchronous,
// so the exit cut the line. The server never saw the run end and showed "The
// run stopped unexpectedly". These tests start a real child process, as the
// server does, and count the bytes that arrive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const EVENT_LIB = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "event.mjs")).href;
const BYTES = 4 * 1024 * 1024; // far more than a pipe buffer holds

function worker(ending) {
  const code = `
    import { event, exitAfterEvents } from ${JSON.stringify(EVENT_LIB)};
    event("settled", { status: "done", summary: { calls: "x".repeat(${BYTES}) } });
    ${ending}
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (exit) => resolve({ exit, out }));
  });
}

test("exitAfterEvents delivers a long settled event whole, then exits with the code", async () => {
  for (let i = 0; i < 3; i++) {
    const { exit, out } = await worker("exitAfterEvents(0);");
    assert.equal(exit, 0);
    assert.ok(out.endsWith("\n"), "the line arrives with its newline");
    const e = JSON.parse(out.slice("EVENT ".length));
    assert.equal(e.ev, "settled");
    assert.equal(e.summary.calls.length, BYTES);
  }
  assert.equal((await worker("exitAfterEvents(3);")).exit, 3);
});

test("the old ending, process.exit() right after the event, cuts the line (the fault)", async () => {
  const { out } = await worker("process.exit(0);");
  assert.ok(out.length < BYTES, `only ${out.length} of ${BYTES} bytes arrived`);
  assert.ok(!out.endsWith("\n"), "the server cannot parse a line with no end");
});
