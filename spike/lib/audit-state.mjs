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
  const persist = () => {
    if (!file) return;
    const next = `${file}.tmp`;
    writeFileSync(next, JSON.stringify({ poc, found, passed: [...passed], candidates }), { mode: 0o600 });
    renameSync(next, file);
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
  });
}
