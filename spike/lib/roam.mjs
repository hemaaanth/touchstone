import { roamError } from "./roam-errors.mjs";
// The tools of a free-roam child (Wave 4, I1). Today there is one: `shell`.
//
// `shell` runs a command as root on the child's own Daytona machine
// (daytona.mjs roamMachine). It never runs on this computer.
//
// This file knows nothing about the session record or the egress log. The
// caller passes both in:
//   record(entry) -> { poc, output }   stores one session entry; `output` is
//                                      the scrubbed text of a shell entry
//   egress = { env, start(machine), pull(machine) }
//                                      env    shell text that sets the proxy variables
//                                      start  starts the request log on a new machine
//                                      pull   -> the new log records
// Only the fleet installs these tools, and only a free-roam child may call
// them (fleet.mjs). The agent comes from the fleet's tag (event.mjs).
//
// Only the fixed supervisor script and JSON request bytes go to the machine.
// This file does not read or forward the host environment.
import { defineTool } from "@earendil-works/pi-durable";
import { int, obj, opt, str } from "@earendil-works/pi-schema";
import { roamMachine } from "./daytona.mjs";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { currentAgent } from "./event.mjs";

const DEFAULT_S = 120;
const MAX_S = 900;
export const REPLACED_NOTICE = "The machine was replaced. Files from before are gone.";
const PULL_NOTICE = "The request log could not be read after this command. It is read again on the next call.";

const text = (value) => ({ output: [{ type: "text", text: value }] });

