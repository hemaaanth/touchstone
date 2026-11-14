// Paid-operation intent is separate from Settings: a damaged settings write
// must not turn an uncertain provider create into permission to create again.
import { createHash, randomUUID } from "node:crypto";
import { loadStore, saveStore, withStoreLock } from "./grant-store.mjs";
import { providersFile } from "./providers.mjs";

export const daytonaStateFile = () => process.env.TOUCHSTONE_DAYTONA_STATE_FILE || `${providersFile()}.daytona.json`;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SELECTION = new Set(["checked", "verified", "unavailable", "rejected"]);
const PHASES = new Set(["intent", "unknown", "created", "cleanup", "complete", "rejected"]);
const TERMINAL = new Set(["complete", "rejected"]);
const ACTIONS = new Set(["snapshot", "probe", "runtime"]);
const fail = () => { throw Object.assign(new Error("Daytona setup state is unavailable. New resource creation is blocked."), { code: "daytona_state_unavailable" }); };

export function roamBinding(config) {
  return createHash("sha256").update(JSON.stringify([
    config.apiUrl, config.apiKey, config.target, config.roamSnapshot,
  ])).digest("hex");
}

export function roamAccountBinding(config) {
  return createHash("sha256").update(JSON.stringify([config.apiUrl, config.apiKey])).digest("hex");
}

function load(file) {
  const rows = loadStore(file, "Daytona setup state");
  const ids = new Set();
  for (const r of rows) {
    if (!r || r.version !== 1 || !HASH.test(r.binding) || !ID.test(r.id) || ids.has(r.id)) fail();
    ids.add(r.id);
    if (r.kind === "selection") {
      if (!SELECTION.has(r.state) || (r.state === "verified" && (![r.regionId, r.snapshotId, r.probeVersion, r.verificationId].every((v) => typeof v === "string" && ID.test(v)) || !HASH.test(r.snapshotRef)))) fail();
    } else if (r.kind === "operation") {
      if (!ACTIONS.has(r.action) || !PHASES.has(r.phase) || !HASH.test(r.slot) || !ID.test(r.nonce) || !HASH.test(r.account)) fail();
      if (r.run != null && !HASH.test(r.run)) fail();
      for (const key of ["resourceId", "regionId", "snapshotId", "probeVersion", "snapshotName", "errorCode"]) if (r[key] != null && (typeof r[key] !== "string" || !ID.test(r[key]))) fail();
      for (const key of ["snapshotRef", "recipeHash"]) if (r[key] != null && !HASH.test(r[key])) fail();
      if (r.errorStatus != null && (!Number.isInteger(r.errorStatus) || r.errorStatus < 400 || r.errorStatus > 599)) fail();
      if (r.probePassed != null && typeof r.probePassed !== "boolean") fail();
      if (["created", "cleanup"].includes(r.phase) && r.action !== "runtime" && !r.resourceId) fail();
    } else fail();
  }
  return rows;
}

function read() {
  try { return load(daytonaStateFile()); } catch { fail(); }
}

function change(fn) {
  const file = daytonaStateFile();
  try {
    return withStoreLock(file, "Daytona setup state", () => {
      const rows = load(file);
      const value = fn(rows);
      saveStore(file, rows, { mode: 0o600 });
      return value;
    });
  } catch { fail(); }
}

export function roamSelectionState(binding) {
  if (!HASH.test(binding)) fail();
  return read().find((r) => r.kind === "selection" && r.binding === binding) ?? null;
}

// Only explicit discovery/probe operations call this, never a Settings save.
export function setRoamSelectionState(binding, state, details = {}) {
  if (!HASH.test(binding) || !SELECTION.has(state)) fail();
  const selected = {};
  for (const key of ["regionId", "snapshotId", "snapshotRef", "probeVersion", "verificationId", "recipeHash"]) {
    if (details[key] != null) {
      if (typeof details[key] !== "string" || !ID.test(details[key])) fail();
      selected[key] = details[key];
    }
  }
  if (state === "verified" && (!selected.regionId || !selected.snapshotId || !selected.probeVersion || !selected.verificationId || !HASH.test(selected.snapshotRef))) fail();
  return change((rows) => {
    const entry = { version: 1, id: `selection:${binding}`, kind: "selection", binding, state, ...selected, updatedAt: Date.now() };
    const at = rows.findIndex((r) => r.id === entry.id);
    if (at < 0) rows.push(entry); else rows[at] = entry;
    return entry;
  });
}

export function roamOperations(binding) {
  if (!HASH.test(binding)) fail();
  return read().filter((r) => r.kind === "operation" && r.binding === binding);
}

export function allRoamOperations() {
  return read().filter((r) => r.kind === "operation");
}

// Commit this before the provider POST. Only the creator may send the POST;
// an existing intent (including after a restart) requires reconciliation.
export function beginRoamOperation(config, action, slot, { run, once = false, exclusive = false } = {}) {
  const binding = roamBinding(config);
  if (!HASH.test(binding) || !ACTIONS.has(action) || !HASH.test(slot)) fail();
  if (run != null && !HASH.test(run)) fail();
  return change((rows) => {
    const pending = exclusive && rows.find((r) => r.kind === "operation" && r.binding === binding && r.action !== "runtime" && !TERMINAL.has(r.phase));
    if (pending) return { operation: pending, created: false };
    const existing = rows.find((r) => r.kind === "operation" && r.binding === binding && r.action === action && r.slot === slot && (once || !TERMINAL.has(r.phase)));
    if (existing) return { operation: existing, created: false };
    const operation = { version: 1, id: randomUUID(), kind: "operation", binding, account: roamAccountBinding(config), action, slot, nonce: randomUUID(), phase: "intent", ...(run ? { run } : {}), updatedAt: Date.now() };
    rows.push(operation);
    return { operation, created: true };
  });
}

export function updateRoamOperation(binding, id, expectedPhase, phase, resourceId, details = {}) {
  if (!HASH.test(binding) || !ID.test(id) || !PHASES.has(expectedPhase) || !PHASES.has(phase) || (resourceId != null && !ID.test(resourceId))) fail();
  return change((rows) => {
    const operation = rows.find((r) => r.kind === "operation" && r.id === id && r.binding === binding);
    if (!operation || operation.phase !== expectedPhase || TERMINAL.has(operation.phase)) fail();
    operation.phase = phase;
    if (resourceId != null) operation.resourceId = resourceId;
    for (const key of ["regionId", "snapshotId", "snapshotRef", "probeVersion", "recipeHash", "snapshotName", "errorCode"]) {
      if (details[key] != null) {
        if (typeof details[key] !== "string" || !ID.test(details[key])) fail();
        operation[key] = details[key];
      }
    }
    if (details.errorStatus != null) {
      if (!Number.isInteger(details.errorStatus) || details.errorStatus < 400 || details.errorStatus > 599) fail();
      operation.errorStatus = details.errorStatus;
    }
    if (details.probePassed != null) {
      if (typeof details.probePassed !== "boolean") fail();
      operation.probePassed = details.probePassed;
    }
    operation.updatedAt = Date.now();
    return operation;
  });
}
