// Engine-local proof state that pi-durable does not own. A committed tool result
// must never reopen with its matching proof or attempt counter forgotten.
//   candidates  unproven, agent-asserted results (lib/candidate.mjs). Saved,
//               so a resumed run keeps its cap, numbering and duplicate guards.
//   attempts    attempt id -> what it captured, for submit_candidate. Memory
//               only: after a restart the agent runs an attempt again to cite it.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { candidateState, watchFindings } from "./candidate.mjs";

export function auditState(file) {
  const saved = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  let poc = saved.poc ?? 0;
  const found = saved.found ?? [];
  const passed = new Map(saved.passed ?? []);
  let candidates = [];
  const validSequence = (agent, n) => typeof agent === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(agent) && Number.isSafeInteger(n) && n >= 0;
  if (saved.sessionSequence !== undefined && (!Array.isArray(saved.sessionSequence) || saved.sessionSequence.some((row) => !Array.isArray(row) || row.length !== 2 || !validSequence(...row)))) throw new Error("invalid saved session sequence");
  const sessionSequence = new Map(saved.sessionSequence ?? []);
  if (sessionSequence.size !== (saved.sessionSequence ?? []).length) throw new Error("invalid saved session sequence");
  // Older audit files kept candidates but no action counters. Never reuse a
  // persisted candidate's session id after upgrading or resuming that file.
  for (const c of saved.candidates ?? []) {
    const match = /^session:([A-Za-z0-9][A-Za-z0-9_-]{0,63}):([1-9][0-9]*)$/.exec(c.poc ?? "");
    if (!match) continue;
    const n = Number(match[2]);
    if (!validSequence(match[1], n)) throw new Error("invalid saved session sequence");
    sessionSequence.set(match[1], Math.max(n, sessionSequence.get(match[1]) ?? 0));
  }
  const persist = () => {
    if (!file) return;
    const next = `${file}.tmp`;
    writeFileSync(next, JSON.stringify({ poc, found, passed: [...passed], candidates, sessionSequence: [...sessionSequence] }), { mode: 0o600 });
    renameSync(next, file);
  };
  const sequenceSet = sessionSequence.set.bind(sessionSequence);
  sessionSequence.set = (agent, n) => {
    const before = sessionSequence.get(agent);
    if (!validSequence(agent, n) || n <= (before ?? 0)) throw new Error("invalid session sequence advance");
    sequenceSet(agent, n);
    try { persist(); }
    catch (error) {
      if (before === undefined) sessionSequence.delete(agent);
      else sequenceSet(agent, before);
      throw error;
    }
    return sessionSequence;
  };
  candidates = candidateState(saved.candidates, persist);
  const push = found.push.bind(found);
  found.push = (...items) => { const n = push(...items); persist(); return n; };
  const set = passed.set.bind(passed);
  passed.set = (key, value) => { set(key, value); persist(); return passed; };
  return watchFindings({
    get poc() { return poc; },
    set poc(value) { poc = value; persist(); },
    found,
    passed,
    candidates,
    attempts: new Map(),
    sessionSequence,
    session: new Map(),
    sessionArtifacts: new Map(),
  });
}
