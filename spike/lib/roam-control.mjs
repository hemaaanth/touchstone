const token = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const agentId = (value) => typeof value === "string" && /^a-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const failure = (code) => new Error(code);
const ops = new Set(["pause", "resume", "cancel", "status"]);

// emit takes one ack object. Adapt event(name, data) with ({ ev, ...data }) => event(ev, data).
// isAgent is a synchronous trusted board predicate; stdin never registers an agent.
// remote.pause must quiesce browser AND shell processes, not just finish an exec request.
// remote.close must fence in-flight remote operations. Disposing cannot stop their promises.
// run returns fn's result; control methods return { state, lease } or reject fixed ROAM_* errors.
// Completed leases never pause again. Failed operations are not retried by duplicate requests.
// handle returns a consumed boolean. APP must match id/epoch/agent/op/lease AND paused state.
// Call handle without blocking stdin; keep ask waits outside run. dispose is local-only cleanup.
export function createRoamControl({ epoch, remote, emit, isAgent = () => false }) {
  if (!token(epoch) || !remote || !["pause", "resume", "close"].every((op) => typeof remote[op] === "function")
      || typeof emit !== "function" || typeof isAgent !== "function") throw failure("ROAM_CONFIG");
  const agents = new Map();
  const requests = new Map();
  const pending = new Set();
  let disposed = false;

  function waiter() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const item = { promise, finish(error, value) {
      if (!pending.delete(item)) return;
      if (error) reject(failure(error)); else resolve(value);
    } };
    pending.add(item);
    return item;
  }

  function get(agent) {
    if (disposed) throw failure("ROAM_DISPOSED");
    let trusted = false;
    try { trusted = agentId(agent) && isAgent(agent) === true; } catch { /* deny */ }
    if (!trusted) throw failure("ROAM_AGENT");
    if (!agents.has(agent)) agents.set(agent, {
      state: "running", lease: null, retired: new Set(), queue: [], active: null, operation: null,
    });
    return agents.get(agent);
  }

  const view = (slot) => ({ state: slot.state, lease: slot.lease });
  const blocked = (slot) => slot.state === "closed" ? "ROAM_CLOSED" : "ROAM_PAUSED";
  function rejectQueue(slot, error = blocked(slot)) {
    for (const work of slot.queue.splice(0)) work.finish(error);
  }

  function pump(slot) {
    if (slot.active || slot.state !== "running" || disposed) return;
    const work = slot.queue.shift();
    if (!work) return;
    // Trusted membership may change while this action waits behind another one.
    try { get(work.agent); }
    catch {
      work.finish("ROAM_AGENT");
      rejectQueue(slot, "ROAM_AGENT");
      return;
    }
    let drained;
    const done = new Promise((resolve) => { drained = resolve; });
    slot.active = { work, done };
    let result;
    try { result = work.fn(); } catch { result = Promise.reject(failure("ROAM_RUN_FAILED")); }
    Promise.resolve(result).then(
      (value) => work.finish(null, value),
      () => work.finish("ROAM_RUN_FAILED"),
    ).finally(() => {
      slot.active = null;
      drained();
      pump(slot);
    });
  }

  function run(agent, fn) {
    try {
      const slot = get(agent);
      if (typeof fn !== "function") throw failure("ROAM_RUN_INVALID");
      if (slot.state !== "running") throw failure(blocked(slot));
      const work = waiter();
      work.agent = agent;
      work.fn = fn;
      slot.queue.push(work);
      pump(slot);
      return work.promise;
    } catch (error) { return Promise.reject(error); }
  }

  function checkLease(lease) {
    if (!token(lease)) throw failure("ROAM_LEASE_INVALID");
  }

  function operation(slot, op, action) {
    const work = waiter();
    slot.operation = { op, work };
    // All continuations check the closed latch before changing state or calling remote.
    Promise.resolve().then(action).then(
      () => work.finish(null, view(slot)),
      () => work.finish(disposed ? "ROAM_DISPOSED" : slot.state === "closed" && op !== "cancel"
        ? "ROAM_CLOSED" : `ROAM_${op.toUpperCase()}_FAILED`),
    );
    return work.promise;
  }

  function pause(agent, lease) {
    try {
      const slot = get(agent);
      checkLease(lease);
      if (slot.state === "closed") throw failure("ROAM_CLOSED");
      if (slot.lease === lease) {
        if (slot.operation?.op === "pause") return slot.operation.work.promise;
        if (slot.state === "running" || slot.state === "paused") return Promise.resolve(view(slot));
        throw failure("ROAM_BUSY");
      }
      if (slot.state !== "running") throw failure("ROAM_LEASE_MISMATCH");
      if (slot.retired.has(lease)) throw failure("ROAM_LEASE_STALE");
      slot.lease = lease;
      slot.state = "pausing";
      rejectQueue(slot);
      const drain = slot.active?.done;
      return operation(slot, "pause", async () => {
        if (drain) await drain;
        if (disposed || slot.state === "closed") throw failure("ROAM_CLOSED");
        try { await remote.pause(agent); }
        catch { if (slot.state !== "closed") slot.state = "failed"; throw failure("ROAM_PAUSE_FAILED"); }
        if (disposed || slot.state === "closed") throw failure("ROAM_CLOSED");
        slot.state = "paused";
      });
    } catch (error) { return Promise.reject(error); }
  }

  function resume(agent, lease) {
    try {
      const slot = get(agent);
      checkLease(lease);
      if (slot.state === "closed") throw failure("ROAM_CLOSED");
      if (slot.lease !== lease) throw failure("ROAM_LEASE_MISMATCH");
      if (slot.operation?.op === "resume") return slot.operation.work.promise;
      if (slot.state !== "paused") throw failure("ROAM_NOT_PAUSED");
      slot.state = "resuming";
      return operation(slot, "resume", async () => {
        if (disposed || slot.state === "closed") throw failure("ROAM_CLOSED");
        try { await remote.resume(agent); }
        catch { if (slot.state !== "closed") slot.state = "paused"; throw failure("ROAM_RESUME_FAILED"); }
        if (disposed || slot.state === "closed") throw failure("ROAM_CLOSED");
        slot.retired.add(lease);
        slot.state = "running";
      });
    } catch (error) { return Promise.reject(error); }
  }

  function cancel(agent, lease) {
    try {
      const slot = get(agent);
      checkLease(lease);
      if (slot.lease !== null && slot.lease !== lease) throw failure("ROAM_LEASE_MISMATCH");
      if (slot.state === "closed") return slot.operation.work.promise;
      slot.lease = lease;
      slot.state = "closed";
      rejectQueue(slot);
      slot.active?.work.finish("ROAM_CLOSED");
      slot.operation?.work.finish("ROAM_CLOSED");
      return operation(slot, "cancel", async () => { await remote.close(agent); });
    } catch (error) { return Promise.reject(error); }
  }

  async function handle(line) {
    let parsed = line;
    if (typeof line === "string") {
      try { parsed = JSON.parse(line); } catch { return false; }
    }
    if (!parsed || typeof parsed !== "object" || !Object.hasOwn(parsed, "roamControl")) return false;
    const request = parsed.roamControl;
    // No correlation means no safe reply. The tagged line is still consumed.
    if (!request || typeof request !== "object" || !token(request.id)) return true;
    const { id } = request;
    const agent = agentId(request.agent) ? request.agent : null;
    const op = ops.has(request.op) ? request.op : null;
    const lease = token(request.lease) ? request.lease : null;
    let error, state = "unknown";
    try {
      if (!agent || !op || !token(request.epoch) || (op !== "status" && !lease)) throw failure("ROAM_REQUEST");
      if (request.epoch !== epoch) throw failure("ROAM_EPOCH");
      const slot = get(agent);
      state = slot.state;
      const identity = JSON.stringify([agent, op, lease]);
      if (requests.has(id) && requests.get(id) !== identity) throw failure("ROAM_ID_REUSED");
      requests.set(id, identity);
      if (op !== "status") await ({ pause, resume, cancel })[op](agent, lease);
      if (disposed) throw failure("ROAM_DISPOSED");
      state = slot.state;
    } catch (caught) {
      // All errors from the gate are fixed codes. Remote and predicate errors never reach here.
      error = caught.message;
      state = disposed ? "closed" : agents.get(agent)?.state ?? state;
    }
    emit({ ev: "roam-control", id, epoch, agent, op, lease, ok: !error, state, ...(error ? { error } : {}) });
    return true;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const slot of agents.values()) { slot.state = "closed"; slot.queue.length = 0; }
    for (const work of pending) work.finish("ROAM_DISPOSED");
  }

  return { run, pause, resume, cancel, handle, dispose };
}
