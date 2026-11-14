import { pendingMachines } from "./daytona-pending.mjs";
import { probeDaytonaShell } from "./daytona-probe.mjs";
import { daytonaError, daytonaShellApi, confirmDaytonaDeletion } from "./daytona-api.mjs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { allRoamOperations, beginRoamOperation, roamAccountBinding, roamBinding, roamOperations, roamSelectionState, setRoamSelectionState, updateRoamOperation } from "./daytona-state.mjs";

export const SHELL_PROBE_VERSION = "managed-shell-1";
const drivers = new Map();
const hash = (text) => createHash("sha256").update(text).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeStatus = (error) => Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? { errorStatus: error.status } : {};
const terminal = (op) => ["complete", "rejected"].includes(op.phase);
const safeCode = (error) => typeof error?.code === "string" && error.code.startsWith("daytona_") ? error.code : "daytona_response_invalid";
const operation = (id) => allRoamOperations().find((op) => op.id === id);
const requestIdValid = (id) => typeof id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
function move(id, phase, resourceId, details) {
  const op = operation(id);
  if (!op) throw daytonaError("daytona_response_invalid");
  return updateRoamOperation(op.binding, id, op.phase, phase, resourceId, details);
}

function drive(op, fn) {
  const promise = fn().catch(() => {}).finally(() => drivers.delete(op.id));
  drivers.set(op.id, promise);
}

// This reads local state only. Opening Settings must never provision or query
// an account, nor erase an unresolved operation after a configuration change.
export function roamSetupStatus(config) {
  try {
    const binding = roamBinding(config);
    const selected = roamSelectionState(binding);
    const pending = roamOperations(binding).filter((op) => op.action !== "runtime" && !["complete", "rejected"].includes(op.phase));
    if (pending.length) return { state: pending.some((op) => op.phase === "unknown" || !drivers.has(op.id)) ? "unknown" : "pending", ready: false };
    if (!config.apiKey || !config.roamSnapshot) return { state: "not_configured", ready: false };
    if (selected?.state === "unavailable") return { state: "unavailable", ready: false };
    if (selected?.state === "rejected") return { state: "rejected", ready: false };
    if (selected?.state === "verified" && selected.probeVersion === SHELL_PROBE_VERSION) return { state: "ready", ready: true };
    return { state: selected?.state === "checked" ? "needs_test" : "not_checked", ready: false };
  } catch { return { state: "state_error", ready: false }; }
}

export function roamSetupView(config) {
  const status = roamSetupStatus(config);
  if (status.state === "state_error") return status;
  try {
    const binding = roamBinding(config);
    const operations = roamOperations(binding).filter((op) => op.action !== "runtime");
    const latest = operations.at(-1);
    return {
      ...status,
      operation: latest ? {
        id: latest.id, action: latest.action, phase: latest.phase,
        probePassed: latest.probePassed === true,
        errorCode: latest.errorCode ?? null,
        errorStatus: latest.errorStatus ?? null,
        ...(latest.action === "snapshot" ? { snapshotId: latest.resourceId ?? null, snapshotName: latest.snapshotName ?? null } : {}),
        canReconcile: !terminal(latest) && !drivers.has(latest.id),
      } : null,
      legacyPending: pendingMachines().filter((r) => typeof r === "string").length,
      previousPending: allRoamOperations().filter((op) => op.binding !== binding && !terminal(op)).length,
    };
  } catch { return { state: "state_error", ready: false }; }
}

function regionOf(regions, target) {
  const matches = regions.filter((r) => r.name === target);
  if (matches.length !== 1) throw daytonaError("daytona_region_unavailable");
  return matches[0];
}

export async function discoverRoamSnapshots(config, dependencies) {
  const api = daytonaShellApi(config, dependencies);
  const regions = await api.regions();
  const snapshots = await api.snapshots();
  const region = regions.find((r) => r.name === config.target);
  return {
    regions,
    snapshots: snapshots.map((s) => ({
      id: s.id, name: s.name, state: s.state,
      available: Boolean(region && s.state === "active" && s.sandboxClass === "container" && s.regionIds.includes(region.id)),
    })),
  };
}

