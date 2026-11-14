// Bounded provider calls for shell setup and creation. Provider bodies and
// original errors stay private; callers receive fixed codes and sentences.
import { createHash } from "node:crypto";

const LIMIT = 256 * 1024;
const PAGE_LIMIT = 20;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const STATES = new Set(["building", "pending", "pulling", "snapshotting", "active", "inactive", "error", "build_failed", "removing"]);

const MESSAGES = {
  daytona_sandbox_start_failed: "The disposable Daytona machine did not become ready. Its cleanup remains tracked.",
  daytona_shell_prerequisites_failed: "The snapshot did not pass the Linux, root, Node.js and shell prerequisites. Choose another snapshot or create the Touchstone shell snapshot.",
  daytona_shell_egress_start_failed: "The shell snapshot could not start the request logger. Choose another snapshot or create the Touchstone shell snapshot.",
  daytona_shell_egress_http_failed: "The shell snapshot did not pass its loopback HTTP test.",
  daytona_shell_egress_record_failed: "The shell request logger did not record the loopback test.",
  daytona_shell_supervisor_failed: "The shell supervisor did not confirm run, pause, resume and close.",
  daytona_unconfigured: "Configure the Daytona server and API key in Settings.",
  daytona_unreachable: "Daytona did not confirm the request. Do not repeat resource creation until its outcome is checked.",
  daytona_rejected: "Daytona refused the request. Check the account configuration in Settings.",
  daytona_snapshot_unavailable: "The selected Daytona snapshot is unavailable in the selected region. Check shell setup in Settings.",
  daytona_region_unavailable: "The selected Daytona region is not available to this account. Choose an available region in Settings.",
  daytona_shell_unverified: "Verify a free-roam snapshot in Daytona Settings before enabling free-roam agents.",
  daytona_cleanup_pending: "The test machine still needs cleanup. Confirm cleanup before starting another test.",
  daytona_response_invalid: "Daytona returned an incomplete or unsupported response. Shell setup is not verified.",
};
export function daytonaError(code, status) {
  return Object.assign(new Error(MESSAGES[code] || MESSAGES.daytona_response_invalid), { code, ...(status ? { status } : {}) });
}
const invalid = () => { throw daytonaError("daytona_response_invalid"); };
const id = (value) => typeof value === "string" && ID.test(value);
const text = (value) => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);

async function jsonBody(response, empty = false) {
  if (!response.body || Number(response.headers.get("content-length")) > LIMIT) {
    await response.body?.cancel();
    invalid();
  }
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMIT) { await reader.cancel(); invalid(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!size && empty) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { invalid(); }
}

function snapshot(value) {
  if (!value || !id(value.id) || !text(value.name) || !STATES.has(value.state)) invalid();
  if (value.regionIds != null && (!Array.isArray(value.regionIds) || value.regionIds.length > 200 || value.regionIds.some((r) => !id(r)))) invalid();
  return {
    id: value.id, name: value.name, state: value.state,
    regionIds: value.regionIds ?? [],
    sandboxClass: value.sandboxClass === "container" ? "container" : null,
    metadataHash: createHash("sha256").update(JSON.stringify([value.id, value.imageName ?? null, value.ref ?? null, value.sandboxClass ?? null, value.cpu ?? null, value.mem ?? null, value.disk ?? null])).digest("hex"),
    // Missing class/region metadata is not evidence that a snapshot is suitable.
  };
}

