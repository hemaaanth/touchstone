// Confined-machine cleanup records. Old bare IDs have no account identity;
// preserve them for operator repair, never delete them with today's key.
import { loadStore, saveStore, withStoreLock } from "./grant-store.mjs";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const HASH = /^[a-f0-9]{64}$/;
export const pendingFile = () => process.env.DAYTONA_PENDING || new URL("../data/daytona-pending.json", import.meta.url).pathname;
const fail = () => { throw new Error("Daytona pending cleanup state is invalid. Nothing was removed."); };
export function pendingMachines() {
  const rows = loadStore(pendingFile(), "Daytona pending cleanup");
  for (const row of rows) {
    if (typeof row === "string" ? !ID.test(row) : !row || !ID.test(row.id) || !HASH.test(row.account)) fail();
  }
  return rows;
}
function change(fn) {
  const file = pendingFile();
  return withStoreLock(file, "Daytona pending cleanup", () => {
    const rows = pendingMachines();
    fn(rows);
    saveStore(file, rows, { mode: 0o600 });
  });
}
export function recordPendingMachine(id, account) {
  if (!ID.test(id) || (account != null && !HASH.test(account))) fail();
  change((rows) => {
    if (!rows.some((r) => account == null ? r === id : r?.id === id && r.account === account)) rows.push(account == null ? id : { id, account });
  });
}
export function clearPendingMachines(done) {
  change((rows) => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (typeof r !== "string" && done.some((d) => d.id === r.id && d.account === r.account)) rows.splice(i, 1);
    }
  });
}