// Complete metadata checks happen before a create, not after a worker has
// spent money discovering that its selected snapshot cannot be used.
export async function checkRoamSelection(config, dependencies) {
  if (!config.roamSnapshot) throw daytonaError("daytona_shell_unverified");
  const binding = roamBinding(config);
  const api = daytonaShellApi(config, dependencies);
  let region;
  try { region = regionOf(await api.regions(), config.target); }
  catch (error) {
    if (error.code === "daytona_region_unavailable") setRoamSelectionState(binding, "unavailable");
    throw error;
  }
  let snapshot;
  try { snapshot = await api.snapshot(config.roamSnapshot); }
  catch (error) {
    if (error.status === 404) setRoamSelectionState(binding, "unavailable");
    throw error;
  }
  if (snapshot.state !== "active" || snapshot.sandboxClass !== "container" || !snapshot.regionIds.includes(region.id)) {
    setRoamSelectionState(binding, "unavailable");
    throw daytonaError("daytona_snapshot_unavailable");
  }
  const previous = roamSelectionState(binding);
  const matches = previous?.state === "verified" && previous.probeVersion === SHELL_PROBE_VERSION && previous.regionId === region.id && previous.snapshotId === snapshot.id && previous.snapshotRef === snapshot.metadataHash;
  const selected = setRoamSelectionState(binding, matches ? "verified" : "checked", {
    regionId: region.id, snapshotId: snapshot.id, snapshotRef: snapshot.metadataHash,
    ...(matches ? { probeVersion: SHELL_PROBE_VERSION, verificationId: previous.verificationId } : {}),
  });
  return selected;
}

export function requireRoamReady(config) {
  if (config.backend !== "daytona" || !roamSetupStatus(config).ready) throw daytonaError("daytona_shell_unverified");
  return roamSelectionState(roamBinding(config));
}

// Explicit button action. Return the saved operation before running the
// disposable test; a lost browser response cannot launch a second test.
export function startRoamShellTest(config, requestId, dependencies) {
  if (!config.apiKey || !config.roamSnapshot) throw daytonaError("daytona_shell_unverified");
  if (!requestIdValid(requestId)) throw daytonaError("daytona_rejected");
  const api = daytonaShellApi(config, dependencies);
  if (roamOperations(roamBinding(config)).some((op) => op.action === "probe" && !terminal(op))) return roamSetupView(config);
  const { operation: op, created } = beginRoamOperation(config, "probe", hash(`managed-shell-test:${requestId}`), { once: true, exclusive: true });
  if (created) drive(op, () => testShell(config, op, dependencies, api));
  return roamSetupView(config);
}

export function startRoamSnapshotBuild(config, requestId, dependencies) {
  if (!requestIdValid(requestId)) throw daytonaError("daytona_rejected");
  const api = daytonaShellApi(config, dependencies);
  if (roamOperations(roamBinding(config)).some((op) => op.action === "snapshot" && !terminal(op))) return roamSetupView(config);
  const { operation: op, created } = beginRoamOperation(config, "snapshot", hash(`shell-snapshot:${requestId}`), { once: true, exclusive: true });
  if (created) drive(op, () => buildSnapshot(config, op, api));
  return roamSetupView(config);
}

async function buildSnapshot(config, op, api) {
  let posted = false, resourceId;
  try {
    const region = regionOf(await api.regions(), config.target);
    const recipe = readFileSync(new URL("../roam/shell.Dockerfile", import.meta.url), "utf8");
    const recipeHash = hash(recipe);
    const name = `touchstone-shell-${op.nonce.replaceAll("-", "")}`;
    move(op.id, "intent", undefined, { regionId: region.id, recipeHash, snapshotName: name });
    posted = true;
    const snapshot = await api.createSnapshot({
      name, regionId: region.id, sandboxClass: "container", cpu: 2, memory: 4, disk: 10,
      buildInfo: { dockerfileContent: recipe, contextHashes: [] },
    });
    if (!snapshot || typeof snapshot.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(snapshot.id) || snapshot.name !== name) throw daytonaError("daytona_response_invalid");
    resourceId = snapshot.id;
    move(op.id, "created", resourceId);
    // Polling only observes the already-created snapshot. A restart leaves its
    // identity in the journal; the Check build action resumes observation.
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      const current = await api.snapshot(resourceId);
      if (current.name !== name) throw daytonaError("daytona_response_invalid");
      if (current.state === "active") { move(op.id, "complete"); return; }
      if (["error", "build_failed", "removing"].includes(current.state)) throw daytonaError("daytona_snapshot_unavailable");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw daytonaError("daytona_unreachable");
  } catch (error) {
    move(op.id, !posted || error.code === "daytona_rejected" ? "rejected" : "unknown", resourceId, { errorCode: safeCode(error), ...safeStatus(error) });
  }
}

