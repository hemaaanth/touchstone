// The host side of the egress log of a free-roam machine (I2).
//
// The proxy itself is roam/egress-log.mjs. It runs on the machine. This file
// uploads it, starts it, and pulls its new log lines after a tool call.
//
// What the log is, in plain words:
//   - Every request that uses the proxy variables is logged. A command that
//     does not use them (a raw socket, `curl --noproxy`, ssh, DNS) is not
//     listed. The records are "requests seen by the log".
//   - The host keeps what it pulled after each call. Before the pull, the
//     child can add or remove lines. The log is the child's own report of its
//     traffic, checked for shape only.
//
// `machine` is { id, exec(command, seconds) -> { exitCode, result }, upload(path, bytes) }
// (roamMachine in lib/daytona.mjs). The machine is untrusted input: a pull
// reads at most 256 KB, and a line that does not have the fixed shape is dropped.
import { METHODS } from "node:http";
import { readFileSync } from "node:fs";
import { event } from "./event.mjs";

const PORT = 8899;
const PROXY = `http://127.0.0.1:${PORT}`;
const SCRIPT = "/tmp/touchstone-egress-log.mjs";
const LOG = "/var/log/touchstone/egress.jsonl";
const MAX_PULL = 262144; // 256 KB of the log file per pull
const MAX_HOSTS = 20; // host names in one `egress-log` event

// The prefix of every `shell` command (lib/roam.mjs puts it there).
export const EGRESS_ENV = `export HTTP_PROXY=${PROXY} HTTPS_PROXY=${PROXY} http_proxy=${PROXY} https_proxy=${PROXY}; `;

// Quote one word for /bin/sh. The same rule as shq in lib/daytona.mjs; this
// file imports nothing from that lane.
const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

// `exec` does not run a shell by itself, so each command is one `sh -c '…'`.
const PORT_ANSWERS = `node -e ${shq(`require("net").connect(${PORT},"127.0.0.1").on("connect",()=>process.exit(0)).on("error",()=>process.exit(1))`)}`;
// Without the redirect, the call can wait for the proxy process to end.
const START = `sh -c ${shq(`(nohup node ${SCRIPT} ${PORT} ${LOG} >/dev/null 2>&1 &); for i in $(seq 1 20); do ${PORT_ANSWERS} && exit 0; sleep 1; done; exit 1`)}`;
// base64 keeps the bytes exact, so the read offset stays a byte offset
// whatever the file holds. `tail -c +N` counts from 1.
const pullCommand = (offset) => `sh -c ${shq(`tail -c +${offset + 1} ${LOG} 2>/dev/null | head -c ${MAX_PULL} | base64`)}`;

// machine id -> { offset, requests, hosts, last }. `hosts` holds at most
// MAX_HOSTS names, so a machine cannot make this grow.
// shortcut: the offset lives in this process, so a new worker reads a
// machine's file from the start again; save it when the session is saved
// (lib/audit-state.mjs does not save a session today).
const logs = new Map();
function logOf(id) {
  if (!logs.has(id)) logs.set(id, { offset: 0, requests: 0, hosts: [], last: Promise.resolve() });
  return logs.get(id);
}

// Upload the proxy, start it in the background, wait until the port answers.
// It throws when the port does not answer (for example Node is missing). The
// caller then refuses the shell: no log, no shell.
export async function startEgressLog(machine) {
  await machine.upload(SCRIPT, readFileSync(new URL("../roam/egress-log.mjs", import.meta.url)));
  const r = await machine.exec(START, 60);
  if (r?.exitCode !== 0) throw new Error(`The egress log did not start on machine ${machine.id} (exit ${r?.exitCode}). No log, no shell.`);
}

const METHOD = new Set(METHODS); // the HTTP methods; CONNECT is one of them

// One line of the machine's file -> one record, or null. Only the checked
// fields are kept. `decision` and `reason` are set here, never read.
function parseLine(line) {
  let v;
  try { v = JSON.parse(line); } catch { return null; }
  if (!v || typeof v !== "object") return null;
  const { t, host, method, url, status } = v;
  if (!Number.isFinite(t)) return null;
  if (typeof host !== "string" || host.length > 253) return null;
  if (typeof url !== "string" || url.length > 2000) return null;
  if (!METHOD.has(method)) return null;
  if (status !== null && !Number.isInteger(status)) return null;
  return { t, host, method, url, decision: "allow", reason: "free-roam", status };
}

async function pull(machine, log) {
  const r = await machine.exec(pullCommand(log.offset), 30);
  // The cut bounds the work here even if the machine answers with more than it was asked for.
  const bytes = Buffer.from(String(r?.result ?? "").slice(0, MAX_PULL * 1.5), "base64").subarray(0, MAX_PULL);
  // Take whole lines only; the rest waits for the next pull. A full pull
  // without a line end is one line that is too long: skip it.
  const end = bytes.lastIndexOf(10) + 1;
  log.offset += end || (bytes.length === MAX_PULL ? MAX_PULL : 0);
  const records = bytes.subarray(0, end).toString("utf8").split("\n").map(parseLine).filter(Boolean);
  if (!records.length) return records;
  log.requests += records.length;
  for (const rec of records) {
    if (log.hosts.length < MAX_HOSTS && !log.hosts.includes(rec.host)) log.hosts.push(rec.host);
  }
  event("egress-log", { requests: log.requests, hosts: log.hosts });
  return records;
}

// The new records since the last pull of this machine, in file order. It sends
// one `egress-log` event when there is a new record: the count so far and the
// first host names. Two pulls of one machine run one after the other, so no
// line is returned twice.
export async function pullEgressLog(machine) {
  const log = logOf(machine.id);
  const run = () => pull(machine, log);
  return (log.last = log.last.then(run, run));
}
