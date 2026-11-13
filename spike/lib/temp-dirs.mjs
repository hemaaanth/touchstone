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
import { rmSync } from "node:fs";

const dirs = new Set();
const SIGNALS = ["SIGINT", "SIGTERM"];

function removeAll() {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
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

// Remove dir on SIGINT/SIGTERM/exit until untrackTempDir(dir).
export function trackTempDir(dir) {
  if (dirs.size === 0) { for (const s of SIGNALS) process.on(s, onSignal); process.on("exit", removeAll); }
  dirs.add(dir);
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
export const trackedTempDirs = () => [...dirs];
