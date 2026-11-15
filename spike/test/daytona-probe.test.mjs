import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeDaytonaShell } from "../lib/daytona-probe.mjs";

function fakeMachine(failure) {
  const requests = new Map(), operations = [], uploads = [];
  let epoch = 0;
  const machine = {
    id: randomUUID(), fresh: true,
    async upload(path, bytes) {
      uploads.push(path);
      if (path.endsWith(".json")) {
        const q = JSON.parse(bytes.toString());
        requests.set(q.id, q);
      }
    },
    async exec(command) {
      // The toolbelt stage runs before any supervisor exchange, so it needs its
      // own answer; without one the command fell through to the supervisor map.
      if (command.includes("for x in nmap tshark exiftool gdb readelf")) return { exitCode: failure === "toolbelt" ? 81 : 0, result: "" };
      if (command.includes("touchstone-prerequisites-ready")) return { exitCode: Number.isInteger(failure) ? failure : failure === "prerequisites" ? 1 : 0, result: "touchstone-prerequisites-ready" + (failure === "framing" ? "\r\n" : "") };
      if (command.includes("nohup node")) return { exitCode: failure === "logger" ? 1 : 0, result: "" };
      if (command.includes("touchstone-egress-ready")) return { exitCode: 0, result: "touchstone-egress-ready" + (failure === "framing" ? "\r\n" : "") };
      if (command.includes("tail -c")) return { exitCode: 0, result: Buffer.from(JSON.stringify({ t: 1, host: "127.0.0.1", method: "GET", url: "http://127.0.0.1:12345/touchstone-probe", status: failure === "egress" ? 502 : 200, decision: "allow", reason: "free-roam" }) + "\n").toString("base64") };
      const q = requests.get(command.split(" ").at(-1));
      assert.ok(q, "only the trusted supervisor exchange may execute");
      operations.push(q.op);
      if (["pause", "resume", "close", "block"].includes(q.op)) epoch++;
      const answer = { ok: true, id: q.id, generation: "synthetic-generation", epoch, ack: !(failure === "ack" && q.op === "pause"), scope: "managed-shell", state: q.op === "pause" ? "paused" : q.op === "close" ? "closed" : "active" };
      if (q.op === "run") Object.assign(answer, { exitCode: 0, result: "touchstone-shell-ready" });
      return { exitCode: 0, result: JSON.stringify(answer) };
    },
  };
  return { machine, operations, uploads };
}

test("the shell probe exercises the actual supervisor protocol and only loopback HTTP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shell-probe-test-"));
  const previous = process.env.EVENTS_FILE;
  process.env.EVENTS_FILE = join(dir, "events");
  try {
    const fake = fakeMachine();
    await probeDaytonaShell(fake.machine);
    assert.deepEqual(fake.operations, ["init", "run", "pause", "resume", "close"]);
    assert.ok(fake.uploads.includes("/tmp/touchstone-shell-control.mjs"));
    assert.ok(fake.uploads.some((p) => p.includes("egress")));
  } finally {
    previous == null ? delete process.env.EVENTS_FILE : process.env.EVENTS_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const stage of ["prerequisites", "toolbelt", "logger", "egress", "ack"]) test(`failed ${stage} cannot become shell readiness`, async () => {
  const fake = fakeMachine(stage);
  await assert.rejects(probeDaytonaShell(fake.machine), (e) => e.code === ({ prerequisites: "daytona_shell_prerequisites_failed", toolbelt: "daytona_shell_toolbelt_missing", logger: "daytona_shell_egress_start_failed", egress: "daytona_shell_egress_record_failed", ack: "daytona_shell_supervisor_failed" })[stage] && e.cause === undefined);
});

test("provider line framing does not turn successful fixed markers into a capability failure", async () => {
  await probeDaytonaShell(fakeMachine("framing").machine);
});
for (const [status, code] of [[71,"commands_missing"],[72,"http_client_missing"],[73,"package_manager_missing"],[74,"node_required"],[75,"linux_required"],[76,"root_required"],[77,"tls_missing"],[78,"proc_unavailable"],[79,"tmp_unwritable"],[80,"log_unwritable"]]) test(`prerequisite status ${status} becomes a fixed ${code} diagnostic`, async () => {
  await assert.rejects(probeDaytonaShell(fakeMachine(status).machine), (e) => e.code === `daytona_shell_${code}` && e.cause === undefined);
});
