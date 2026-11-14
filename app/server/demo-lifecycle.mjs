import { settleDemoResources } from "../../spike/lib/demo-resources.mjs";

// A work deadline, not a completion deadline. Resource cleanup owns completion;
// late proof results are discarded and capacity stays held until cleanup verifies.
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

export async function stopDemoWorker(run, delayMs = 5000) {
  // The join belongs to the server, not the worker. Leader exit cannot cancel it.
  run.demoCancellation ??= settleDemoResources(run.demoResources, { cancel: true, graceMs: delayMs });
  return run.demoCancellation;
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