const CONTROL = "/tmp/touchstone-shell-control.mjs";
const controllers = new Map(); // shared by tools and the remote takeover adapter, keyed by machine id
const CONTROL_ERROR = "Managed shell control is unavailable. Keep human input disabled.";
function controller(m) {
  if (!controllers.has(m.id)) controllers.set(m.id, { mode: "active", epoch: 0, local: 0, last: Promise.resolve() });
  return controllers.get(m.id);
}
async function bounded(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(CONTROL_ERROR)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function exchange(m, s, op, fields = {}) {
  const id = randomUUID();
  const local = s.local;
  await bounded(m.upload(`/tmp/touchstone-shell-${id}.json`, Buffer.from(JSON.stringify({ id, op, generation: s.generation, epoch: s.epoch, ...fields }))), 30_000);
  if (op === "run" && (s.mode !== "active" || s.local !== local || s.pending)) {
    throw Object.assign(new Error(CONTROL_ERROR), { notLaunched: true });
  }
  const seconds = op === "run" ? fields.seconds + 5 : 10;
  const r = await bounded(m.exec(`node ${CONTROL} ${id}`, seconds), (seconds + 5) * 1000);
  if (r?.exitCode !== 0) throw new Error(CONTROL_ERROR);
  // The reply is the supervisor's JSON. A reply with no result at all used to
  // reach JSON.parse as undefined, and the run settled with the bare sentence
  // `"undefined" is not valid JSON` — no op, no exit code, nothing to act on.
  // Name the exchange instead; the caller's message already says the run stops.
  const raw = typeof r?.result === "string" ? r.result : "";
  let a;
  try { a = JSON.parse(raw); } catch {
    throw new Error(`${CONTROL_ERROR}: the ${op} reply held no JSON (exit ${r?.exitCode}, ${raw.length} chars)`);
  }
  if (a?.ok !== true || a.id !== id || typeof a.generation !== "string" || !Number.isSafeInteger(a.epoch) || a.epoch < 0 ||
      (s.generation && a.generation !== s.generation)) throw new Error(CONTROL_ERROR);
  return a;
}
function ready(m, s) {
  return s.ready ??= (async () => {
    await bounded(m.upload(CONTROL, readFileSync(new URL("../roam/shell-control.mjs", import.meta.url))), 30_000);
    const a = await exchange(m, s, "init", { fresh: m.fresh === true });
    if (a.ack !== true || a.scope !== "managed-shell" || a.state !== "active") throw new Error(CONTROL_ERROR);
    s.generation = a.generation; s.epoch = a.epoch;
  })();
}
async function unknown(m, s, recoverable = false) {
  s.recoverable = recoverable;
  s.mode = "unknown"; s.local++;
  // Best effort remote latch. No later success may clear this worker's unknown state.
  try { if (s.generation) await exchange(m, s, "block"); } catch { /* already failed closed */ }
}
function control(m, op, target) {
  const s = controller(m);
  if (s.mode === "unknown" || (s.mode === "closed" && op !== "close")) return Promise.reject(new Error(CONTROL_ERROR));
  // Latch before the first await. An upload already in flight cannot bypass it.
  if (op !== "resume") { s.mode = target; s.local++; }
  s.pending = (s.pending || 0) + 1;
  const run = async () => {
    try {
      if (s.mode === "unknown") throw new Error(CONTROL_ERROR);
      await ready(m, s);
      const a = await exchange(m, s, op);
      if (s.mode === "unknown" || a.ack !== true || a.scope !== "managed-shell" || a.state !== target || a.epoch < s.epoch) throw new Error(CONTROL_ERROR);
      s.epoch = a.epoch; s.mode = target;
      return { ack: true, state: target, scope: "managed-shell" };
    } catch { await unknown(m, s); throw new Error(CONTROL_ERROR); }
    finally { s.pending--; }
  };
  const result = s.last.then(run, run);
  s.last = result.catch(() => {});
  return result;
}
// These acknowledgements cover cooperative managed groups, not machine isolation.
// The app must also pause browser automation before enabling human input.
export const pauseRoamShell = (machine) => control(machine, "pause", "paused");
export const resumeRoamShell = (machine) => control(machine, "resume", "active");
export const closeRoamShell = (machine) => control(machine, "close", "closed");

async function recover(m, s) {
  const local = s.local;
  try {
    // Re-init is safe if setup failed before a generation was acknowledged.
    // An existing unknown supervisor will refuse it rather than reset its jobs.
    if (!s.generation) { s.ready = null; await ready(m, s); }
    else {
      let recovered = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const status = await exchange(m, s, "status");
        if (status.ack !== true || status.scope !== "managed-shell" || !["active", "unknown"].includes(status.state) || status.epoch < s.epoch) throw new Error(CONTROL_ERROR);
        s.epoch = status.epoch;
        try {
          const a = await exchange(m, s, "recover");
          if (a.ack !== true || a.scope !== "managed-shell" || a.state !== "active" || a.epoch <= s.epoch) throw new Error(CONTROL_ERROR);
          s.epoch = a.epoch;
          recovered = true;
          break;
        } catch { /* A terminating worker can advance the epoch; read it again. */ }
      }
      if (!recovered) throw new Error(CONTROL_ERROR);
    }
    if (s.local !== local || s.pending || s.mode !== "unknown") throw new Error(CONTROL_ERROR);
    s.mode = "active";
  } catch { throw roamError("ROAM_SHELL_RECOVERY_FAILED"); }
}

async function supervisedShell(m, command, seconds) {
  const s = controller(m);
  const recovering = s.mode === "unknown" && s.recoverable && !s.pending;
  if (recovering) await recover(m, s);
  const local = s.local;
  if (s.mode !== "active" || s.pending) throw new Error(CONTROL_ERROR);
  try {
    await ready(m, s);
    if (s.mode !== "active" || s.local !== local || s.pending) throw Object.assign(new Error(CONTROL_ERROR), { notLaunched: true });
    const a = await exchange(m, s, "run", { command, seconds });
    if (!Number.isInteger(a.exitCode) || typeof a.result !== "string") throw new Error(CONTROL_ERROR);
    return { exitCode: a.exitCode, result: a.result, recovered: recovering };
  } catch (e) { if (!e.notLaunched) await unknown(m, s, true); throw e; }
}