export function daytonaShellApi(config, { fetch: transport = globalThis.fetch } = {}) {
  let base;
  try {
    base = new URL(config.apiUrl);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || !config.apiKey) throw new Error();
  } catch { throw daytonaError("daytona_unconfigured"); }
  const api = base.href.replace(/\/$/, "");
  const key = config.apiKey;
  async function call(method, path, body, { timeout = 15_000, selectedSnapshot, baseUrl = api, empty = false } = {}) {
    let response;
    try {
      response = await transport(`${baseUrl}${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(timeout),
        headers: { Authorization: `Bearer ${key}`, ...(body === undefined || body instanceof FormData ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
      });
    } catch { throw daytonaError("daytona_unreachable"); }
    if (!response.ok) {
      // Only this exact provider rejection invalidates the shared selection.
      // A generic 400, quota error or timeout does not prove it unavailable.
      let detail;
      try { detail = await jsonBody(response); } catch { /* fixed error below */ }
      if (response.status === 400 && selectedSnapshot && typeof detail?.message === "string" &&
          detail.message === `Snapshot ${selectedSnapshot} is not available in region ${config.target}`) {
        throw daytonaError("daytona_snapshot_unavailable", response.status);
      }
      throw daytonaError(response.status >= 500 || response.status === 408 ? "daytona_unreachable" : "daytona_rejected", response.status);
    }
    if (response.status === 204) return null;
    try { return await jsonBody(response, empty); } catch { throw daytonaError("daytona_response_invalid"); }
  }
  return {
    async regions() {
      const rows = await call("GET", "/regions");
      if (!Array.isArray(rows) || rows.length > 200) invalid();
      return rows.map((r) => {
        if (!id(r?.id) || !text(r?.name)) invalid();
        return { id: r.id, name: r.name };
      });
    },
    async snapshots() {
      const all = [];
      for (let page = 1; page <= PAGE_LIMIT; page++) {
        const result = await call("GET", `/snapshots?page=${page}&limit=100`);
        if (page === 1 && result?.total === 0 && result?.totalPages === 0 && Array.isArray(result.items) && result.items.length === 0) return [];
        if (!result || !Array.isArray(result.items) || result.items.length > 100 || !Number.isSafeInteger(result.totalPages) || result.totalPages < 1 || result.totalPages > PAGE_LIMIT || result.page !== page) invalid();
        all.push(...result.items.map(snapshot));
        if (page === result.totalPages) return all;
      }
      invalid();
    },
    async snapshot(snapshotId) {
      if (!id(snapshotId)) invalid();
      return snapshot(await call("GET", `/snapshots/${encodeURIComponent(snapshotId)}`));
    },
    removeSnapshot: (snapshotId) => {
      if (!id(snapshotId)) invalid();
      return call("DELETE", `/snapshots/${encodeURIComponent(snapshotId)}`, undefined, { empty: true });
    },
    createSnapshot: (body) => call("POST", "/snapshots", body, { timeout: 300_000 }),
    createSandbox: (labels, snapshotId, { stopMin = 60, deleteMin = 240, ttlMinutes } = {}) => call("POST", "/sandbox", {
      snapshot: snapshotId, target: config.target, user: "root", labels,
      autoStopInterval: stopMin, autoDeleteInterval: deleteMin,
      ...(ttlMinutes == null ? {} : { ttlMinutes }),
    }, { timeout: 300_000, selectedSnapshot: snapshotId }),
    async sandboxes(labels) {
      const all = [];
      const seen = new Set();
      let cursor = "";
      for (let page = 0; page < PAGE_LIMIT; page++) {
        const result = await call("GET", `/sandbox?labels=${encodeURIComponent(JSON.stringify(labels))}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        if (!result || !Array.isArray(result.items) || result.items.length > 200) invalid();
        all.push(...result.items);
        if (!result.nextCursor) return all;
        if (!text(result.nextCursor) || seen.has(result.nextCursor)) invalid();
        cursor = result.nextCursor; seen.add(cursor);
      }
      invalid();
    },
    removeSandbox: (sandboxId) => {
      if (!id(sandboxId)) invalid();
      return call("DELETE", `/sandbox/${encodeURIComponent(sandboxId)}`, undefined, { empty: true });
    },
    sandbox: (sandboxId) => {
      if (!id(sandboxId)) invalid();
      return call("GET", `/sandbox/${encodeURIComponent(sandboxId)}`);
    },
    machine(sandbox) {
      if (!id(sandbox?.id) || typeof sandbox.toolboxProxyUrl !== "string" || sandbox.toolboxProxyUrl.length > 2048) invalid();
      let toolbox;
      try {
        toolbox = new URL(sandbox.toolboxProxyUrl);
        if (toolbox.protocol !== "https:" || toolbox.username || toolbox.password || toolbox.search || toolbox.hash) invalid();
      } catch { invalid(); }
      const baseUrl = `${toolbox.href.replace(/\/$/, "")}/${encodeURIComponent(sandbox.id)}`;
      return {
        id: sandbox.id, fresh: true,
        exec: (command, seconds) => call("POST", "/process/execute", { command, timeout: seconds }, { baseUrl, timeout: (seconds + 15) * 1000 }),
        upload: (path, bytes) => {
          const form = new FormData();
          form.append("file", new Blob([bytes]), "file");
          return call("POST", `/files/upload-v2?path=${encodeURIComponent(path)}`, form, { baseUrl, empty: true });
        },
      };
    },
  };
}

// DELETE can mean accepted, not gone. A 404 from the resource read is the
// confirmation. An unresolved delete keeps its cleanup obligation.
export async function confirmDaytonaDeletion(read, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let i = 0; i < 10; i++) {
    try { await read(); }
    catch (error) { if (error.status === 404) return; throw error; }
    if (i < 9) await sleep(1000);
  }
  throw daytonaError("daytona_cleanup_pending");
}
