// Engine-local proof state that pi-durable does not own. A committed tool result
// must never reopen with its matching proof or attempt counter forgotten.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export function auditState(file) {
  const saved = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  let poc = saved.poc ?? 0;
  const found = saved.found ?? [];
  const passed = new Map(saved.passed ?? []);
  const persist = () => {
    if (!file) return;
    const next = `${file}.tmp`;
    writeFileSync(next, JSON.stringify({ poc, found, passed: [...passed] }), { mode: 0o600 });
    renameSync(next, file);
  };
  const push = found.push.bind(found);
  found.push = (...items) => { const n = push(...items); persist(); return n; };
  const set = passed.set.bind(passed);
  passed.set = (key, value) => { set(key, value); persist(); return passed; };
  return {
    get poc() { return poc; },
    set poc(value) { poc = value; persist(); },
    found,
    passed,
  };
}