export async function reconcileRoamSnapshot(config, id, dependencies) {
  const op = operation(id);
  if (!op || op.action !== "snapshot" || op.account !== roamAccountBinding(config)) throw daytonaError("daytona_rejected");
  if (terminal(op) || drivers.has(id)) return roamSetupView(config);
  const api = daytonaShellApi(config, dependencies);
  let snapshot;
  if (op.resourceId) {
    try { snapshot = await api.snapshot(op.resourceId); }
    catch (error) {
      if (error.status !== 404) throw error;
      move(id, "complete");
      return roamSetupView(config);
    }
  }
  else {
    const matches = (await api.snapshots()).filter((s) => s.name === op.snapshotName);
    if (matches.length !== 1) return roamSetupView(config);
    snapshot = matches[0];
  }
  if (!op.recipeHash || snapshot.name !== op.snapshotName || !snapshot.regionIds.includes(op.regionId) || snapshot.sandboxClass !== "container") throw daytonaError("daytona_response_invalid");
  if (snapshot.state === "active") move(id, "complete", snapshot.id);
  else if (["error", "build_failed", "removing"].includes(snapshot.state)) {
    move(id, "cleanup", snapshot.id);
    try { await api.removeSnapshot(snapshot.id); }
    catch (error) { if (error.status !== 404) throw error; }
    await confirmDaytonaDeletion(() => api.snapshot(snapshot.id), dependencies);
    move(id, "complete");
  }
  return roamSetupView(config);
}

async function removeTestMachine(api, id, dependencies) {
  try { await api.removeSandbox(id); }
  catch (error) { if (error.status !== 404) throw error; }
  await confirmDaytonaDeletion(() => api.sandbox(id), dependencies);
}

// POST /sandbox accepts the resource before it necessarily starts. Match the
// SDK lifecycle: observe this same ID, then check its toolbox before probing.
// Polling never sends another create.
async function waitForTestMachine(api, accepted, dependencies) {
  const pause = dependencies?.sleep ?? sleep;
  const now = dependencies?.now ?? Date.now;
  const deadline = now() + 60_000;
  const id = accepted.id;
  let toolbox = accepted.toolboxProxyUrl;
  if (toolbox != null) api.machine({ id, toolboxProxyUrl: toolbox }); // validate before retaining
  for (let i = 0; i < 60 && now() < deadline; i++) {
    let sandbox;
    try { sandbox = await api.sandbox(id, { timeoutMs: Math.min(15_000, deadline - now()) }); }
    catch (error) { if (error.status !== 404 && error.code !== "daytona_unreachable") throw error; }
    if (now() >= deadline) break;
    if (sandbox && sandbox.id !== id) throw daytonaError("daytona_response_invalid");
    if (sandbox?.toolboxProxyUrl != null) {
      api.machine(sandbox);
      toolbox = sandbox.toolboxProxyUrl;
    }
    if (sandbox?.state === "started") {
      const machine = api.machine({ ...sandbox, toolboxProxyUrl: toolbox });
      const remaining = deadline - now();
      if (remaining <= 0) break;
      let ready = false;
      try { ready = (await machine.exec("true", 5, { timeoutMs: remaining }))?.exitCode === 0; }
      catch (error) { if (!["daytona_unreachable", "daytona_response_invalid"].includes(error.code) && error.status !== 404) throw error; }
      if (now() >= deadline) break;
      if (ready) return machine;
    } else if (sandbox && !["creating", "starting", "pending", "pending_build", "pulling", "queued"].includes(sandbox.state)) {
      throw daytonaError("daytona_sandbox_start_failed");
    }
    await pause(Math.min(1000, Math.max(0, deadline - now())));
  }
  throw daytonaError("daytona_sandbox_start_failed");
}

