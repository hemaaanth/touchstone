// A process-wide hold on MODEL CALLS, for the operator's browser session.
//
// WHY HERE. A handover means a person is typing. Letting the model fire another
// turn while they log in burns budget and races them. There is no pause
// primitive in the harness, but every model call passes one function
// (lib/provider.mjs budgetedApi), so the gate lives there: a call waits until it
// is resumed.
//
// NESTED ON PURPOSE. A takeover and a handoff can overlap; the depth counter
// keeps one resume from lifting the other. A pause that is never lifted (a
// crashed session) must not hang the run, so a waiter gives up after the cap and
// says so.
import { event } from "./event.mjs";

const CAP_MS = Number(process.env.TOUCHSTONE_PAUSE_CAP_MS || 10 * 60_000);
let depth = 0;
let cutByPause = false;
const waiters = new Set();
const cutters = new Set();

// A call that is already streaming is stopped at the provider, not just held at
// the gate. The wrapper registers one cutter per live call.
export const onCut = (fn) => { cutters.add(fn); return () => cutters.delete(fn); };
// True when the last pause cut a call, so a resume knows to continue the turn.
export const wasCutByPause = () => cutByPause;
export const clearCut = () => { cutByPause = false; };

export const isPaused = () => depth > 0;

export function pause(reason = "operator") {
  depth += 1;
  if (depth > 1) return;
  event("agent-paused", { reason });
  if (cutters.size) {
    cutByPause = true;
    event("agent-pause-cut", { calls: cutters.size });
    for (const cut of cutters) cut();
  }
}

export function resume(reason = "operator") {
  if (depth === 0) return;
  depth -= 1;
  if (depth > 0) return;
  event("agent-resumed", { reason });
  for (const wake of waiters) wake();
  waiters.clear();
}

// Resolves at once when running. Never throws.
export async function waitIfPaused() {
  if (depth === 0) return;
  await new Promise((resolve) => {
    let timer;
    const wake = () => { clearTimeout(timer); waiters.delete(wake); resolve(); };
    waiters.add(wake);
    // Not unref'd: a pending promise alone does not keep the loop alive, and a
    // paused run waiting on a call must not exit under the waiter.
    timer = setTimeout(() => { event("pause-expired", { capMs: CAP_MS }); wake(); }, CAP_MS);
  });
}
