// A work deadline, not a hard completion deadline. Entered proof calls finish;
// their late results are discarded and the slot stays held through cleanup.
export function demoFence(run, now = Date.now) {
  if (run.ownerHash && now() >= run.deadlineAt) run.stopping = true;
  return Boolean(run.stopping);
}

export function armDemoDeadline(run, requestStop) {
  if (!run.ownerHash) return;
  run.demoClosed = false;
  run.demoTimer = setTimeout(() => requestStop(run.id), Math.max(0, run.deadlineAt - Date.now()));
  run.demoTimer.unref?.();
}

export function stopDemoWorker(run, delayMs = 5000) {
  const child = run.child;
  if (!child || child.exitCode != null || child.signalCode != null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    // Never kill a replacement worker or a reused PID.
    if (run.child === child && child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
  }, delayMs);
  timer.unref?.();
  child.once("exit", () => clearTimeout(timer));
}

export function closeDemoRun(run) {
  clearTimeout(run.demoTimer);
  run.demoClosed = true;
}

export async function demoProve(run, found, prove, now = Date.now) {
  const out = [];
  for (const finding of found) {
    if (demoFence(run, now)) break;
    const result = await prove([finding]);
    if (demoFence(run, now)) break;
    out.push(...(result ?? []));
  }
  return out;
}