// Setup exercises the same supervisor used by real children, including its
// pause/resume/close acknowledgements. It never runs an owner-supplied command.
export async function probeManagedShell(machine) {
  const result = await supervisedShell(machine, "printf touchstone-shell-ready", 5);
  if (result.exitCode !== 0 || result.result !== "touchstone-shell-ready") throw new Error(CONTROL_ERROR);
  await pauseRoamShell(machine);
  await resumeRoamShell(machine);
  await closeRoamShell(machine);
}

export function roamTools(ws, { record, egress, machine = roamMachine }) {
  const turn = new Map(); // agent -> the end of its last shell call
  const logged = new Set(); // ids of machines whose request log this worker started
  const owed = new Set(); // agents that have not seen the replaced notice yet

  async function run(agent, command, seconds) {
    let m;
    try { m = await machine(ws, agent); } catch { throw roamError("ROAM_MACHINE_UNAVAILABLE"); }
    if (m.replaced) owed.add(agent);
    // No log, no shell. A machine this worker did not start the log on gets it
    // first: a new one, one from the sidecar, one whose last start or pull failed.
    if (!logged.has(m.id)) {
      try {
        await egress.start(m);
      } catch {
        throw roamError("ROAM_EGRESS_UNAVAILABLE");
      }
      logged.add(m.id);
    }
    let r;
    try {
      r = await supervisedShell(m, egress.env + command, seconds);
      if (r.exitCode === undefined) throw new Error();
    } catch (e) {
      // The command may have run, so it gets its entry. The error is a fixed
      // text: what the machine answered is not scrubbed, and the model reads it.
      record({ agent, kind: "shell", t: Date.now(), sandbox: m.id, command, exit_code: undefined, output: "" });
      if (e?.code === "ROAM_SHELL_RECOVERY_FAILED") throw e;
      throw roamError("ROAM_SHELL_OUTCOME_UNKNOWN");
    }
    const s = record({ agent, kind: "shell", t: Date.now(), sandbox: m.id, command, exit_code: r.exitCode, output: r.result });
    let recs = [];
    let note = "";
    try {
      recs = await egress.pull(m);
    } catch {
      // The command ran and is recorded, so the model still gets its result.
      // The next call starts (and so checks) the log before it runs anything.
      logged.delete(m.id);
      note = `\n${PULL_NOTICE}`;
    }
    for (const rec of recs) {
      record({ agent, kind: "egress", t: rec.t, method: rec.method, url: rec.url, status: rec.status });
    }
    // The model gets the text that record() returned, never the raw output.
    return `${r.recovered ? "Shell recovered on the same machine. Previous managed processes stopped; the earlier command was not replayed.\n" : ""}${owed.delete(agent) ? `${REPLACED_NOTICE}\n` : ""}session ${s.poc}\nexit ${r.exitCode ?? "unknown"}\n${s.output}${note}`;
  }

  const shell = defineTool({
    name: "shell",
    description: `Run one shell command as root on your own remote Linux machine. The machine is yours for the whole run: files and installed packages stay between calls. It has open network access, and requests that use the proxy variables are logged. The result holds a line that starts with "session"; give the id on that line to submit_session_candidate. Output is cut to its last part. Default time limit ${DEFAULT_S} s, at most ${MAX_S} s.`,
    parameters: obj({
      command: str({ description: "the command, run with sh -c" }),
      timeout_s: opt(int({ description: `time limit in seconds, default ${DEFAULT_S}, at most ${MAX_S}` })),
    }),
    replay: "unsafe",
    execute: async ({ command, timeout_s }) => {
      const agent = currentAgent();
      if (!agent) throw new Error("shell is only for a free-roam child agent. This call has no agent.");
      const seconds = Math.min(MAX_S, Math.max(1, Math.floor(Number(timeout_s) || DEFAULT_S)));
      // One shell call at a time per child. So the log is up before the first
      // command runs, and the session ids follow the order of the results.
      const mine = (turn.get(agent) ?? Promise.resolve()).then(() => run(agent, String(command), seconds));
      turn.set(agent, mine.catch(() => {}));
      return text(await mine);
    },
  });

  return [shell];
}