async function testShell(config, op, dependencies, api) {
  let selected, sandbox, posted = false, passed = false, errorCode = null, errorStatus = {};
  try {
    selected = await checkRoamSelection(config, dependencies);
    setRoamSelectionState(op.binding, "checked", selected);
    move(op.id, "intent", undefined, { regionId: selected.regionId, snapshotId: selected.snapshotId, snapshotRef: selected.snapshotRef, probeVersion: SHELL_PROBE_VERSION });
    posted = true;
    sandbox = await api.createSandbox({ touchstone: "1", loadout: "shell-setup", nonce: op.nonce, operation: op.id }, selected.snapshotId, { stopMin: 5, deleteMin: 0, ttlMinutes: 10 });
    if (!sandbox || typeof sandbox.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sandbox.id)) throw daytonaError("daytona_response_invalid");
    move(op.id, "created", sandbox.id);
    const machine = await waitForTestMachine(api, sandbox, dependencies);
    await probeDaytonaShell(machine);
    passed = true;
  } catch (error) {
    errorCode = safeCode(error);
    errorStatus = safeStatus(error);
    if (errorCode === "daytona_snapshot_unavailable") setRoamSelectionState(op.binding, "unavailable");
  }
  if (!sandbox?.id || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sandbox.id)) {
    move(op.id, posted && errorCode !== "daytona_rejected" && errorCode !== "daytona_snapshot_unavailable" ? "unknown" : "rejected", undefined, { errorCode: errorCode || "daytona_response_invalid", ...errorStatus });
    return;
  }
  // Record proof and cleanup separately. Readiness requires both.
  move(op.id, "cleanup", sandbox.id, { probePassed: passed, ...errorStatus, ...(errorCode ? { errorCode } : {}) });
  try { await removeTestMachine(api, sandbox.id, dependencies); }
  catch {
    move(op.id, "cleanup", undefined, { errorCode: "daytona_cleanup_pending" });
    return;
  }
  if (passed) {
    try {
      const checked = await checkRoamSelection(config, dependencies);
      if (checked.snapshotId !== selected.snapshotId || checked.regionId !== selected.regionId || checked.snapshotRef !== selected.snapshotRef) throw daytonaError("daytona_shell_unverified");
      setRoamSelectionState(op.binding, "verified", { ...checked, probeVersion: SHELL_PROBE_VERSION, verificationId: op.id });
    } catch {
      // The selection changed during the test. Its current checked/unavailable
      // state remains authoritative; the earlier probe cannot mark it ready.
    }
  }
  move(op.id, "complete");
}

// Explicit read/reconcile action after restart or an uncertain response.
// Empty listings keep the obligation; they never authorize another create.
export async function reconcileRoamShellTest(config, id, dependencies) {
  const op = operation(id);
  if (!op || op.action !== "probe" || op.account !== roamAccountBinding(config)) throw daytonaError("daytona_rejected");
  if (terminal(op) || drivers.has(id)) return roamSetupView(config);
  const api = daytonaShellApi(config, dependencies);
  const labels = { touchstone: "1", loadout: "shell-setup", nonce: op.nonce, operation: op.id };
  let machine;
  if (op.resourceId) {
    try { machine = await api.sandbox(op.resourceId); }
    catch (error) {
      if (error.status !== 404) throw error;
      move(id, "complete");
      return roamSetupView(config);
    }
  } else {
    const matches = (await api.sandboxes(labels)).filter((s) => Object.entries(labels).every(([k, value]) => s?.labels?.[k] === value));
    if (matches.length !== 1) return roamSetupView(config);
    machine = matches[0];
  }
  if (!Object.entries(labels).every(([k, value]) => machine?.labels?.[k] === value)) throw daytonaError("daytona_response_invalid");
  move(id, "cleanup", machine.id);
  await removeTestMachine(api, machine.id, dependencies);
  move(id, "complete");
  // A process restart cannot turn a partially observed probe into a pass.
  // The owner can now start a new, explicitly approved disposable test.
  return roamSetupView(config);
}
