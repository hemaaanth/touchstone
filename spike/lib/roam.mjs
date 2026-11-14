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
// Nothing from this host goes to the machine: one command string, and no
// environment. This file does not read the host environment at all.
import { defineTool } from "@earendil-works/pi-durable";
import { int, obj, opt, str } from "@earendil-works/pi-schema";
import { roamMachine, shq } from "./daytona.mjs";
import { currentAgent } from "./event.mjs";

const DEFAULT_S = 120;
const MAX_S = 900;
export const REPLACED_NOTICE = "The machine was replaced. Files from before are gone.";
const PULL_NOTICE = "The request log could not be read after this command. It is read again on the next call.";

const text = (value) => ({ output: [{ type: "text", text: value }] });

export function roamTools(ws, { record, egress, machine = roamMachine }) {
  const turn = new Map(); // agent -> the end of its last shell call
  const logged = new Set(); // ids of machines whose request log this worker started
  const owed = new Set(); // agents that have not seen the replaced notice yet

  async function run(agent, command, seconds) {
    const m = await machine(ws, agent);
    if (m.replaced) owed.add(agent);
    // No log, no shell. A machine this worker did not start the log on gets it
    // first: a new one, one from the sidecar, one whose last start or pull failed.
    if (!logged.has(m.id)) {
      try {
        await egress.start(m);
      } catch {
        throw new Error("The request log did not start. No log, no shell.");
      }
      logged.add(m.id);
    }
    let r;
    try {
      r = await m.exec(`sh -c ${shq(egress.env + command)}`, seconds);
      if (r.exitCode === undefined) throw new Error();
    } catch (e) {
      // The command may have run, so it gets its entry. The error is a fixed
      // text: what the machine answered is not scrubbed, and the model reads it.
      record({ agent, kind: "shell", t: Date.now(), sandbox: m.id, command, exit_code: undefined, output: "" });
      throw new Error(`The command did not finish on the machine (HTTP ${Number.isInteger(e?.status) ? e.status : "no answer"}). It may still be running.`);
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
    return `${owed.delete(agent) ? `${REPLACED_NOTICE}\n` : ""}session ${s.poc}\nexit ${r.exitCode ?? "unknown"}\n${s.output}${note}`;
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
