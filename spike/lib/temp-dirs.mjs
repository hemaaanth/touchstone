// Temp folders that must not outlive a killed process.
//
// A lab or tool run makes a temp folder (a lab copy, a workspace, a config tree)
// and removes it when it stops. A SIGINT/SIGTERM (a test runner's kill on
// timeout) skips that. lib/lab-net.mjs removes the lab network and its
// containers on those signals; this removes the folders tracked here, on the
// signals and on 'exit' (a crash).
//
// The process still dies by the signal. lab-net re-raises it only when its own
// handler is the only listener; this handler re-raises it when it runs last
// with no listener left. In either order exactly one of the two raises it.
//
// Because it deletes, it tracks only a real directory (not a link) that is a
// direct child of the real temp folder (realpath of os.tmpdir()), as mkdtempSync
// makes them. Anything else throws and is not tracked.
import { lstatSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";

// The path a caller tracked -> its real path, which is what a signal removes.
const dirs = new Map();
const SIGNALS = ["SIGINT", "SIGTERM"];

function removeAll() {
  for (const real of dirs.values()) { try { rmSync(real, { recursive: true, force: true }); } catch { /* best effort */ } }
  dirs.clear();
}
function off() {
  for (const s of SIGNALS) process.removeListener(s, onSignal);
  process.removeListener("exit", removeAll);
}
function onSignal(sig) {
  removeAll();
  off();
  if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
}

// Remove dir on SIGINT/SIGTERM/exit until untrackTempDir(dir). dir must be a real
// directory directly inside the real temp folder; anything else throws.
export function trackTempDir(dir) {
  let real = null;
  try { if (lstatSync(dir).isDirectory()) real = realpathSync(dir); } catch { /* checked below */ }
  if (!real || dirname(real) !== realpathSync(tmpdir())) {
    throw new Error(`trackTempDir: ${String(dir).slice(0, 200)} is not a real directory directly inside the temp folder ${tmpdir()}, so it is not tracked.`);
  }
  if (dirs.size === 0) { for (const s of SIGNALS) process.on(s, onSignal); process.on("exit", removeAll); }
  dirs.set(dir, real);
  return dir;
}
export function untrackTempDir(dir) {
  if (!dirs.delete(dir) || dirs.size) return;
  off();
}
// Remove a tracked folder now.
export function removeTempDir(dir) {
  rmSync(dir, { recursive: true, force: true });
  untrackTempDir(dir);
}
export const trackedTempDirs = () => [...dirs.keys()];
